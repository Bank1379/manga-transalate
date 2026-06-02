@echo off
setlocal

:: ─── Self-contained: ทุก path ชี้เข้า folder ตัวเอง ─────────────
set "ROOT=%~dp0"
set "PYTHON=%ROOT%runtime\python\python.exe"
set "PYTHONPATH=%ROOT%engine\manga-image-translator;%PYTHONPATH%"

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

:: ─── First-run setup (ครั้งแรกเท่านั้น) ─────────────
if not exist "%PYTHON%" (
    call "%ROOT%scripts\setup.bat"
)

echo.
echo ⚡ ScanLate v3 — Starting...
echo.

:: Start ScanLate API Gateway on port 8745 (FastAPI starts the engine automatically in lifespan)

:: Start ScanLate API server (port 8745)
echo Starting ScanLate API Gateway on port 8745...
:: ใน V1/V3 server/main.py จะเป็น FastAPI app ของเรา
"%PYTHON%" -m uvicorn server.main:app --host 0.0.0.0 --port 8745

pause
