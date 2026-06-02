# ScanLate — Real-time Manga Translation Tool

## Overview

**ScanLate** เป็น tool สำหรับแปล Manga/Manhwa/Manhua บนเว็บแบบ real-time ประกอบด้วย:
- **Chrome Extension** — ตรวจจับรูป manga บนเว็บ แทนที่ด้วยรูปที่แปลแล้ว
- **Python Backend** — FastAPI proxy ที่คุม cache/profile/font/LLM routing แล้วส่งงานภาพให้ manga-image-translator server เป็น engine หลัก
- **manga-image-translator Engine** — รัน pipeline จริง: Text Detection → OCR → Translation hook → Inpainting → Rendering
- **Series Profile System** — เก็บ glossary, ชื่อตัวละคร, สำนวนการแปลต่อเรื่อง เพื่อให้แปลเนียนเหมือน scanlation มืออาชีพ

**Input**: ญี่ปุ่น / เกาหลี / จีน / อังกฤษ → **Output**: ไทย

---

## Decisions Summary (จาก Grilling Session Round 1 + 2 + 3)

| หัวข้อ | ตัดสินใจ |
|---|---|
| Delivery | Chrome Extension (Manifest V3) |
| **Installation** | **One-Click Launcher** (`ScanLate.bat`) — ดับเบิลคลิกไฟล์เดียว จัดการทุกอย่างให้ |
| **Self-contained** | **ทุกอย่างจบใน folder เดียว** — ไม่แตะ C: drive, ไม่เขียน AppData/Registry/PATH |
| Site Detection | Hybrid — universal auto-detect + site adapters |
| Pipeline | Server-side ผ่าน manga-image-translator API, ScanLate เป็น thin proxy |
| OCR | ใช้ OCR/detection ของ manga-image-translator; source lang เลือกใน popup per-tab |
| Translation | Custom translator ใน manga-image-translator → LiteLLM — Gemini 2.5 Flash default |
| Text Rendering | ใช้ renderer/inpainting ของ manga-image-translator + font config จาก ScanLate |
| Hosting | Local-first — **RTX 3060 Ti (8GB VRAM)**, cloud placeholder |
| **Profile Selection** | **บังคับเลือก profile ก่อนแปล** — ห้ามแปลถ้าไม่มี profile |
| **Profile Scope** | **Per-tab** — แต่ละ tab จำ profile แยก (tab A = One Piece, tab B = Naruto) |
| **Source Language** | **แยกจาก profile** — เลือกใน popup, per-tab scope |
| Series Profile | .md files — auto-extract + manual + learn-as-you-go |
| Profile Extraction | **Extension-side only** (V1) — auto-navigate 5 ตอนแรก + 5 ตอนล่าสุด จากเว็บแปลไทย, ~~Playwright scraper~~ ตัดออก V1 |
| Caching | Composite cache key: image + profile_hash + font + LLM model + source_lang → **auto-invalidate only** ไม่มีปุ่ม clear |
| Loading UX | Progressive — แสดงต้นฉบับก่อน, fade-in รูปแปล |
| **Extension UX** | **กดแปลทั้งหน้าจาก popup** + toggle original/translated ใน popup, ~~auto-translate~~ ตัดออก, ~~floating button~~ ตัดออก |
| Extension Framework | Vanilla JS |
| Font | **Global default** — ตั้งใน Settings ทีเดียว, default: Kanit Bold |
| LLM Provider/Model | **Global** — Provider dropdown [Gemini, OpenRouter, Ollama] + Model selector (hardcoded list / free text สำหรับ OpenRouter) |
| **Options Page** | **2 tabs**: Settings (server/API/LLM/font) + Profile Manager |
| GPU | NVIDIA RTX 3060 Ti (8GB VRAM) |
| Primary Scrape Target | slow-manga.com (extensible adapter pattern) |
| **Pre-fetch** | ~~ตัดออก V1~~ — เพิ่มทีหลัง |
| **New Terms** | แสดงใน popup badge + Profile Manager detail section "ศัพท์รออนุมัติ" |

---

## User Flow Summary

### Flow หลัก: แปลมังงะขณะอ่าน

```
User เปิดเว็บ manga raw (เช่น rawkuma.com)
  ↓
กดเปิด Popup → เลือก Profile จาก dropdown (บังคับ)
  ├─ ไม่มี profile → แสดง "ไม่มี profile เรื่องนี้" + ปุ่ม "สร้าง Profile" → พาไป Options > Profile Manager
  └─ มี profile → แสดง state "พร้อมแปล"
  ↓
เลือก Source Language (ja/ko/zh/en) ใน popup
  ↓
กดปุ่ม "แปลทั้งหน้า"
  ↓
Content Script สแกนหารูป manga (width > 600px, เรียงแนวตั้ง)
  ↓
ส่งรูป (image_url หรือ multipart) ไป ScanLate API (port 8745)
  ↓
ScanLate เช็ค cache (composite key: image + profile_hash + font + model + source_lang)
  ├─ Cache HIT → return รูปแปลทันที
  └─ Cache MISS ↓
     ScanLate resolve profile + font + model + source_lang
       ↓
     ส่งงานต่อให้ manga-image-translator (port 8000)
       ↓
     Detection → OCR → Custom Translator (LiteLLM + Profile context) → Inpainting → Render
       ↓
     ได้รูปแปลแล้ว → cache ไว้ → return กลับ
  ↓
Content Script fade-in รูปแปลทับรูปต้นฉบับ
  ↓
User กดปุ่ม toggle ใน popup สลับดูต้นฉบับ/แปลได้
```

### Flow สร้าง Series Profile (Auto-extract)

```
User เปิดหน้า index ของเรื่องบนเว็บแปลไทย (เช่น slow-manga.com/manga/one-piece/)
  ↓
เปิด Options > Profile Manager > กดปุ่ม "สร้าง Profile"
  ↓
ระบบดึงชื่อเรื่องจาก URL slug อัตโนมัติ (e.g. "one-piece" → "One Piece")
  ↓
กดปุ่ม "Extract"
  ↓
Extension เลือก 5 ตอนแรก + 5 ตอนล่าสุดจาก chapter list
  ↓
Auto-navigate: เปิด tab ใหม่ → scroll จน lazy-load ครบ → ดึงรูป → ส่ง server → ปิด tab → วนจนครบ
  (แสดง progress ใน Profile Manager: "กำลังดึงตอนที่ 3/10...")
  ↓
Server OCR รูปทั้งหมด (ภาษาไทย) → ส่ง text เข้า LLM วิเคราะห์
  ↓
LLM สร้าง profile .md (ชื่อตัวละคร, glossary, กฎการแปล, SFX patterns)
  ↓
แสดง rendered .md ให้ user review
  ↓
User แก้ไข (กด Edit → textarea raw markdown → Save/Cancel) + บันทึก
```

### Flow Learn-as-you-go

```
แปลหน้าหนึ่ง → LLM เจอชื่อ/ศัพท์ที่ไม่มีใน profile ที่เลือกอยู่
  ↓
Server return new_terms[] ใน response
  ↓
Service worker เก็บ pending terms per tab
  ↓
User เปิด popup → เห็น badge "ศัพท์ใหม่ 3 คำ" + Approve/Reject ทีละคำ
  ↓
Approve → PUT /profiles/{name} เพิ่ม term เข้า profile
  ↓
(ดูรายละเอียดได้ใน Options > Profile Manager > Detail > section "ศัพท์รออนุมัติ")
```

---

## Proposed Changes

### Component 0: One-Click Launcher (Self-contained)

> [!IMPORTANT]
> **กฎเหล็ก: ห้ามแตะ C: drive**
> - ❌ ไม่ลง Python ลง system
> - ❌ ไม่เขียน `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%/.cache`, `%TEMP%`
> - ❌ ไม่แก้ PATH, Registry, Environment Variables ของ system
> - ✅ ทุกอย่างอยู่ใน folder ที่ user วาง ScanLate ไว้
> - ✅ ย้าย/ก๊อปทั้ง folder ไปเครื่องอื่นได้ (ถ้า GPU เดียวกัน)

#### [NEW] [ScanLate.bat](file:///d:/PlayGround/Manga-Trans/ScanLate.bat)
One-click launcher — user ดับเบิลคลิกไฟล์นี้ไฟล์เดียว:

```bat
@echo off
setlocal

:: ─── Self-contained: ทุก path ชี้เข้า folder ตัวเอง ─────────────
set "ROOT=%~dp0"
set "PYTHON=%ROOT%runtime\python\python.exe"
set "VENV=%ROOT%runtime\venv"
set "ENGINE_DIR=%ROOT%engine\manga-image-translator"

:: ─── กัน Python/pip/torch เขียนไปที่อื่น ────────────────────────
set "PYTHONUSERBASE=%ROOT%runtime\pyuserbase"
set "PIP_CACHE_DIR=%ROOT%runtime\pip-cache"
set "TORCH_HOME=%ROOT%runtime\torch-home"
set "HF_HOME=%ROOT%runtime\hf-home"
set "XDG_CACHE_HOME=%ROOT%runtime\xdg-cache"
set "PYTHONDONTWRITEBYTECODE=1"
set "PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:128"

:: ─── ตรวจ NVIDIA GPU ──────────────────────────────────────────
nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [ERROR] ไม่พบ NVIDIA GPU หรือ driver ไม่ได้ลง
    echo กรุณาลง NVIDIA GPU driver ก่อนใช้งาน
    pause & exit /b 1
)

:: ─── First-run setup (ครั้งแรกเท่านั้น ~5-10 นาที) ─────────────
if not exist "%PYTHON%" call "%ROOT%scripts\setup.bat"

:: ─── Activate venv + Start servers ─────────────────────────────
call "%VENV%\Scripts\activate.bat"

echo.
echo ⚡ ScanLate — Starting...
echo.

:: Start manga-image-translator server (port 8000)
start /b "" "%PYTHON%" -m manga_translator --mode api ...

:: Start ScanLate API server (port 8745)
"%PYTHON%" -m uvicorn server.main:app --port 8745
```

#### [NEW] [scripts/setup.bat](file:///d:/PlayGround/Manga-Trans/scripts/setup.bat)
First-run setup script (ทำครั้งเดียว):

```
1. ตรวจว่ามี NVIDIA GPU + CUDA-capable driver
2. ดาวน์โหลด Python Embedded (portable) เวอร์ชัน **3.10.11** → runtime/python/
   - ต้องใช้ Python 3.10 เพื่อความเข้ากันได้กับไลบรารี Deep Learning เก่าๆ ของ engine (3.11 จะพังบน Windows)
   - เพิ่ม pip ด้วย get-pip.py
3. สร้าง venv ใน runtime/venv/
4. ติดตั้ง Dependencies (Pin versions อย่างเคร่งครัด):
   - `pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118` (บังคับ CUDA 11.8)
   - `pip install -r server/requirements.txt` (ระบุเวอร์ชัน fastapi, litellm ให้ชัดเจน)
   - ใช้ --cache-dir=%ROOT%/runtime/pip-cache
5. `git clone` manga-image-translator และ **checkout ไปที่ commit hash ที่เจาะจง**
   - ห้ามดึง master ล่าสุดเพื่อป้องกัน Loopback Hook พัง
6. pip install manga-image-translator dependencies
7. ดาวน์โหลด ML models → runtime/torch-home/ (ไม่ไป ~/.cache/)
8. ดาวน์โหลด Kanit font → data/fonts/
9. แสดงคำแนะนำการลง Extension: `เปิด Chrome -> ไปที่ chrome://extensions -> เปิด Developer mode -> กด Load unpacked -> เลือกโฟลเดอร์ extension/`
10. แสดง ✅ Setup complete!
```

**Progress Display ระหว่าง setup:**
```
⚡ ScanLate — First-time Setup

[1/7] Checking NVIDIA GPU...          ✅ RTX 3060 Ti (8GB)
[2/7] Setting up Python...             ✅ Python 3.10.11 (portable)
[3/7] Installing dependencies...       ⏳ 45% (PyTorch cu118 + FastAPI...)
[4/7] Downloading manga-image-translator... ⏳ (Pinned Commit)
[5/7] Installing engine dependencies... ⏳
[6/7] Downloading ML models...         ⏳ 1.2GB / 2.1GB
[7/7] Downloading fonts...             ⏳

✅ Setup complete! ใช้เวลา 8 นาที 32 วินาที
   Starting ScanLate server...
```

#### [NEW] [scripts/update.bat](file:///d:/PlayGround/Manga-Trans/scripts/update.bat)
อัพเดท manga-image-translator + ScanLate dependencies:
```
1. git pull manga-image-translator (หรือดาวน์โหลด zip ใหม่)
2. pip install -r requirements.txt --upgrade
3. ตรวจ model updates
```

---

### Component 1: Project Scaffold

#### [NEW] [README.md](file:///d:/PlayGround/Manga-Trans/README.md)
- Project overview, setup instructions, usage guide
- **ข้อกำหนด:** NVIDIA GPU (GTX 1060+ / 6GB+ VRAM), Windows 10/11, ~5GB พื้นที่ว่าง
- **วิธีติดตั้ง:** ดาวน์โหลด → แตกไฟล์ → ดับเบิลคลิก `ScanLate.bat`

#### [NEW] Project Structure
```
ScanLate/
├── ScanLate.bat                     # ⚡ ONE-CLICK LAUNCHER — ดับเบิลคลิกตัวนี้
├── scripts/                         # Setup & update scripts
│   ├── setup.bat                    # First-run setup (ดาวน์โหลด Python/deps/models)
│   └── update.bat                   # Update engine + dependencies
│
├── runtime/                         # 🔒 Self-contained runtime (ไม่แตะ C:)
│   ├── python/                      # Python Embedded (portable)
│   ├── venv/                        # Virtual environment
│   ├── pip-cache/                   # pip cache (แทน %APPDATA%/pip)
│   ├── torch-home/                  # PyTorch model cache (แทน ~/.cache/torch)
│   ├── hf-home/                     # HuggingFace cache (แทน ~/.cache/huggingface)
│   └── xdg-cache/                   # Other cache
│
├── engine/                          # manga-image-translator (git clone)
│   └── manga-image-translator/      # Engine source code + models
│
├── server/                          # Python Backend (ScanLate API)
│   ├── main.py                      # FastAPI entrypoint + CORS
│   ├── requirements.txt             # Dependencies
│   ├── config.py                    # Server configuration
│   ├── .env.example                 # Environment variable template
│   │
│   ├── engine/                      # manga-image-translator integration layer
│   │   ├── __init__.py
│   │   ├── mit_client.py            # HTTP client for manga-image-translator server
│   │   ├── mit_process.py           # Start/health-check engine subprocess
│   │   ├── mit_translator.py        # Custom translator hook → LiteLLM
│   │   └── language.py              # Source language validation
│   │
│   ├── llm/                         # LLM Translation layer
│   │   ├── __init__.py
│   │   ├── client.py                # LiteLLM wrapper
│   │   ├── prompts.py               # Prompt templates
│   │   └── context.py               # Multi-page context manager
│   │
│   ├── profiles/                    # Series Profile system
│   │   ├── __init__.py
│   │   ├── manager.py               # CRUD operations on .md profile files
│   │   ├── extractor.py             # Auto-extract profile (รับรูปจาก extension)
│   │   └── learner.py               # Learn-as-you-go
│   │
│   └── cache/                       # Translation cache manager
│       ├── __init__.py
│       └── manager.py               # Composite key → cached translated image
│
├── data/                            # 📁 User data (ทั้งหมดอยู่ที่นี่)
│   ├── profiles/                    # Profile .md files
│   │   └── _template.md             # Template สำหรับ new profile
│   ├── fonts/                       # Thai font files (.ttf/.otf)
│   │   ├── Kanit-Bold.ttf           # Default font
│   │   ├── Kanit-Regular.ttf        # สำหรับ narration
│   │   └── README.md                # วิธีเพิ่ม font ใหม่
│   └── cache/                       # Translation cache (auto-created)
│
├── extension/                   # Chrome Extension (Manifest V3)
│   ├── manifest.json            # Extension manifest
│   ├── popup/                   # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── options/                 # Settings + Profile Manager page
│   │   ├── options.html
│   │   ├── options.css
│   │   └── options.js
│   ├── content/                 # Content script — injected into manga pages
│   │   ├── content.js           # Image detection + replacement logic
│   │   └── content.css          # Overlay styles, loading indicators
│   ├── background/              # Service worker
│   │   └── service-worker.js    # API communication, per-tab state management
│   ├── icons/                   # Extension icons
│   └── lib/                     # Shared utilities
│       └── api.js               # Server API client
│
└── README.md
```

> [!NOTE]
> **V1 ตัดออก (เพิ่มทีหลัง):**
> - `scraper/` directory ทั้งหมด (Playwright scraper) — ใช้ extension-side extraction แทน
> - Pre-fetch system — V1 แปลทีละหน้าตามที่ user กด
> - Auto-translate toggle — user กดแปลเอง
> - Floating button — ใช้ popup เท่านั้น

---

### Component 2: Python Backend — FastAPI Server

#### [NEW] [main.py](file:///d:/PlayGround/Manga-Trans/server/main.py)
FastAPI application with endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `POST /translate` | POST | รับรูป manga แบบ `multipart/form-data` หรือ `image_url` → return รูปที่แปลแล้ว (**มี `asyncio.Semaphore(1)` กัน VRAM OOM**) |
| `POST /translate/batch` | POST | รับหลายรูปแบบ multipart/URL list แล้ว queue/process ทีละรูปตาม VRAM budget |
| `POST /internal/translate_text` | POST | **[Internal Loopback]** รับ OCR text จาก engine → LLM → return text |
| `GET /status` | GET | ScanLate health + manga-image-translator health + GPU/VRAM status |
| `GET /fonts` | GET | List available fonts จาก `fonts/` directory |
| `GET /profiles` | GET | List all series profiles |
| `POST /profiles` | POST | สร้าง profile ใหม่ (manual) |
| `POST /profiles/extract` | POST | เริ่ม async job: Auto-extract profile จากรูป → return `job_id` |
| `GET /profiles/extract/{job_id}/status` | GET | Polling ตรวจสถานะการสร้าง profile (progress/done) เพื่อกัน HTTP timeout |
| `PUT /profiles/{name}` | PUT | อัพเดท profile (รวมถึง approve new terms) |
| `GET /profiles/{name}` | GET | ดึง profile เฉพาะเรื่อง |
| `GET /cache/stats` | GET | Cache hit/miss statistics |

> [!NOTE]
> **ตัดออกจาก V1:**
> - `POST /translate/prefetch` — ไม่มี pre-fetch ใน V1
> - `DELETE /cache/{series}` — ไม่มีปุ่ม clear cache, ใช้ composite key auto-invalidate
> - `POST /profiles/extract` ไม่รับ URL แล้ว scrape เอง — รับรูปจาก extension ตรงๆ แต่เปลี่ยนเป็น **Async Job** ป้องกัน Timeout

Request/Response flow สำหรับ `/translate`:
```
Request: multipart/form-data
- image: <binary file>           # preferred for content-script upload
- image_url: <string>            # optional alternative; server fetches directly when cookies/hotlink rules allow
- source_lang: ja|ko|zh|en       # mandatory — เลือกจาก popup per-tab (ไม่มี auto)
- profile_name: one-piece        # mandatory — บังคับเลือกก่อนแปล
- font_name: Kanit-Bold          # optional; defaults from global settings
- context_json: [...]            # optional text history from previous pages

Response:
{
  "translated_image_url": "http://localhost:8745/cache/...",
  "detected_texts": [
    {"original": "ルフィ！危ない！", "translated": "ลูฟี่! ระวัง!", "bbox": [x,y,w,h]}
  ],
  "new_terms": [              // สำหรับ learn-as-you-go
    {"original": "新技", "translated": "ท่าใหม่", "confidence": 0.8}
  ],
  "cached": false,
  "cache_key": "sha256:...",
  "processing_time_ms": 3200
}
```

#### [NEW] [config.py](file:///d:/PlayGround/Manga-Trans/server/config.py)
```python
# Configuration via environment variables / .env file
SERVER_PORT = 8745
MIT_SERVER_URL = "http://127.0.0.1:8000"  # manga-image-translator built-in server

# GPU Settings (RTX 3060 Ti — 8GB VRAM)
DEVICE = "cuda"                    # cuda / cpu
BATCH_SIZE = 1                     # conservative default for 8GB VRAM
MAX_CONCURRENT_TRANSLATIONS = 1     # process one image at a time to avoid CUDA OOM
FP16 = True                        # half-precision เพื่อประหยัด VRAM
PYTORCH_CUDA_ALLOC_CONF = "max_split_size_mb:128"

# LLM Settings
LLM_PROVIDER = "gemini"            # gemini / openrouter / ollama
LLM_MODEL = "gemini/gemini-2.5-flash"  # or gemini/gemini-2.5-flash-lite
GOOGLE_API_KEY = ""                # Google AI Studio key
OPENROUTER_API_KEY = ""            # OpenRouter key (optional)
OLLAMA_URL = "http://localhost:11434"  # Ollama URL (optional)

# Font Settings
DEFAULT_FONT = "Kanit-Bold"       # Default Thai font for manga (global)
FONTS_DIR = "./fonts"              # Font directory

# Paths
PROFILES_DIR = "./profiles/data"
CACHE_DIR = "./cache/storage"
CACHE_MAX_SIZE_GB = 10
```

---

### Component 3: manga-image-translator Engine Integration (The Loopback Approach)

> [!IMPORTANT]
> **แก้ปัญหา Architecture (Scrutinize Finding 1):**
> เราไม่แก้ source code ของ engine แต่จะใช้ท่า **Loopback Wrapper** โดยมี `engine/mit_wrapper.py` ทำการ monkey-patch คลาสแปล แล้วค่อย start server 

```
Chrome Extension (Popup กดแปล)
  ↓
ScanLate API (port 8745)
  ├─ cache lookup (composite key)
  ├─ profile/font/model/source-lang resolution
  └─ call manga-image-translator API (port 8000)
       ↓
    [mit_wrapper.py]
     Detection → OCR
       ↓
     [ScanLateNetworkTranslator] ยิง POST /internal/translate_text กลับไปที่ ScanLate API
       ↓
       ScanLate API รับ text → Inject Profile Context → เรียก LiteLLM (Gemini) → Return ภาษาไทย
       ↓
     [ScanLateNetworkTranslator] รับภาษาไทย → ส่งให้ engine ทำต่อ
       ↓
     Inpainting → Rendering
       ↓
Translated image → cache → return to extension
```

#### [NEW] [mit_wrapper.py](file:///d:/PlayGround/Manga-Trans/server/engine/mit_wrapper.py)
- **Script สำหรับรัน Engine:** Launcher จะเรียกรันสคริปต์นี้แทนการรัน `manga_translator` ตรงๆ
- หน้าที่: `import manga_translator`, สร้างคลาส `ScanLateNetworkTranslator`, เอาคลาสไปยัดลง registry ของ engine
- จากนั้นสั่งเริ่ม API server ของ engine (port 8000) ตามปกติ

#### [NEW] [mit_client.py](file:///d:/PlayGround/Manga-Trans/server/engine/mit_client.py)
- HTTP client สำหรับเรียก manga-image-translator API server (port 8000)
- รับผิดชอบ request mapping, timeout, retry, health check, และ error translation
- กำหนดให้ engine ใช้ `ScanLateNetworkTranslator` เป็นตัวแปล

#### [NEW] [mit_process.py](file:///d:/PlayGround/Manga-Trans/server/engine/mit_process.py)
- Start/stop/check `mit_wrapper.py` subprocess
- ตรวจว่า `/docs` หรือ health endpoint ตอบได้ก่อนรับงาน
- Set GPU env เช่น `PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:128`

#### [NEW] [mit_translator.py](file:///d:/PlayGround/Manga-Trans/server/engine/mit_translator.py)
- โค้ดของคลาส `ScanLateNetworkTranslator` ที่จะถูกฉีดเข้าไปโดย `mit_wrapper.py`
- ทำงานอยู่ฝั่ง **process ของ engine (port 8000)** 
- รับ OCR text จาก engine แล้วยิง HTTP POST กลับไปที่ `http://127.0.0.1:8745/internal/translate_text` เพื่อให้ FastAPI จัดการเรื่อง LLM

#### [NEW] [language.py](file:///d:/PlayGround/Manga-Trans/server/engine/language.py)
- รับ source language จาก request (mandatory field จาก popup per-tab selection)
- Validate ว่าเป็นภาษาที่รองรับ (ja/ko/zh/en)
- ไม่มี auto-detect — user เลือกเองใน popup

> [!NOTE]
> **Concurrency Semaphore (Scrutinize Finding 2):**
> ภายใน `main.py` ที่ endpoint `POST /translate` ต้องมี `asyncio.Semaphore(MAX_CONCURRENT_TRANSLATIONS)` เพื่อจำกัดไม่ให้รับงานจาก extension พรวดเดียวหมด ป้องกัน CUDA OOM

> **VRAM Management (RTX 3060 Ti — 8GB):**
> คิด budget แบบ conservative เพราะ peak VRAM รวม activation maps/intermediate buffers/PyTorch allocator overhead ได้ถึง ~5-6.5GB ไม่ใช่แค่ model weights ~3.5GB
> - Default `BATCH_SIZE=1`
> - `MAX_CONCURRENT_TRANSLATIONS=1`
> - `PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:128`
> - `/status` ต้องรายงาน `torch.cuda.memory_allocated()`, `memory_reserved()`, total/free VRAM
> - เพิ่มปุ่ม/setting ให้ user ขยับ batch size ได้เมื่อมี GPU >8GB

---

### Component 4: LLM Translation Layer

#### [NEW] [client.py](file:///d:/PlayGround/Manga-Trans/server/llm/client.py)
- ใช้ **LiteLLM** เป็น router
- ถูกเรียกจาก `engine/mit_translator.py` ซึ่งเป็น custom translator ของ manga-image-translator
- รองรับ providers:
  - `gemini/gemini-2.5-flash` และ `gemini/gemini-2.5-flash-lite` (Google AI Studio)
  - `openrouter/<any-model>` (OpenRouter)
  - `ollama/<model>` (Local LLM)
- Automatic retry + fallback chain
- Include `llm_model` และ provider ใน cache key เพื่อกัน stale translation เมื่อเปลี่ยน model

#### [NEW] [prompts.py](file:///d:/PlayGround/Manga-Trans/server/llm/prompts.py)
Prompt template system:

```python
SYSTEM_PROMPT = """
คุณเป็นนักแปลมังงะมืออาชีพระดับ scanlation team ชั้นนำ
ภาษาต้นทาง: {source_lang} → ภาษาเป้าหมาย: ไทย

## กฎการแปล
- แปลให้เป็นธรรมชาติในภาษาไทย ไม่แปลตรงตัว
- ปรับ tone ตามบุคลิกตัวละคร
- ข้อความต้องกระชับ พอดี speech bubble
- ห้ามเพิ่มข้อความที่ไม่มีในต้นฉบับ

{profile_section}
{context_section}
"""
```

- `{profile_section}` → inject glossary, character names, tone rules จาก series profile
- `{context_section}` → inject text จากหน้าก่อนหน้า (multi-page context)

#### [NEW] [context.py](file:///d:/PlayGround/Manga-Trans/server/llm/context.py)
- เก็บ text history ต่อ session (per chapter)
- ส่ง text จาก 3-5 หน้าก่อนหน้าเป็น context ให้ LLM
- ช่วยให้แปลต่อเนื่อง ไม่ขาดช่วง

---

### Component 5: Series Profile System

#### [NEW] [manager.py](file:///d:/PlayGround/Manga-Trans/server/profiles/manager.py)
- CRUD operations บน .md files ใน `profiles/data/`
- Parse .md → structured data (characters, glossary, rules)
- Inject เข้า LLM prompt
- Compute `profile_hash` สำหรับ cache key — hash เปลี่ยนเมื่อเนื้อหาเปลี่ยน

#### [NEW] [extractor.py](file:///d:/PlayGround/Manga-Trans/server/profiles/extractor.py)
**Auto-extract flow (Extension-side only — ไม่มี Playwright):**
```
1. Extension อยู่ที่หน้า index ของเว็บแปลไทย (e.g. slow-manga.com/manga/one-piece/)
2. User กดปุ่ม "Extract" ใน Profile Manager
3. Extension ดึง chapter list จากหน้า index (content script parse DOM)
4. เลือก 5 ตอนแรก + 5 ตอนล่าสุด
5. Extension เปิด tab ใหม่ → navigate → scroll ให้ lazy-load ครบ → ดึงรูปทั้งหมด
6. ทยอยส่งรูปให้เซิร์ฟเวอร์แบบคุม rate limit (`POST /profiles/extract`) 
7. เซิร์ฟเวอร์ตอบกลับ `job_id` ในทันที (Async Job) และดึงเข้าคิว OCR เบื้องหลัง
8. Extension poll `GET /profiles/extract/{job_id}/status` ดูเปอร์เซ็นต์ (เช่น 35/200 รูป) เพื่อไม่ให้ HTTP connection ขาด (Scrutinize Finding 3)
9. เมื่อ OCR ครบ Server ส่ง text ทั้งหมดเข้า LLM พร้อม prompt:
   "วิเคราะห์สำนวนการแปลมังงะชุดนี้ สรุปเป็น profile:
    - ชื่อตัวละครทุกตัว (ต้นฉบับ → ไทย) + สรรพนาม + บุคลิกการพูด
    - ศัพท์เฉพาะทุกคำ
    - Pattern/กฎการแปลของผู้แปล พร้อมยกตัวอย่างจริง (✅ แปลถูก / ❌ ห้ามแปลแบบนี้)
    - Tone และสำนวนเฉพาะตัวของผู้แปล
    - SFX / Onomatopoeia patterns"
8. LLM generate profile .md
9. Return ให้ user review + แก้ไข + บันทึก
```

#### [NEW] [learner.py](file:///d:/PlayGround/Manga-Trans/server/profiles/learner.py)
**Learn-as-you-go:**
- หลังแปลแต่ละหน้า → ตรวจหาชื่อ/ศัพท์ใหม่ที่ไม่มีใน profile **ที่ user เลือกอยู่**
- Return `new_terms[]` ใน response
- Service worker เก็บ pending terms per tab
- **Popup**: แสดง badge + Approve/Reject ทีละคำ → ถ้า approve → PUT /profiles/{name}
- **Profile Manager Detail**: section "ศัพท์รออนุมัติ" แสดง pending terms ทั้งหมดพร้อม Approve/Reject/Approve All

#### [NEW] [_template.md](file:///d:/PlayGround/Manga-Trans/server/profiles/data/_template.md)
Template สำหรับ series profile ใหม่ — มีโครงสร้างละเอียดพร้อมตัวอย่าง:
- ข้อมูลเรื่อง, ตัวละคร (พร้อมสรรพนาม + ตัวอย่างสำนวน ✅/❌)
- ศัพท์เฉพาะ, กฎการแปล, SFX patterns

---

### Component 6: Cache System

#### [NEW] [manager.py](file:///d:/PlayGround/Manga-Trans/server/cache/manager.py)
- **Composite Cache Key:**
  - `SHA256(image_bytes + profile_hash + font_name + llm_model + source_lang)` → mapped to translated image file
  - ถ้า cache hit → return ทันทีไม่ต้อง process
  - เมื่อ profile/font/model/source_lang เปลี่ยน จะได้ cache key ใหม่ → **auto-invalidate** ไม่ต้องกด clear
  - Cache eviction: LRU, max size configurable (default 10GB)

> [!NOTE]
> **ไม่มี manual cache clear ใน V1** — composite key จัดการ invalidation อัตโนมัติ
> **ไม่มี pre-fetch ใน V1** — เพิ่มทีหลัง

---

### Component 7: Chrome Extension

#### [NEW] [manifest.json](file:///d:/PlayGround/Manga-Trans/extension/manifest.json)
```json
{
  "manifest_version": 3,
  "name": "ScanLate",
  "description": "Real-time Manga/Manhwa/Manhua translator",
  "version": "1.0.0",
  "permissions": ["storage", "activeTab", "scripting", "tabs"],
  "host_permissions": [
    "http://localhost:8745/*",
    "http://127.0.0.1:8745/*"
  ],
  "optional_host_permissions": ["<all_urls>"],
  "action": { "default_popup": "popup/popup.html" },
  "options_page": "options/options.html",
  "background": { "service_worker": "background/service-worker.js" }
}
```

#### [NEW] Popup — [popup.html](file:///d:/PlayGround/Manga-Trans/extension/popup/popup.html) + [popup.js](file:///d:/PlayGround/Manga-Trans/extension/popup/popup.js)

**4 States:**

```
┌─ State 1: Server Offline ─────────────────┐
│  ⚡ ScanLate                               │
│                                            │
│  ⚠️ Server Offline                         │
│                                            │
│  [🔄 Retry]                                │
│  (ทุกอย่างอื่น disabled)                    │
└────────────────────────────────────────────┘

┌─ State 2: ยังไม่ได้เลือก Profile ──────────┐
│  ⚡ ScanLate         Status: ● Connected   │
│                                            │
│  📚 Series: [เลือก Profile ▼]              │
│                                            │
│  ⚠️ กรุณาเลือก Profile ก่อนแปล             │
│                                            │
│  [📖 สร้าง Profile →]  (พาไป Options)      │
└────────────────────────────────────────────┘

┌─ State 3: พร้อมแปล ───────────────────────┐
│  ⚡ ScanLate         Status: ● Connected   │
│                                            │
│  📚 Series: [One Piece ▼]                  │
│  🌐 Source: [Japanese ▼] → TH              │
│                                            │
│  [⚡ แปลทั้งหน้า]                           │
│  [🔄 สลับ ต้นฉบับ/แปล]                     │
│                                            │
│  📝 ศัพท์ใหม่ (3)                           │
│  ├ 新技 → ท่าใหม่  [✓] [✗]                 │
│  ├ 覇気 → ฮาคิ    [✓] [✗]                  │
│  └ 海軍 → กองทัพเรือ [✓] [✗]               │
│                                            │
│  ⚙️ Settings →                             │
└────────────────────────────────────────────┘

┌─ State 4: กำลังแปล ───────────────────────┐
│  ⚡ ScanLate         Status: ● Connected   │
│                                            │
│  📚 Series: One Piece (locked)             │
│  🌐 Source: Japanese (locked)              │
│                                            │
│  ⏳ กำลังแปล... 3/12 รูป                    │
│  ████████░░░░░░░░ 25%                      │
│                                            │
│  ⚙️ Settings →                             │
└────────────────────────────────────────────┘
```

**Popup Logic:**
- เปิด popup → ดึง state จาก service worker สำหรับ active tab
- Profile dropdown แสดงเฉพาะ profiles ที่มีอยู่ (ดึงจาก `GET /profiles`)
- เปลี่ยน profile / source lang → update service worker state สำหรับ tab นั้น
- ปุ่ม "แปลทั้งหน้า" → inject content script + ส่ง translate command
- ปุ่ม "สลับ ต้นฉบับ/แปล" → สั่ง content script toggle
- New terms section → approve/reject → PUT /profiles/{name}

#### [NEW] Content Script — [content.js](file:///d:/PlayGround/Manga-Trans/extension/content/content.js)
หน้าที่:
0. **On-demand Injection:**
   - ไม่ inject บน `<all_urls>` ตั้งแต่ install
   - Service worker ใช้ `chrome.scripting.executeScript()` เมื่อ user กดปุ่ม "แปลทั้งหน้า" ใน popup
1. **Image Detection (Hybrid):**
   - Fallback: scan `<img>` ที่ width > 600px, เรียงแนวตั้ง, ใน scroll container
   - ตรวจ `src`, `data-src`, `data-lazy`, `data-original`, และ `srcset`
2. **Image Replacement:**
   - เมื่อได้รูปแปล → fade-in แทนที่รูปต้นฉบับ (progressive loading)
   - เก็บรูปต้นฉบับไว้ใน `data-original-src`
3. **Toggle Original/Translated:**
   - รับ command จาก popup → สลับทั้งหน้า
4. **Context Collection:**
   - เก็บ detected texts จากแต่ละหน้า → ส่งเป็น context สำหรับหน้าถัดไป
5. **Profile Extraction Support:**
   - เมื่อ Profile Manager สั่ง: scroll หน้า chapter ให้ lazy-load ครบ → ดึง image URLs → ส่งรูปให้ server

#### [NEW] Service Worker — [service-worker.js](file:///d:/PlayGround/Manga-Trans/extension/background/service-worker.js)
หน้าที่:
1. **Per-tab State Management:** เก็บ state per tabId ลงใน **`chrome.storage.session`** (ห้ามเก็บลง memory global variable เด็ดขาด เพราะ V3 Service Worker จะหลับภายใน 30 วิหากไม่มี event และทำให้ state หายหมด):
   ```js
   // Format ใน chrome.storage.session:
   // "tabState_<tabId>": {
   //   profileName: "one-piece",   // null ถ้ายังไม่เลือก
   //   sourceLang: "ja",
   //   pendingTerms: [...],
   //   translationStatus: "idle",
   //   translatedCount: 0,
   //   totalCount: 0
   // }
   ```
2. **API Communication:** ส่ง request ไป backend server ด้วย `multipart/form-data` หรือ `image_url`
   - มีระบบ Keep-alive Ping เมื่อรอ Async Job (Profile Extraction) เพื่อไม่ให้ Service Worker หลับกลางคัน
   - Default: ส่ง `image_url` ให้ server fetch เพื่อเร็วและประหยัด memory
   - Fallback: ถ้า server fetch ติด cookie/hotlink/CORS ให้ extension ขอ optional host permission แล้ว fetch/upload binary เป็น multipart
3. **Dynamic Injection:** inject content script เฉพาะ tab ที่ user กดแปล
4. **Settings Storage:** เก็บ server URL, API keys, preferences ใน `chrome.storage`
5. **Profile Extraction Orchestration:** เมื่อ Profile Manager สั่ง extract:
   - เปิด tab → inject content script → scroll → ดึงรูป → ส่ง server → ปิด tab → วน

#### [NEW] Options Page — [options.html](file:///d:/PlayGround/Manga-Trans/extension/options/options.html) + [options.js](file:///d:/PlayGround/Manga-Trans/extension/options/options.js)

**2 Tabs:**

**Tab 1 — Settings:**
- Server URL (default: `http://localhost:8745`)
- LLM Provider selector (dropdown: Gemini / OpenRouter / Ollama)
- Model selector:
  - Gemini: dropdown [gemini-2.5-flash, gemini-2.5-flash-lite]
  - OpenRouter: free text input พิมพ์ชื่อ model
  - Ollama: free text input พิมพ์ชื่อ model
- API Keys input (Gemini key, OpenRouter key)
- Font selector:
  - แสดงรายการ font ที่มีใน `fonts/` directory (ดึงจาก `GET /fonts`)
  - Preview ตัวอย่าง font แต่ละตัว
  - เลือก default font (global — ใช้ทุกเรื่อง)

**Tab 2 — Profile Manager:**

*List View (หน้าแรก):*
```
┌─────────────────────────────────────────┐
│  📚 Profile Manager          [+ สร้าง] │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ 📖 One Piece              🔴 3   │  │ ← badge = pending terms
│  │    สร้างเมื่อ 2026-05-20         │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │ 📖 Naruto                        │  │
│  │    สร้างเมื่อ 2026-05-18         │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │ 📖 Solo Leveling          🔴 1   │  │
│  │    สร้างเมื่อ 2026-05-15         │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

*Detail View (กดเข้าไปดูเรื่อง):*
```
┌─────────────────────────────────────────┐
│  ← กลับ                    [✏️ Edit]   │
│                                         │
│  📖 One Piece                           │
│                                         │
│  ─── Rendered Markdown (.md) ────────── │
│  ## ตัวละคร                              │
│  | ต้นฉบับ | ไทย | สรรพนาม |             │
│  | ルフィ  | ลูฟี่ | กู/มึง |              │
│  | ゾロ    | โซโร  | ข้า/เจ้า |           │
│  ...                                    │
│  ─────────────────────────────────────── │
│                                         │
│  📝 ศัพท์รออนุมัติ (3)                    │
│  ├ 新技 → ท่าใหม่  [✓ Approve] [✗]      │
│  ├ 覇気 → ฮาคิ    [✓ Approve] [✗]       │
│  └ 海軍 → กองทัพเรือ [✓ Approve] [✗]    │
│  [✓ Approve All]                        │
│                                         │
│  [🗑️ ลบ Profile]                        │
└─────────────────────────────────────────┘
```

*Edit Mode (กด Edit):*
```
┌─────────────────────────────────────────┐
│  ← กลับ        [💾 Save] [✗ Cancel]    │
│                                         │
│  📖 One Piece                           │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ ## ตัวละคร                        │  │ ← textarea raw markdown
│  │ | ต้นฉบับ | ไทย | สรรพนาม |       │  │
│  │ | ルフィ  | ลูฟี่ | กู/มึง |        │  │
│  │ | ゾロ    | โซโร  | ข้า/เจ้า |     │  │
│  │ ...                               │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

*Create Profile (กด "สร้าง"):*
```
┌─────────────────────────────────────────┐
│  ← กลับ                                │
│                                         │
│  📖 สร้าง Profile ใหม่                   │
│                                         │
│  URL เว็บแปลไทย:                         │
│  [https://slow-manga.com/manga/...]     │
│                                         │
│  ชื่อเรื่อง: Revenge of the Sword...    │ ← auto-detect จาก slug
│  (editable)                             │
│                                         │
│  [🚀 Extract]                           │
│                                         │
│  ⏳ กำลังดึงตอนที่ 3/10...               │ ← progress
│  ████████░░░░░░░░ 30%                   │
└─────────────────────────────────────────┘
```

---

## User Review Required

> [!IMPORTANT]
> **manga-image-translator Integration Decision**: ใช้ทาง **subprocess/API เท่านั้น** — clone/run manga-image-translator จาก source แล้วเรียก built-in server ที่ `http://127.0.0.1:8000`
> ScanLate จะไม่ import internal detector/OCR/inpainting/renderer modules โดยตรง เพราะ internal coupling สูงและไม่ใช่ pip package ที่ stable

> [!WARNING]
> **Web Scraping**: การ scrape เว็บ manga อาจขัด ToS ของเว็บนั้น ใช้เพื่อ personal use เท่านั้น Profile extraction ใช้แค่ text ที่ OCR ได้ ไม่ได้เก็บรูปต้นฉบับ
> V1 ใช้ extension-side extraction เท่านั้น — ดึงรูปจาก browser session ของ user โดยตรง

> [!NOTE]
> **VRAM Budget (RTX 3060 Ti — 8GB):**
> | Item | Estimated VRAM / Behavior | หมายเหตุ |
> |---|---|---|
> | Model weights | ~3.5 GB best-case FP16 | detection/OCR/inpainting รวม |
> | Peak inference | ~5-6.5 GB | รวม activation/intermediate/PyTorch allocator overhead |
> | Practical headroom | ~1.5-3 GB | ขึ้นกับ resolution ของหน้า manga |
> | Default batch | `BATCH_SIZE=1` | ปลอดภัยกว่า batch 4 บน 8GB |
> | Monitoring | `/status` reports allocated/reserved/free VRAM | ใช้ปรับ tuning ภายหลัง |

---

## Verification Plan

### Automated Tests
0. **Launcher Isolation Test**: รัน `ScanLate.bat` → ตรวจว่าไม่มีไฟล์ถูกเขียนนอก folder ScanLate (ไม่แตะ C:, AppData, Registry)
1. **Engine Proxy Test**: ScanLate เรียก manga-image-translator server ได้, map request/response ถูก, handle timeout/error ได้
2. **Loopback Hook Test**: `mit_wrapper.py` สำเร็จการฉีดคลาส และ `ScanLateNetworkTranslator` ยิง POST กลับมาที่ `/internal/translate_text` ได้ถูกต้อง
3. **Profile System Test**: สร้าง/อ่าน/อัพเดท profile .md → ตรวจว่า parse ถูกต้อง และ `profile_hash` เปลี่ยนเมื่อแก้เนื้อหา
4. **Cache Key Test**: รูปเดิม + profile/font/model/source_lang เดิมต้อง cache hit; เปลี่ยนค่าใดค่าหนึ่งต้อง miss
5. **Concurrency Test**: ยิง `POST /translate` พร้อมกัน 10 รูป → ตรวจสอบว่า semaphore คุมคิวให้ทำงานทีละรูป และไม่ OOM
6. **VRAM Status Test**: `/status` รายงาน manga-image-translator health + allocated/reserved/free VRAM
7. **Extension Load Test**: โหลด extension ใน Chrome → popup ทำงาน + 4 states ถูกต้อง + per-tab state แยกกัน

### Manual Verification
0. **Fresh Install Test**: ก๊อป folder ScanLate ไป drive อื่น → ดับเบิลคลิก `ScanLate.bat` → โหลด Extension ใน Chrome (Load unpacked) → server เปิดได้พร้อมใช้
1. เปิดเว็บ manga raw (เช่น rawkuma.com) → เลือก profile + source lang ใน popup → กดแปลทั้งหน้า → ตรวจคุณภาพ
2. สร้าง series profile ผ่าน Profile Manager → ใส่ URL เว็บแปลไทย → ตรวจ async job progress จนเสร็จ
3. แปล 5 หน้าติดกัน → ตรวจว่า context ต่อเนื่อง ชื่อตัวละครเดิม
4. ปิดแล้วเปิดหน้าเดิม (ด้วย profile/font/model/source_lang เดิม) → ตรวจว่า cache hit (load instant)
5. แก้ profile/font/model → เปิดหน้าเดิม → ต้อง cache miss (composite key ต่าง)
6. เปิด 2 tabs คนละเรื่อง → ตรวจว่า per-tab state แยกกัน (profile + source lang)
7. แปลหน้าหนึ่ง → เจอ new terms → popup แสดง badge → approve → ตรวจว่า profile อัพเดท

---

## Execution Order

| Phase | สิ่งที่ทำ | เหตุผล |
|---|---|---|
| **Phase 1** | **One-Click Launcher** — ScanLate.bat + setup.bat + self-contained runtime | User ดับเบิลคลิกแล้วใช้ได้เลย ไม่แตะ C: |
| **Phase 2** | Project scaffold + manga-image-translator subprocess/API integration | ยืนยัน core engine ทำงานผ่าน launcher |
| **Phase 3** | Custom translator hook + LiteLLM + Prompt system | ให้ engine แปลด้วย profile-aware LLM ได้จริง |
| **Phase 4** | Series Profile system + Template + profile hash | คุณภาพการแปลและ cache invalidation |
| **Phase 5** | Composite cache (auto-invalidate only) | Performance โดยไม่มี manual clear |
| **Phase 6** | Chrome Extension popup (4 states + per-tab) + dynamic content script + translate flow | User-facing — บังคับเลือก profile ก่อนแปล |
| **Phase 7** | Extension-side profile extraction (auto-navigate 5+5) | Profile automation ผ่าน browser session ของ user |
| **Phase 8** | Options page (Settings + Profile Manager with list/detail/edit/pending terms) | Full feature |
| **Phase 9** | Learn-as-you-go (new terms badge + approve) | Polish quality over time |
| **Phase 10** | Testing, README, polish | Ship-ready |

---

## Bugs & Errors Encountered During Auto-Extract Implementation

ระหว่างการพัฒนาระบบ Auto-Extract Profile และเชื่อมต่อ ScanLate เข้ากับ manga-image-translator Engine พบ Bug ซับซ้อน 7 จุด (ทั้งในโค้ดของ ScanLate เองและใน Engine ดั้งเดิม) ดังนี้:

### 1. `401 Unauthorized` (Nonce Authentication)
- **สาเหตุ:** `manga-image-translator` engine ป้องกันการถูกเรียกใช้งานภายใน (Internal API) ด้วย `X-Nonce` header. โค้ดที่สร้าง process ใหม่ของ ScanLate ไม่ได้ดึงค่า Nonce ออกมาใช้ตอนยิง Loopback Hook
- **วิธีแก้:** แกะค่า Nonce ในฝั่ง Server ก่อนเริ่มกระบวนการและเพิ่ม `X-Nonce` ในทุก request ของ `server/request_extraction.py` (หรือเทียบเท่า)

### 2. Missing `image_urls` & Slow Scrolling
- **สาเหตุ:** (Mistake) สคริปต์ Content Script ดึงรูปจากหน้าเว็บไซต์ไม่ครบ เพราะตอนแรกรอ DOM โหลดไม่สมบูรณ์ และวิธี Scroll ช้าเกินไป
- **วิธีแก้:** ปรับแก้การ Scroll ให้เร็วขึ้น 5 เท่า, จัดการหาลิ้งค์ตอนด้วย Fallback ที่แม่นยำขึ้น, และเพิ่มการเช็ค `if not req.image_urls` ที่ฝั่งเซิร์ฟเวอร์เพื่อเตือนล่วงหน้า

### 3. `429 some Method is already being executed.` (Engine Deadlock)
- **สาเหตุ:** บั๊กใหญ่ใน Engine ดั้งเดิม `manga-image-translator` ในไฟล์ `share.py`. คลาสแชร์โมเดลจะมีการใช้ `Lock` เพื่อป้องกันการแปลซ้อนทับกัน แต่ดันเอาขั้นตอนอ่านข้อมูล (Deserialization) ไว้**ก่อน** `try...except`! เมื่อข้อมูลที่รับมาผิดรูปแบบจนพัง ระบบจึงไม่ปลดล็อคให้ ทำให้เกิด Deadlock คิวค้างตลอดกาล
- **วิธีแก้:** ผ่าตัดไฟล์ `share.py` เลื่อนขั้นตอนการเช็ค Lock ไปอยู่หลังจากการอ่านข้อมูลเรียบร้อยแล้ว เพื่อให้แน่ใจว่ามันจะโดน `finally: self.lock.release()` ปลดล็อคเสมอ

### 4. `UnpicklingError: Deserialization of fractions.Fraction is not allowed`
- **สาเหตุ:** Python Pillow (`PIL.Image`) บางครั้งเก็บข้อมูล DPI เป็นเศษส่วน (`fractions.Fraction`). แต่ Engine ล็อกความปลอดภัยด้วย `RestrictedUnpickler` ที่ไม่อนุญาตโมดูล `fractions` พอมันโหลดข้อมูลรูปภาพมาจึงพังและกลายเป็นสาเหตุให้เกิด Deadlock ในข้อ 3
- **วิธีแก้:** อนุญาตโมดูล `fractions` ลงไปใน `SAFE_PICKLE_MODULES` ใน `share.py`

### 5. `500 Language not supported for ScanLateNetworkTranslator: "THA"`
- **สาเหตุ:** (Mistake) ในฝั่ง ScanLate พยายามตั้งค่าให้รับภาษาปลายทางเป็น `"THA"` แต่ลืมอัพเดทตาราง `_LANGUAGE_CODE_MAP` ของ Custom Translator ที่ฝังตัวอยู่ใน Engine 
- **วิธีแก้:** เพิ่ม `"THA": "th"` ลงใน Dictionary ภาษาของไฟล์ `scanlate.py`

### 6. `422 cannot identify image file` (SVG/GIF Crash)
- **สาเหตุ:** (Mistake) Extension ขูดรูปโฆษณา (GIF) และไอคอนเว็บไซต์ (SVG) ส่งมาให้เซิร์ฟเวอร์ด้วย ซึ่งโมเดล AI ของ Engine ไม่รองรับไฟล์เหล่านี้ ทำให้พังตอนพยายามใช้ Pillow เปิดรูป
- **วิธีแก้:** ใส่ Filter ลงใน `server/main.py` สั่งเมิน (`continue`) ไฟล์นามสกุล `.svg`, `.gif` ก่อนจะดาวน์โหลดและส่งไปประมวลผล

### 7. `'utf-8' codec can't decode byte 0x80`
- **สาเหตุ:** (Mistake) ใน `sent_data_internal.py` โค้ดพยายามรับคำตอบจาก `/simple_execute/translate` ด้วยการอ่านค่าแบบ JSON String (`response.text()`) แต่จริงๆ แล้ว Endpoint ของ Engine ตัวนี้พ่นข้อมูลออกมาเป็นไบนารี (`pickle.dumps()` ซึ่งมักเริ่มด้วย `0x80`) จึงเกิด Error ตอนแปลงเป็น UTF-8
- **วิธีแก้:** เปลี่ยนการถอดรหัสเป็น `pickle.loads(await response.read())` แทนเพื่อแกะโครงสร้าง Binary กลับมาเป็น Python Dictionary อย่างถูกต้อง
