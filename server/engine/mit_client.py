import json
import httpx
import logging
from typing import List, Dict, Any
from server import config

logger = logging.getLogger("ScanLate-EngineClient")

class EngineClient:
    def __init__(self):
        self.url = f"{config.MIT_SERVER_URL}/translate/with-form/json"

    async def get_ocr_regions(self, image_bytes: bytes, source_lang: str, ocr_model: str = None, skip_ocr: bool = False) -> List[Dict[str, Any]]:
        """
        Sends an image to the manga-image-translator server to run OCR and text detection.
        Returns a list of text regions (bounding boxes, original text, colors, angles).
        """
        # Check if source_lang is auto
        is_auto = source_lang.lower() == "auto"

        # Map source_lang (ja, ko, zh, en) to engine expected codes if needed
        # Standard ja -> ja, ko -> ko, en -> en, zh -> ch_tra or ch_sim (default zh)
        lang_map = {
            "ja": "JPN",
            "ko": "KOR",
            "zh": "CHS",
            "en": "ENG",
            "auto": "JPN"  # Fallback target lang for auto mode
        }
        target_engine_lang = lang_map.get(source_lang.lower(), "JPN")

        # Set OCR model (default to 48px if not specified)
        # We cannot use "none" for OCR because manga-image-translator does not support it and will throw HTTP 422.
        ocr_model_name = ocr_model if ocr_model else "48px"

        engine_config = {
            "translator": {
                "translator": "none",
                "target_lang": target_engine_lang.upper(),
                "no_text_lang_skip": True
            },
            "inpainter": {
                "inpainter": "none"
            },
            "render": {
                "renderer": "none"
            },
            "ocr": {
                "ocr": ocr_model_name
            }
        }

        files = {
            "image": ("image.png", image_bytes, "image/png")
        }
        data = {
            "config": json.dumps(engine_config)
        }

        import asyncio

        max_retries = 3
        last_error = None

        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"Sending image to engine for OCR (Lang: {target_engine_lang}, OCR: {ocr_model_name})..." + (f" (attempt {attempt}/{max_retries})" if attempt > 1 else ""))
                async with httpx.AsyncClient(timeout=90.0) as client:
                    response = await client.post(self.url, files=files, data=data)

                    if response.status_code == 500 or response.status_code == 503:
                        last_error = Exception(f"Engine error: {response.text}")
                        logger.warning(f"Engine returned {response.status_code} on attempt {attempt}/{max_retries}. Error: {response.text[:200]}... Retrying in 2s...")
                        await asyncio.sleep(2)
                        continue

                    if response.status_code != 200:
                        logger.error(f"Engine responded with error status {response.status_code}: {response.text}")
                        raise Exception(f"Engine error: {response.text}")

                    result = response.json()
                    logger.info("Successfully fetched OCR results from engine.")

                    # Parse result
                    regions = []
                    translations = result.get("translations", [])

                    for trans in translations:
                        # 'text' is a dictionary mapping language -> text content
                        text_dict = trans.get("text", {})
                        # Retrieve the original text (the key matches the source_lang or is the only element)
                        original_text = ""
                        if text_dict:
                            # Extract the first available language text or match target key
                            original_text = text_dict.get(list(text_dict.keys())[0], "")
                            for l_key, l_val in text_dict.items():
                                if l_key.lower().startswith(source_lang.lower()) or source_lang.lower().startswith(l_key.lower()):
                                    original_text = l_val
                                    break

                        text_color = trans.get("text_color", {})

                        regions.append({
                            "original_text": original_text.strip(),
                            "minX": trans.get("minX"),
                            "minY": trans.get("minY"),
                            "maxX": trans.get("maxX"),
                            "maxY": trans.get("maxY"),
                            "angle": trans.get("angle", 0),
                            "prob": trans.get("prob", 1.0),
                            "text_color": {
                                "fg": text_color.get("fg", [0, 0, 0]),
                                "bg": text_color.get("bg", [255, 255, 255])
                            }
                        })

                    return regions

            except Exception as e:
                last_error = e
                if attempt < max_retries:
                    logger.warning(f"Engine communication failed on attempt {attempt}/{max_retries}: {e}. Retrying in 2s...")
                    await asyncio.sleep(2)
                else:
                    logger.error(f"Failed to communicate with OCR engine after {max_retries} attempts: {e}")
                    raise e

        # All retries exhausted
        logger.error(f"Failed to communicate with OCR engine: {last_error}")
        raise last_error


_client = None

def get_engine_client() -> EngineClient:
    global _client
    if _client is None:
        _client = EngineClient()
    return _client
