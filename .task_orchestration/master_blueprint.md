# Master Blueprint: ScanLate v3

## Global Vision
A real-time Manga/Manhwa/Manhua translator focusing on OCR + AI, without full image replacement or AI inpainting, to drastically reduce VRAM usage (< 1.5GB) and increase speed (< 30s per page).

## Architecture
- **Delivery**: Chrome Extension (Manifest V3) with auto-injected content scripts.
- **Backend API**: ScanLate API (FastAPI, port 8745).
- **Engine**: manga-image-translator running in OCR-only mode (`--mode api --port 8000`, `--translator=none --inpainter=none`).
- **Translation**: Batch translation via LiteLLM (Gemini 2.5 Flash default).
- **Renderer**: Client-side CSS overlays matching detected bounding boxes, with canvas-based bubble background color sampling and binary search auto font sizing.

## Tech Stack
- **Python 3.10.11 Embedded**
- **PyTorch (CUDA 11.8)**
- **FastAPI, Uvicorn, HTTPX**
- **LiteLLM**
- **Chrome Extension APIs** (Manifest V3, Service Workers, `chrome.storage.session`)
