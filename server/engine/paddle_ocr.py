"""
paddle_ocr.py — PaddleOCR engine client for ScanLate
Replaces manga-image-translator (mit_client / mit_process).

Output format is identical to the old mit_client.get_ocr_regions() so that
main.py / translate endpoints need minimal changes.
"""

import io
import logging
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image

logger = logging.getLogger("ScanLate-PaddleOCR")

# ---------------------------------------------------------------------------
# Language mapping  (source_lang -> PaddleOCR lang code)
# ---------------------------------------------------------------------------
_LANG_MAP: Dict[str, str] = {
    "ja": "japan",
    "ko": "korean",
    "zh": "ch",      # Chinese simplified (use "chinese_cht" for traditional)
    "en": "en",
    "auto": "japan", # fallback
}

# ---------------------------------------------------------------------------
# Singleton wrapper around PaddleOCR
# ---------------------------------------------------------------------------

class PaddleOCRClient:
    """
    Lazy-initialised singleton that keeps one PaddleOCR instance per language
    so models are loaded only once.
    """

    _instances: Dict[str, Any] = {}
    _lock = __import__("threading").Lock()

    @classmethod
    def _get_ocr(cls, lang: str):
        """Return (or create) a PaddleOCR instance for the given language."""
        if lang not in cls._instances:
            try:
                import os
                os.environ["FLAGS_enable_pir_api"] = "0"
                from paddleocr import PaddleOCR  # type: ignore
            except ImportError as exc:
                raise RuntimeError(
                    "PaddleOCR is not installed. "
                    "Run: pip install paddleocr paddlepaddle"
                ) from exc

            logger.info(f"Loading PaddleOCR model for language: {lang}")
            cls._instances[lang] = PaddleOCR(
                use_angle_cls=True,
                lang=lang,
            )
            logger.info(f"PaddleOCR model loaded for language: {lang}")
        return cls._instances[lang]

    # ------------------------------------------------------------------
    # Public API — same signature as mit_client.EngineClient.get_ocr_regions
    # ------------------------------------------------------------------

    async def get_ocr_regions(
        self,
        image_bytes: bytes,
        source_lang: str,
        ocr_model: Optional[str] = None,   # kept for API compatibility, unused
        skip_ocr: bool = False,             # kept for API compatibility, unused
        dialogue_only: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Run PaddleOCR on *image_bytes* and return a list of region dicts that
        are fully compatible with the old mit_client output:

            {
                "original_text": str,
                "minX": int, "minY": int, "maxX": int, "maxY": int,
                "angle":  float,
                "prob":   float,
                "text_color": {"fg": [R, G, B], "bg": [R, G, B]}
            }
        """
        import asyncio

        # PaddleOCR is synchronous – run in executor so we don't block the
        # FastAPI event loop.
        loop = asyncio.get_event_loop()
        regions = await loop.run_in_executor(
            None, self._run_ocr_sync, image_bytes, source_lang, dialogue_only
        )
        return regions

    # ------------------------------------------------------------------
    # Internal sync OCR helper (runs in a thread pool executor)
    # ------------------------------------------------------------------

    def _run_ocr_sync(
        self, image_bytes: bytes, source_lang: str, dialogue_only: bool = False
    ) -> List[Dict[str, Any]]:
        lang = _LANG_MAP.get(source_lang.lower(), "japan")
        ocr = self._get_ocr(lang)

        # Decode image bytes → numpy array (RGB)
        pil_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img_np = np.array(pil_img)

        logger.info(
            f"Running PaddleOCR (lang={lang}) on image "
            f"{img_np.shape[1]}x{img_np.shape[0]} px ..."
        )

        import cv2

        with self._lock:
            result_normal = ocr.ocr(img_np)
            inverted_img_np = cv2.bitwise_not(img_np)
            result_inverted = ocr.ocr(inverted_img_np)

        normal_pages = result_normal if result_normal and result_normal[0] is not None else []
        inverted_pages = result_inverted if result_inverted and result_inverted[0] is not None else []
        
        all_lines_with_flag = []
        for page in normal_pages:
            if page: 
                for line in page:
                    all_lines_with_flag.append((line, False))
                    
        inverted_lines = []
        for page in inverted_pages:
            if page: inverted_lines.extend(page)

        def calculate_iou(box1, box2):
            xs1 = [pt[0] for pt in box1]; ys1 = [pt[1] for pt in box1]
            xs2 = [pt[0] for pt in box2]; ys2 = [pt[1] for pt in box2]
            x1_min, y1_min, x1_max, y1_max = min(xs1), min(ys1), max(xs1), max(ys1)
            x2_min, y2_min, x2_max, y2_max = min(xs2), min(ys2), max(xs2), max(ys2)

            inter_x_min, inter_y_min = max(x1_min, x2_min), max(y1_min, y2_min)
            inter_x_max, inter_y_max = min(x1_max, x2_max), min(y1_max, y2_max)

            if inter_x_min < inter_x_max and inter_y_min < inter_y_max:
                inter_area = (inter_x_max - inter_x_min) * (inter_y_max - inter_y_min)
                box1_area = (x1_max - x1_min) * (y1_max - y1_min)
                box2_area = (x2_max - x2_min) * (y2_max - y2_min)
                return inter_area / float(box1_area + box2_area - inter_area)
            return 0.0

        for inv_line in inverted_lines:
            inv_box, (inv_text, inv_conf) = inv_line
            is_duplicate = False
            for i, (norm_line, is_inv) in enumerate(all_lines_with_flag):
                norm_box, (norm_text, norm_conf) = norm_line
                if calculate_iou(inv_box, norm_box) > 0.4:
                    is_duplicate = True
                    if inv_conf > norm_conf:
                        all_lines_with_flag[i] = (inv_line, True)
                    break
            if not is_duplicate:
                all_lines_with_flag.append((inv_line, True))

        result_lines = all_lines_with_flag if all_lines_with_flag else None

        regions: List[Dict[str, Any]] = []

        if not result_lines or len(result_lines) == 0:
            logger.info("PaddleOCR returned no text regions.")
            return regions

        raw_regions: List[Dict[str, Any]] = []
        for line_tuple in result_lines:
            line, is_inverted = line_tuple
            # line format: [[[x1,y1],[x2,y2],[x3,y3],[x4,y4]], (text, confidence)]
            box, (text, conf) = line
            
            # Skip if text is ONLY punctuation (like '...') or empty
            import re
            text = text.strip()
            # Remove leading and trailing ellipses, periods, or commas
            text = re.sub(r'^[\.…,\-~]*\s*', '', text)
            text = re.sub(r'\s*[\.…,\-~]*$', '', text)
            
            if not text:
                continue
                
            import string
            punct_set = set(string.punctuation + '…“”‘’「」『』【】 \n\r')
            if all(char in punct_set for char in text):
                continue

            # 1. Stricter global noise filter
            if conf < 0.60:
                continue

            xs = [pt[0] for pt in box]
            ys = [pt[1] for pt in box]
            min_x = int(min(xs))
            min_y = int(min(ys))
            max_x = int(max(xs))
            max_y = int(max(ys))
            
            width = max_x - min_x
            height = max_y - min_y
            
            # 2. Filter out extremely small boxes (dots, tiny scribbles)
            if width < 12 or height < 12:
                continue
                
            # 3. Filter out single/double character texts with questionable confidence
            if len(text) <= 2 and conf < 0.85:
                continue

            # Estimate text/background colours from the crop
            fg_color, bg_color = _estimate_colors(img_np, min_x, min_y, max_x, max_y)

            # 4. Dialogue Only Mode Filter
            if dialogue_only:
                # Instead of naive background color filtering which breaks on screentones and dark bubbles,
                # we filter out likely SFX based on text properties.
                # SFX are usually short words (<= 4 chars) and often have lower OCR confidence due to weird fonts
                if len(text) <= 4 and conf < 0.88:
                    continue

            raw_regions.append({
                "original_text": text,
                "minX": min_x,
                "minY": min_y,
                "maxX": max_x,
                "maxY": max_y,
                "angle": 0.0,           # PaddleOCR handles rotation internally
                "prob": float(conf),
                "text_color": {
                    "fg": fg_color,
                    "bg": bg_color,
                },
            })

        # Merge bounding boxes logically
        regions = _merge_regions(raw_regions)

        logger.info(f"PaddleOCR found {len(regions)} grouped text region(s).")
        return regions


# ---------------------------------------------------------------------------
# Region grouping helper
# ---------------------------------------------------------------------------

def _merge_regions(regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group regions that are logically in the same text block or bubble."""
    if not regions:
        return []

    # Helper to calculate distances between two RAW regions A and B
    def are_same_block(a, b):
        a_h = a['maxY'] - a['minY']
        b_h = b['maxY'] - b['minY']
        
        h_overlap = min(a['maxX'], b['maxX']) - max(a['minX'], b['minX'])
        h_gap = -h_overlap
        
        v_overlap = min(a['maxY'], b['maxY']) - max(a['minY'], b['minY'])
        v_gap = -v_overlap
        
        max_height = max(a_h, b_h)
        min_height = min(a_h, b_h)
        if min_height <= 0:
            min_height = 10  # fallback
            
        # Prevent merging huge SFX with small speech text, but allow some emphasis
        if (max_height / min_height) > 3.0:
            return False
            
        def color_diff(c1, c2):
            return sum(abs(c1[i] - c2[i]) for i in range(3))
            
        bg_diff = color_diff(a['text_color']['bg'], b['text_color']['bg'])
        is_same_bg = bg_diff < 45
        
        # Condition 1: Vertically stacked lines
        if is_same_bg:
            # If same background (e.g. inside the same bubble), allow relaxed horizontal overlap
            # This ensures words in the same sentence/bubble don't get split up
            is_vert_stacked = (h_gap <= min_height * 1.2) and (v_gap <= min_height * 0.8)
        else:
            # Strict mode (different backgrounds, e.g. chalkboard vs bubble)
            is_vert_stacked = (h_gap <= min_height * 0.5) and (v_gap <= min_height * 0.5)
        
        # Condition 2: Horizontally adjacent words in the same line
        if is_same_bg:
            is_horiz_adjacent = (v_gap <= min_height * 0.5) and (h_gap <= min_height * 1.0)
        else:
            is_horiz_adjacent = (v_gap <= min_height * 0.2) and (h_gap <= min_height * 0.5)
        
        return is_vert_stacked or is_horiz_adjacent

    # Build connected components (Disjoint Set Union)
    n = len(regions)
    parent = list(range(n))
    
    def find(i):
        if parent[i] == i:
            return i
        parent[i] = find(parent[i])
        return parent[i]
        
    def union(i, j):
        root_i = find(i)
        root_j = find(j)
        if root_i != root_j:
            parent[root_i] = root_j

    for i in range(n):
        for j in range(i + 1, n):
            if are_same_block(regions[i], regions[j]):
                union(i, j)
                
    # Group regions by root
    groups = {}
    for i in range(n):
        root = find(i)
        if root not in groups:
            groups[root] = []
        groups[root].append(regions[i])
        
    # Build final clusters
    clusters = []
    for root, group in groups.items():
        # Sort group by Y, then by X to reconstruct text order
        group = sorted(group, key=lambda r: (r['minY'], r['minX']))
        
        min_x = min(r['minX'] for r in group)
        min_y = min(r['minY'] for r in group)
        max_x = max(r['maxX'] for r in group)
        max_y = max(r['maxY'] for r in group)
        
        text = group[0]['original_text']
        for i in range(1, len(group)):
            prev = group[i-1]
            curr = group[i]
            # If vertical overlap is significant, they are on the same line -> join with space
            v_overlap = min(prev['maxY'], curr['maxY']) - max(prev['minY'], curr['minY'])
            if v_overlap > 0:
                text += ' ' + curr['original_text']
            else:
                text += '\n' + curr['original_text']
                
        # Average colours
        fg = [0, 0, 0]
        bg = [0, 0, 0]
        for r in group:
            fg[0] += r['text_color']['fg'][0]
            fg[1] += r['text_color']['fg'][1]
            fg[2] += r['text_color']['fg'][2]
            bg[0] += r['text_color']['bg'][0]
            bg[1] += r['text_color']['bg'][1]
            bg[2] += r['text_color']['bg'][2]
            
        fg = [int(x / len(group)) for x in fg]
        bg = [int(x / len(group)) for x in bg]
        
        prob = min(r['prob'] for r in group)
        
        clusters.append({
            "original_text": text,
            "minX": min_x,
            "minY": min_y,
            "maxX": max_x,
            "maxY": max_y,
            "angle": 0.0,
            "prob": prob,
            "text_color": {
                "fg": fg,
                "bg": bg,
            }
        })
        
    return clusters


# ---------------------------------------------------------------------------
# Colour estimation helper
# ---------------------------------------------------------------------------

def _estimate_colors(
    img_np: np.ndarray,
    min_x: int,
    min_y: int,
    max_x: int,
    max_y: int
) -> tuple:
    """
    Estimate foreground / background colours by sampling the text crop.
    Returns ([R, G, B], [R, G, B]).
    """
    try:
        h, w = img_np.shape[:2]
        x1 = max(0, min_x)
        y1 = max(0, min_y)
        x2 = min(w, max_x)
        y2 = min(h, max_y)
        crop = img_np[y1:y2, x1:x2]
        if crop.size == 0:
            return [0, 0, 0], [255, 255, 255]

        # Use mean brightness to decide which is fg vs bg
        gray = np.mean(crop, axis=2)  # (H, W)
        flat = gray.flatten()

        # Find threshold
        _min_val = float(np.min(flat))
        _max_val = float(np.max(flat))
        if _max_val - _min_val < 10:
            threshold = _min_val
        else:
            threshold = (_min_val + _max_val) / 2.0
            
        dark_mask = crop[gray < threshold]
        bright_mask = crop[gray >= threshold]

        dark_color = (
            [int(x) for x in dark_mask.mean(axis=0).tolist()]
            if len(dark_mask) > 0
            else [0, 0, 0]
        )
        bright_color = (
            [int(x) for x in bright_mask.mean(axis=0).tolist()]
            if len(bright_mask) > 0
            else [255, 255, 255]
        )
        
        # Text usually takes up less area than background
        if len(dark_mask) <= len(bright_mask):
            # Fewer dark pixels -> dark is text (black text on white bg)
            return dark_color, bright_color
        else:
            # Fewer bright pixels -> bright is text (white text on black bg)
            return bright_color, dark_color
            
    except Exception:
        return [0, 0, 0], [255, 255, 255]


# ---------------------------------------------------------------------------
# Module-level singleton accessor (mirrors mit_client.get_engine_client)
# ---------------------------------------------------------------------------

_client: Optional[PaddleOCRClient] = None


def get_engine_client() -> PaddleOCRClient:
    global _client
    if _client is None:
        _client = PaddleOCRClient()
    return _client


# ---------------------------------------------------------------------------
# No-op stubs so main.py lifespan code compiles without changes
# (PaddleOCR doesn't need a separate subprocess)
# ---------------------------------------------------------------------------

def start_engine() -> bool:
    """No-op — PaddleOCR runs in-process; no subprocess needed."""
    logger.info("PaddleOCR engine: no subprocess needed, ready on first call.")
    return True


async def wait_until_ready(timeout_sec: int = 30) -> bool:
    """No-op — PaddleOCR is always ready after import."""
    return True


def stop_engine() -> None:
    """No-op — nothing to stop."""
    pass


async def check_engine_health() -> bool:
    """PaddleOCR is always healthy if the module loaded."""
    return True


def get_engine_pid() -> Optional[int]:
    """No subprocess → no PID."""
    return None
