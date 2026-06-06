import sys
import os
os.environ["FLAGS_enable_pir_api"] = "0"
import time
import json
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import List, Optional
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request, Depends, Header
from fastapi.responses import StreamingResponse

from fastapi.middleware.cors import CORSMiddleware
import psutil
import httpx

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server import config
from server.engine import paddle_ocr as ocr_engine
from server.engine.paddle_ocr import get_engine_client, start_engine, stop_engine, check_engine_health, get_engine_pid, wait_until_ready
from server.llm import client as llm_client
from server.llm.client import reset_llm_client
from server.profiles import manager as profile_manager
from server.cache import manager as cache_manager

import ipaddress

def is_private_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return ip.is_private or ip.is_loopback
    except ValueError:
        return False

async def verify_access_key(request: Request, x_access_key: str = Header(None)):
    is_local = request.client and is_private_ip(request.client.host)
    forwarded = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip")
    
    # If the request explicitly provides the X-Access-Key header (like the Shared Extension does),
    # ALWAYS validate it, even on localhost. This allows testing the Shared Extension locally.
    if x_access_key is not None:
        if not config.CLIENT_ACCESS_KEYS:
            raise HTTPException(status_code=403, detail="Shared access is disabled (no access keys configured).")
        if x_access_key not in config.CLIENT_ACCESS_KEYS:
            raise HTTPException(status_code=401, detail="Invalid Access Key")
        return
        
    # If NO access key header is provided (Main Extension), allow ONLY if it's a true local/LAN request
    if is_local and not forwarded:
        return
        
    raise HTTPException(status_code=401, detail="Missing Access Key")

async def verify_localhost(request: Request):
    is_local = request.client and is_private_ip(request.client.host)
    forwarded = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip")
    if not is_local or forwarded:
        raise HTTPException(status_code=403, detail="Local/LAN access only")

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ScanLate-API")

# VRAM protection semaphore to process translations sequentially
translation_semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_TRANSLATIONS)
# API protection semaphore to prevent thundering herd rate limits from LLM providers
llm_semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_LLM)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialise PaddleOCR engine (in-process, no subprocess)
    logger.info("Initializing ScanLate v3 Backend Service (PaddleOCR)...")
    success = start_engine()
    if success:
        logger.info("PaddleOCR engine ready.")
        await wait_until_ready(timeout_sec=30)
    else:
        logger.error("Failed to initialise PaddleOCR engine.")
        
    yield
    
    # Shutdown
    logger.info("Shutting down ScanLate v3 Backend Service...")
    stop_engine()
    logger.info("Shutdown complete.")

app = FastAPI(
    title="ScanLate API Gateway",
    version="3.0.0",
    lifespan=lifespan
)

# Enable CORS for Chrome Extension requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_gpu_info():
    gpu_info = {
        "cuda_available": False,
        "device_name": None,
        "vram_total_mb": 0,
        "vram_free_mb": 0,
        "vram_allocated_mb": 0,
        "vram_reserved_mb": 0
    }
    try:
        import torch
        gpu_info["cuda_available"] = torch.cuda.is_available()
        if gpu_info["cuda_available"]:
            gpu_info["device_name"] = torch.cuda.get_device_name(0)
            allocated = torch.cuda.memory_allocated(0)
            reserved = torch.cuda.memory_reserved(0)
            gpu_info["vram_allocated_mb"] = int(allocated / (1024 * 1024))
            gpu_info["vram_reserved_mb"] = int(reserved / (1024 * 1024))
            try:
                free, total = torch.cuda.mem_get_info(0)
                gpu_info["vram_free_mb"] = int(free / (1024 * 1024))
                gpu_info["vram_total_mb"] = int(total / (1024 * 1024))
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"Failed to fetch GPU/Torch memory details: {e}")
    return gpu_info

@app.get("/status", dependencies=[Depends(verify_access_key)])
async def get_status():
    engine_healthy = await check_engine_health()
    engine_pid = get_engine_pid()
    
    cpu_percent = psutil.cpu_percent()
    ram = psutil.virtual_memory()
    gpu = get_gpu_info()
    
    return {
        "status": "online",
        "version": "3.0.0",
        "system": {
            "cpu_usage_percent": cpu_percent,
            "ram_total_gb": round(ram.total / (1024**3), 2),
            "ram_used_gb": round(ram.used / (1024**3), 2),
            "ram_percent": ram.percent
        },
        "gpu": gpu,
        "engine": {
            "running": True,
            "healthy": engine_healthy,
            "pid": engine_pid,
            "port": None,
            "mode": "PaddleOCR"
        }
    }

# ──────────────────────────────────────────────────────────────────────
# TRANSLATION ENDPOINTS
# ──────────────────────────────────────────────────────────────────────

def merge_close_regions(regions: list, max_dist_x=80, max_dist_y=60) -> list:
    """Disabled: paddle_ocr.py already handles smart pairwise clustering."""
    return regions


@app.post("/translate", dependencies=[Depends(verify_access_key)])
async def translate_image(
    image: Optional[UploadFile] = File(None),
    image_url: Optional[str] = Form(None),
    source_lang: str = Form(...),
    profile_name: str = Form(...),
    ocr_model: Optional[str] = Form(None),
    font_name: Optional[str] = Form(None),
    context_json: Optional[str] = Form(None),
    use_multimodal: str = Form("false"),
    use_gemini_ocr: str = Form("false"),
    use_auto_glossary: str = Form("false"),
    dialogue_only: str = Form("false")
):
    """Legacy endpoint: processes image fully and returns all data at once."""
    start_time = time.time()
    
    use_multimodal_bool = str(use_multimodal).lower() == "true"
    use_gemini_ocr_bool = str(use_gemini_ocr).lower() == "true"
    use_auto_glossary_bool = str(use_auto_glossary).lower() == "true"
    dialogue_only_bool = str(dialogue_only).lower() == "true"

    # 1. Read Image Data
    image_bytes = None
    if image:
        image_bytes = await image.read()
        logger.info(f"Received image upload. Size: {len(image_bytes)} bytes. First 20 bytes: {image_bytes[:20]}")
    elif image_url:
        try:
            logger.info(f"Downloading image from URL: {image_url}")
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(image_url)
                if res.status_code == 200:
                    image_bytes = res.content
                else:
                    raise HTTPException(400, detail=f"Failed to fetch image URL: HTTP {res.status_code}")
        except Exception as ex:
            raise HTTPException(400, detail=f"Failed downloading image: {ex}")
            
    if not image_bytes:
        raise HTTPException(400, detail="Missing image upload or image_url")

    # 2. Check Composite Cache
    pm = profile_manager.get_profile_manager()
    cm = cache_manager.get_cache_manager()
    
    p_hash = pm.get_profile_hash(profile_name)
    current_font = font_name if font_name else config.DEFAULT_FONT
    
    cache_key = cm.generate_key(
        image_bytes=image_bytes,
        profile_hash=p_hash,
        font_name=current_font,
        llm_model=config.LLM_MODEL,
        source_lang=source_lang,
        use_multimodal=use_multimodal_bool,
        use_gemini_ocr=use_gemini_ocr_bool
    )
    
    cached_data = cm.get(cache_key)
    if cached_data is not None:
        # Cache HIT: Return immediately
        cached_data["processing_time_ms"] = int((time.time() - start_time) * 1000)
        cached_data["cached"] = True
        return cached_data

    # Parse conversation/page history context
    page_context = ""
    if context_json:
        try:
            history = json.loads(context_json)
            # Flatten text blocks for context
            page_context = "บทความอ้างอิงจากหน้าก่อนหน้า:\n" + "\n".join([str(h) for h in history])
        except Exception:
            pass

    # Acquire semaphore to serialize translation (Cache MISS)
    async with translation_semaphore:
        try:
            mit = get_engine_client()
            skip_ocr_in_mit = (ocr_engine_type in ["llm", "win"])
            regions = await mit.get_ocr_regions(image_bytes, source_lang, ocr_model, skip_ocr=skip_ocr_in_mit, dialogue_only=dialogue_only_bool)
            
            if ocr_engine_type == "llm" and regions:
                from server.engine.gemini_ocr import extract_text_with_gemini
                logger.info("Using LLM OCR for text extraction...")
                regions = merge_close_regions(regions)
                regions = await extract_text_with_gemini(image_bytes, regions)
            elif ocr_engine_type == "win" and regions:
                from server.engine.win_ocr import extract_text_with_win_ocr
                logger.info("Using Windows Native OCR for text extraction...")
                regions = await extract_text_with_win_ocr(image_bytes, regions, source_lang)
            
            if not regions:
                response_data = {
                    "detected_texts": [],
                    "new_terms": [],
                    "cached": False
                }
                cm.set(cache_key, response_data)
                response_data["processing_time_ms"] = int((time.time() - start_time) * 1000)
                return response_data

            # Extract text strings for batch translation
            raw_texts = [r["original_text"] for r in regions]

            # Translate via LiteLLM
            lc = llm_client.get_llm_client()
            translated_texts = await lc.translate_texts(
                texts=raw_texts,
                source_lang=source_lang,
                profile_name=profile_name,
                page_context=page_context,
                image_bytes=image_bytes if use_multimodal_bool else None
            )

            # Apply translations back to regions
            import re
            for i, text in enumerate(translated_texts):
                if text:
                    text = re.sub(r'^[\.…,\-~]*\s*', '', text)
                    text = re.sub(r'\s*[\.…,\-~]*$', '', text)
                regions[i]["translated_text"] = text
                
            if use_auto_glossary_bool and profile_name != "default":
                import asyncio
                asyncio.create_task(
                    lc.extract_and_update_glossary(raw_texts, translated_texts, profile_name)
                )

            merged_results = []
            for i, r in enumerate(regions):
                trans_text = translated_texts[i] if i < len(translated_texts) else r["original_text"]
                merged_results.append({
                    "original": r["original_text"],
                    "translated": trans_text,
                    "bbox": [r["minX"], r["minY"], r["maxX"], r["maxY"]],
                    "text_color": r["text_color"],
                    "angle": r["angle"],
                    "prob": r["prob"]
                })

            response_data = {
                "detected_texts": merged_results,
                "new_terms": [],
                "cached": False
            }
            
            # Save to Cache
            cm.set(cache_key, response_data)
            
            response_data["processing_time_ms"] = int((time.time() - start_time) * 1000)
            return response_data
            
        except Exception as e:
            logger.error(f"Error processing translation: {e}")
            raise HTTPException(500, detail=str(e))


@app.post("/translate/region", dependencies=[Depends(verify_access_key)])
async def translate_region(
    image: UploadFile = File(...),
    bbox: str = Form(...),
    source_lang: str = Form("auto"),
    ocr_provider: Optional[str] = Form(None),
    ocr_model: Optional[str] = Form(None),
    ocr_api_key: Optional[str] = Form(None),
    llm_provider: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    llm_api_key: Optional[str] = Form(None),
):
    import json
    import io
    from PIL import Image
    from server.engine import gemini_ocr, llm_client
    
    try:
        box = json.loads(bbox) # [minX, minY, maxX, maxY]
        image_bytes = await image.read()
        
        # Open image and crop
        img = Image.open(io.BytesIO(image_bytes))
        cropped = img.crop((box[0], box[1], box[2], box[3]))
        
        # Convert cropped image back to bytes for Gemini
        crop_bytes_io = io.BytesIO()
        cropped.save(crop_bytes_io, format="PNG")
        crop_bytes = crop_bytes_io.getvalue()
        
        # Find background color dynamically by sampling edges of the crop
        edge_colors = []
        width, height = cropped.size
        # sample top/bottom
        for x in range(0, width, max(1, width//5)):
            edge_colors.append(cropped.getpixel((x, 0)))
            edge_colors.append(cropped.getpixel((x, height-1)))
        # sample left/right
        for y in range(0, height, max(1, height//5)):
            edge_colors.append(cropped.getpixel((0, y)))
            edge_colors.append(cropped.getpixel((width-1, y)))
            
        def get_luminance(rgb):
            if len(rgb) == 4: # RGBA
                rgb = rgb[:3]
            return 0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2]
            
        edge_colors.sort(key=get_luminance)
        median_rgb = edge_colors[len(edge_colors)//2]
        if len(median_rgb) == 4:
            median_rgb = median_rgb[:3]
        
        lum = get_luminance(median_rgb)
        fg_rgb = (0,0,0) if lum > 130 else (255,255,255)
        
        colors = {
            "bg": f"rgb({median_rgb[0]}, {median_rgb[1]}, {median_rgb[2]})",
            "fg": f"rgb({fg_rgb[0]}, {fg_rgb[1]}, {fg_rgb[2]})"
        }
        
        # Use LLM OCR to read the text
        # Since extract_text_with_gemini takes regions list, we mock it
        mock_regions = [{"bbox": [0,0,width,height], "text": ""}]
        updated_regions = await gemini_ocr.extract_text_with_gemini(
            crop_bytes, 
            mock_regions, 
            llm_client.get_llm_client(),
            ocr_provider=ocr_provider,
            ocr_model=ocr_model,
            ocr_api_key=ocr_api_key
        )
        
        extracted_text = updated_regions[0]["text"]
        
        if not extracted_text:
            return {"translated": "", "colors": colors}
            
        # Translate the text
        lc = llm_client.get_llm_client()
        translated_text = await lc.translate_texts(
            [extracted_text], 
            source_lang,
            provider_override=llm_provider,
            model_override=llm_model,
            api_key_override=llm_api_key
        )
        
        return {
            "translated": translated_text[0],
            "colors": colors
        }
    except Exception as e:
        logger.error(f"Error in translate_region: {e}")
        return JSONResponse(status_code=500, content={"detail": str(e)})


@app.post("/translate/stream", dependencies=[Depends(verify_access_key)])
async def translate_stream(
    image: Optional[UploadFile] = File(None),
    image_url: Optional[str] = Form(None),
    source_lang: str = Form("ja"),
    profile_name: str = Form("default"),
    font_name: Optional[str] = Form(None),
    ocr_model: Optional[str] = Form(None),
    context_json: Optional[str] = Form(None),
    image_index: Optional[int] = Form(None),
    total_images: Optional[int] = Form(None),
    use_multimodal: str = Form("false"),
    use_gemini_ocr: str = Form("false"),
    use_auto_glossary: str = Form("false"),
    dialogue_only: str = Form("false"),
    ocr_provider: Optional[str] = Form(None),
    ocr_model_slug: Optional[str] = Form(None),
    ocr_api_key: Optional[str] = Form(None),
    llm_provider: Optional[str] = Form(None),
    llm_model: Optional[str] = Form(None),
    llm_api_key: Optional[str] = Form(None)
):
    """Streams OCR metadata first, then translated texts block by block using SSE."""
    
    # Hot reload LLM API Key from Extension if provided
    if llm_provider and llm_api_key and llm_model:
        lc = llm_client.get_llm_client()
        # only update if we got a key
        if llm_api_key:
            ollama_url = llm_api_key if llm_provider == "ollama" else ""
            api_key = "" if llm_provider == "ollama" else llm_api_key
            lc.update_config(provider=llm_provider, model=llm_model, api_key=api_key, ollama_url=ollama_url)

    start_time = time.time()
    
    use_multimodal_bool = str(use_multimodal).lower() == "true"
    use_gemini_ocr_bool = str(use_gemini_ocr).lower() == "true"
    use_auto_glossary_bool = str(use_auto_glossary).lower() == "true"
    dialogue_only_bool = str(dialogue_only).lower() == "true"
    
    # Read Image Data
    image_bytes = None
    if image is not None:
        image_bytes = await image.read()
    elif image_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(image_url)
                if res.status_code == 200:
                    image_bytes = res.content
                else:
                    raise HTTPException(400, detail=f"Failed to fetch image URL: HTTP {res.status_code}")
        except Exception as ex:
            raise HTTPException(400, detail=f"Failed downloading image: {ex}")
            
    if not image_bytes:
        raise HTTPException(400, detail="Missing image upload or image_url")

    pm = profile_manager.get_profile_manager()
    cm = cache_manager.get_cache_manager()
    p_hash = pm.get_profile_hash(profile_name)
    current_font = font_name if font_name else config.DEFAULT_FONT
    cache_key = cm.generate_key(
        image_bytes=image_bytes, profile_hash=p_hash, font_name=current_font,
        llm_model=config.LLM_MODEL, source_lang=source_lang,
        use_multimodal=use_multimodal_bool, use_gemini_ocr=use_gemini_ocr_bool
    )

    page_context = ""
    if context_json:
        try:
            history = json.loads(context_json)
            page_context = "บทความอ้างอิงจากหน้าก่อนหน้า:\n" + "\n".join([str(h) for h in history])
        except Exception:
            pass

    async def event_generator():
        # Check Cache first
        cached_data = cm.get(cache_key)
        if cached_data is not None:
            # Send metadata
            yield f"data: {json.dumps({'type': 'metadata', 'regions': cached_data['detected_texts']})}\n\n"
            # Send cached translations as stream
            for i, region in enumerate(cached_data['detected_texts']):
                yield f"data: {json.dumps({'type': 'translation', 'index': i, 'text': region.get('translated_text', '')})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

        img_label = f"รูปที่ {image_index}/{total_images}" if image_index and total_images else "รูป"
        
        try:
            # Only lock the OCR engine to prevent VRAM spikes.
            async with translation_semaphore:
                mit = get_engine_client()
                regions = await mit.get_ocr_regions(image_bytes, source_lang, ocr_model, dialogue_only=dialogue_only_bool)
                
                if use_gemini_ocr_bool and regions:
                    from server.engine.gemini_ocr import extract_text_with_gemini
                    logger.info("Using Gemini for text extraction...")
                    regions = merge_close_regions(regions)
                    regions = await extract_text_with_gemini(
                        image_bytes, regions,
                        ocr_provider=ocr_provider or None,
                        ocr_model_slug=ocr_model_slug or None,
                        ocr_api_key=ocr_api_key or None
                    )
            
            if not regions:
                yield f"data: {json.dumps({'type': 'metadata', 'regions': []})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                # Cache empty
                cm.set(cache_key, {"detected_texts": [], "new_terms": [], "cached": False})
                return

            # Send initial metadata with empty translated strings
            metadata_regions = []
            for r in regions:
                metadata_regions.append({
                    "original": r["original_text"],
                    "translated": "",
                    "bbox": [r["minX"], r["minY"], r["maxX"], r["maxY"]],
                    "text_color": r["text_color"],
                    "angle": r["angle"],
                    "prob": r["prob"]
                })
            yield f"data: {json.dumps({'type': 'metadata', 'regions': metadata_regions})}\n\n"

            # Translate and stream (Semaphore released, OCR is free for the next request)
            raw_texts = [r["original_text"] for r in regions]
            lc = llm_client.get_llm_client()
            
            context_texts = None
            if context_json:
                try:
                    context_texts = json.loads(context_json)
                except Exception:
                    pass

            translated_array = [""] * len(raw_texts)
            
            logger.info(f"เริ่มแปลภาษา (LLM) {img_label} ...")
            has_error = False
            async with llm_semaphore:
                async for partial_json in lc.stream_translate_texts(
                    texts=raw_texts,
                    source_lang=source_lang,
                    profile_name=profile_name,
                    context_texts=context_texts,
                    image_bytes=image_bytes if use_multimodal_bool else None
                ):
                    data_obj = json.loads(partial_json)
                    if "error" in data_obj:
                        has_error = True
                        yield f"data: {json.dumps({'type': 'error', 'message': data_obj['error']})}\n\n"
                        break
                    else:
                        idx = data_obj["index"]
                        text = data_obj["text"]
                        translated_array[idx] = text
                        yield f"data: {json.dumps({'type': 'translation', 'index': idx, 'text': text})}\n\n"

            # Save fully populated regions to cache only if no error occurred
            if not has_error:
                for i, r in enumerate(regions):
                    r["translated_text"] = translated_array[i]

                cm.set(cache_key, {"detected_texts": regions, "new_terms": [], "cached": True})
            
            if use_auto_glossary_bool and profile_name != "default":
                import asyncio
                asyncio.create_task(
                    lc.extract_and_update_glossary(raw_texts, translated_array, profile_name)
                )
            
            logger.info(f"แปล LLM {img_label} เสร็จสมบูรณ์แล้ว!")
            for r_idx, r_text in enumerate(translated_array):
                if r_text:
                    logger.info(f"  [{r_idx+1}] {r_text}")
            logger.info("-" * 40)
            
            yield f"data: {json.dumps({'type': 'done', 'translations': translated_array})}\n\n"
            
        except Exception as e:
            logger.error(f"Error processing translation stream: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    }
    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=headers)

@app.post("/internal/translate_text", dependencies=[Depends(verify_access_key)])
async def translate_text(
    texts: List[str],
    source_lang: str,
    profile_name: Optional[str] = None,
    page_context: Optional[str] = ""
):
    """Loopback API: Translates raw text strings using LLM and context profile."""
    try:
        lc = llm_client.get_llm_client()
        translated = await lc.translate_texts(
            texts=texts,
            source_lang=source_lang,
            profile_name=profile_name,
            page_context=page_context
        )
        return {"translated_texts": translated}
    except Exception as e:
        raise HTTPException(500, detail=str(e))

# ──────────────────────────────────────────────────────────────────────
# PROFILE MANAGEMENT ENDPOINTS
# ──────────────────────────────────────────────────────────────────────

@app.get("/profiles", dependencies=[Depends(verify_access_key)])
async def get_profiles():
    pm = profile_manager.get_profile_manager()
    return {
        "profiles": pm.list_profiles(),
        "auto_profiles": pm.get_auto_profiles()
    }

@app.get("/profiles/{name}", dependencies=[Depends(verify_access_key)])
async def get_profile(name: str):
    pm = profile_manager.get_profile_manager()
    content = pm.get_profile_content(name)
    return {"name": name, "content": content}

@app.put("/profiles/{name}", dependencies=[Depends(verify_access_key)])
async def save_profile(name: str, payload: dict):
    pm = profile_manager.get_profile_manager()
    content = payload.get("content", "")
    
    path = pm.get_profile_path(name)
    if not os.path.exists(path):
        success = pm.create_profile(name, content)
    else:
        success = pm.update_profile(name, content)
        
    if success:
        return {"status": "success"}
    raise HTTPException(500, detail="Failed to save profile")

# ──────────────────────────────────────────────────────────────────────
# SETTINGS ENDPOINTS
# ──────────────────────────────────────────────────────────────────────

@app.get("/settings/llm", dependencies=[Depends(verify_localhost)])
async def get_llm_settings():
    """Return the current active LLM configuration."""
    return {
        "provider": config.LLM_PROVIDER,
        "model":    config.LLM_MODEL,
        "ollama_url": config.OLLAMA_URL,
    }

@app.post("/settings/llm", dependencies=[Depends(verify_localhost)])
async def update_llm_settings(payload: dict):
    """
    Hot-reload LLM provider, model, and API key without restarting the server.
    Payload: { provider, model, api_key, ollama_url? }
    """
    provider   = payload.get("provider", "").strip()
    model      = payload.get("model", "").strip()
    api_key    = payload.get("api_key", "").strip()
    ollama_url = payload.get("ollama_url", "").strip()

    if not provider or not model:
        raise HTTPException(400, detail="provider and model are required")

    valid_providers = {"gemini", "openrouter", "openai", "ollama"}
    if provider not in valid_providers:
        raise HTTPException(400, detail=f"Invalid provider. Must be one of: {valid_providers}")

    try:
        lc = llm_client.get_llm_client()
        lc.update_config(
            provider=provider,
            model=model,
            api_key=api_key,
            ollama_url=ollama_url
        )
        logger.info(f"LLM settings updated via API: provider={provider}, model={model}")
        return {
            "status": "ok",
            "provider": provider,
            "model": model
        }
    except Exception as e:
        logger.error(f"Failed to update LLM settings: {e}")
        raise HTTPException(500, detail=str(e))

@app.get("/settings/access_keys", dependencies=[Depends(verify_localhost)])
async def get_access_keys():
    """Return the list of shared extension access keys."""
    return {"keys": config.CLIENT_ACCESS_KEYS}

@app.post("/settings/access_keys", dependencies=[Depends(verify_localhost)])
async def update_access_keys(payload: dict):
    """
    Update the list of shared extension access keys.
    Payload: { keys: list[str] }
    """
    keys = payload.get("keys")
    if not isinstance(keys, list):
        raise HTTPException(400, detail="keys must be a list of strings")
        
    try:
        config.update_client_access_keys(keys)
        logger.info(f"Shared Access Keys updated via API: {keys}")
        return {"status": "ok", "keys": config.CLIENT_ACCESS_KEYS}
    except Exception as e:
        logger.error(f"Failed to update access keys: {e}")
        raise HTTPException(500, detail=str(e))

@app.post("/cache/clear", dependencies=[Depends(verify_localhost)])
async def clear_cache():
    """Clear the translation cache directory."""
    import shutil
    import os
    cache_dir = config.CACHE_DIR
    try:
        if os.path.exists(cache_dir):
            shutil.rmtree(cache_dir)
        os.makedirs(cache_dir, exist_ok=True)
        logger.info("Translation cache cleared via API.")
        return {"status": "ok", "message": "Cache cleared successfully"}
    except Exception as e:
        logger.error(f"Failed to clear cache: {e}")
        raise HTTPException(500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    logger.info(f"Starting ScanLate Gateway on port {config.SERVER_PORT} (Accepting external connections)...")
    # Change host to 0.0.0.0 to allow connections from other devices on the network
    uvicorn.run("main:app", host="0.0.0.0", port=config.SERVER_PORT, reload=False)
