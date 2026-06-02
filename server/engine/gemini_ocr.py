import asyncio
import base64
import logging
import json
import re
import os
from io import BytesIO
from PIL import Image
import litellm
from server import config

logger = logging.getLogger(__name__)

# Single semaphore to ensure we don't spam batch requests
ocr_semaphore = asyncio.Semaphore(2)

# Provider -> litellm prefix mapping
_PROVIDER_PREFIX = {
    "openrouter": "openrouter/",
    "gemini": "gemini/",
    "openai": "",
    "ollama": "ollama/"
}

async def extract_text_with_gemini(
    image_bytes: bytes,
    regions: list,
    ocr_provider: str = None,
    ocr_model_slug: str = None,
    ocr_api_key: str = None
) -> list:
    """
    Crops image regions and uses an LLM to read text IN A SINGLE BATCH.
    Accepts explicit OCR provider/model/key separate from the main translation LLM.
    Falls back to the global LLM config if not provided.
    """
    if not regions:
        return regions
        
    try:
        # Resolve which model to call
        if ocr_provider and ocr_model_slug:
            # Use explicit OCR config
            prefix = _PROVIDER_PREFIX.get(ocr_provider, "openrouter/")
            if ocr_model_slug.startswith(prefix):
                model_str = ocr_model_slug
            else:
                model_str = prefix + ocr_model_slug
            api_base = None
            
            # Use explicit OCR key, or fallback to main LLM key
            api_key_to_use = ocr_api_key
            if not api_key_to_use:
                from server.llm.client import get_llm_client
                lc = get_llm_client()
                if ocr_provider == "gemini":
                    api_key_to_use = config.GOOGLE_API_KEY or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
                elif ocr_provider == "openrouter":
                    api_key_to_use = config.OPENROUTER_API_KEY or os.environ.get("OPENROUTER_API_KEY")
                elif ocr_provider == "openai":
                    api_key_to_use = os.environ.get("OPENAI_API_KEY")
        else:
            # Fall back: use global LLM config
            from server.llm.client import get_llm_client
            lc = get_llm_client()
            model_str = lc._resolve_model_string()
            lc._setup_keys()
            api_base = config.OLLAMA_URL if lc.provider == "ollama" else None

        # Grid Packing: Create a single sprite sheet for all crops
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        crops = []
        max_w = 0
        max_h = 0
        
        for r in regions:
            bbox = (r["minX"], r["minY"], r["maxX"], r["maxY"])
            c = img.crop(bbox)
            crops.append(c)
            max_w = max(max_w, c.width)
            max_h = max(max_h, c.height)
            
        import math
        from PIL import ImageDraw
        
        cols = math.ceil(math.sqrt(len(crops)))
        rows = math.ceil(len(crops) / cols) if cols > 0 else 1
        
        padding_top = 24
        cell_w = max_w
        cell_h = max_h + padding_top
        
        grid_img = Image.new("RGB", (cols * cell_w, rows * cell_h), "white")
        draw = ImageDraw.Draw(grid_img)
        
        for i, c in enumerate(crops):
            col = i % cols
            row = i // cols
            x = col * cell_w
            y = row * cell_h
            
            # Draw number box
            draw.rectangle([x, y, x + 40, y + padding_top], fill="red")
            draw.text((x + 4, y + 4), f"#{i}", fill="white")
            
            # Paste crop
            grid_img.paste(c, (x, y + padding_top))
            
        buffered = BytesIO()
        grid_img.save(buffered, format="JPEG", quality=85)
        b64_img = base64.b64encode(buffered.getvalue()).decode("utf-8")
        
        user_content = [
            {
                "type": "text", 
                "text": "This image contains multiple text crops arranged in a grid. Each crop has a red box with a number (e.g., #0, #1) above it. Extract the text for each numbered crop. Return ONLY a JSON array of strings in numerical order. If a crop is blank or contains no text, return an empty string for that index. Do not include markdown wraps."
            },
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}
            }
        ]

        messages = [
            {"role": "system", "content": "You are an expert OCR engine. Output only a valid JSON array of strings."},
            {"role": "user", "content": user_content}
        ]
        
        effective_provider = ocr_provider or (lc.provider if 'lc' in dir() else "openrouter")
        api_base_param = api_base if 'api_base' in dir() else None
        
        async with ocr_semaphore:
            logger.info(f"LLM OCR: Sending {len(regions)} crops in batch using {model_str} (provider: {effective_provider})...")
            
            # Prepare arguments
            completion_kwargs = {
                "model": model_str,
                "messages": messages,
                "temperature": 0.0,
            }
            if api_base_param:
                completion_kwargs["api_base"] = api_base_param
            if 'api_key_to_use' in locals() and api_key_to_use:
                completion_kwargs["api_key"] = api_key_to_use
            elif 'lc' in locals():
                # Fallback to main LLM client api key if we didn't resolve one
                if effective_provider == "gemini":
                    completion_kwargs["api_key"] = config.GOOGLE_API_KEY or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
                elif effective_provider == "openrouter":
                    completion_kwargs["api_key"] = config.OPENROUTER_API_KEY or os.environ.get("OPENROUTER_API_KEY")
                elif effective_provider == "openai":
                    completion_kwargs["api_key"] = os.environ.get("OPENAI_API_KEY")

            if effective_provider in ("gemini", "openai"):
                completion_kwargs["response_format"] = {"type": "json_object"}
            
            response = await litellm.acompletion(**completion_kwargs)
            
            response_text = response.choices[0].message.content.strip()
            extracted_texts = []
            
            # Parse JSON array from response
            match = re.search(r'\[.*\]', response_text, re.DOTALL)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                    if isinstance(parsed, list):
                        extracted_texts = parsed
                except Exception:
                    pass
            
            if not extracted_texts:
                try:
                    parsed = json.loads(response_text)
                    if isinstance(parsed, list):
                        extracted_texts = parsed
                    elif isinstance(parsed, dict):
                        for v in parsed.values():
                            if isinstance(v, list):
                                extracted_texts = v
                                break
                except Exception:
                    pass
            
            if len(extracted_texts) != len(regions):
                logger.warning(f"LLM returned {len(extracted_texts)} texts, expected {len(regions)}")
                # Pad or truncate to match
                while len(extracted_texts) < len(regions):
                    extracted_texts.append("")
                extracted_texts = extracted_texts[:len(regions)]
                
            for i, r in enumerate(regions):
                r["original_text"] = extracted_texts[i]
                
            logger.info(f"LLM OCR: Successfully extracted {len(extracted_texts)} texts using grid packing.")
                
        return regions
    except litellm.RateLimitError:
        logger.error("LLM OCR: Rate limit exceeded. Falling back to original OCR.")
        return regions
    except Exception as e:
        logger.error(f"LLM OCR batch extraction failed: {e}")
        return regions
