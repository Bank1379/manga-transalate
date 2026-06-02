import io
import asyncio
import logging
from PIL import Image

logger = logging.getLogger("ScanLate-WinOCR")

# Check if winsdk is available
try:
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.graphics.imaging import BitmapDecoder, BitmapPixelFormat, SoftwareBitmap
    from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream
    from winsdk.windows.globalization import Language
    WIN_OCR_AVAILABLE = True
except ImportError:
    WIN_OCR_AVAILABLE = False
    logger.warning("winsdk not installed. Windows Native OCR is disabled.")

async def extract_text_with_win_ocr(image_bytes: bytes, regions: list, source_lang: str) -> list:
    """
    Uses Windows Native OCR to extract text from image regions.
    """
    if not WIN_OCR_AVAILABLE or not regions:
        if not WIN_OCR_AVAILABLE:
            logger.error("WinOCR is requested but winsdk is not installed.")
        return regions
        
    try:
        # Load image via PIL
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        
        # Map source_lang to Windows language tag
        lang_map = {
            "ja": "ja-JP",
            "ko": "ko-KR",
            "zh": "zh-Hans",
            "en": "en-US"
        }
        lang_tag = lang_map.get(source_lang.lower(), "ja-JP")
        language = Language(lang_tag)
        
        # Check if language is supported
        if not OcrEngine.is_language_supported(language):
            logger.warning(f"Windows OCR does not support language: {lang_tag}. Falling back to default engine (en-US or ja-JP).")
            # Usually Windows fallback is safe
            
        # Create OCR Engine
        engine = OcrEngine.try_create_from_language(language)
        if not engine:
            logger.error(f"Could not create Windows OCR engine for {lang_tag}")
            return regions
            
        # OcrEngine is not thread-safe for concurrent recognize_async calls
        ocr_lock = asyncio.Lock()
        
        async def ocr_crop(crop_img):
            try:
                buf = io.BytesIO()
                crop_img.save(buf, format="BMP")
                bmp_bytes = buf.getvalue()
                
                stream = InMemoryRandomAccessStream()
                writer = DataWriter(stream)
                writer.write_bytes(bmp_bytes)
                await writer.store_async()
                await writer.flush_async()
                writer.detach_stream()
                stream.seek(0)
                
                decoder = await BitmapDecoder.create_async(stream)
                software_bitmap = await decoder.get_software_bitmap_async()
                
                # Windows OCR requires BGRA8 format
                if software_bitmap.bitmap_pixel_format != BitmapPixelFormat.BGRA8:
                    software_bitmap = SoftwareBitmap.convert(software_bitmap, BitmapPixelFormat.BGRA8)
                
                async with ocr_lock:
                    result = await engine.recognize_async(software_bitmap)
                
                # Cleanup stream
                stream.close()
                
                # Remove spaces for CJK text
                return result.text.replace(" ", "") if source_lang in ["ja", "zh"] else result.text
            except Exception as e:
                import traceback
                logger.error(f"Failed to OCR a crop (size {crop_img.size}): {e}\n{traceback.format_exc()}")
                return ""

        tasks = []
        for r in regions:
            x1, y1 = max(0, r["minX"]), max(0, r["minY"])
            x2, y2 = min(img.width, r["maxX"]), min(img.height, r["maxY"])
            
            if x2 <= x1 or y2 <= y1:
                logger.warning(f"Invalid bounding box in region: {r}")
                async def empty_result(): return ""
                tasks.append(empty_result())
                continue
                
            crop = img.crop((x1, y1, x2, y2))
            tasks.append(ocr_crop(crop))
            
        results = await asyncio.gather(*tasks)
        
        for i, r in enumerate(regions):
            r["original_text"] = results[i]
            
        logger.info(f"Windows OCR: Successfully extracted {len(results)} texts.")
        return regions
        
    except Exception as e:
        logger.error(f"Windows OCR failed: {e}")
        return regions
