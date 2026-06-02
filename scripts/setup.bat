@echo off
setlocal enabledelayedexpansion

:: ─── ตั้งค่า ROOT directory ──────────────────────────────────────
set "ROOT=%~dp0..\"
cd /d "%ROOT%"

echo ===================================================
echo   ⚡ ScanLate v3 - First-Time Setup
echo ===================================================
echo.

:: [1/7] Checking NVIDIA GPU
echo [1/7] Checking NVIDIA GPU...
nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [ERROR] NVIDIA GPU not found or driver is not installed.
    echo ScanLate requires an NVIDIA GPU for OCR and Detection.
    pause & exit /b 1
)
echo      NVIDIA GPU Detected!

:: [2/7] Setting up Python 3.10.11 (Embedded)
echo [2/7] Setting up Python 3.10.11 (Embedded)...
if not exist "runtime\python" mkdir "runtime\python"

if not exist "runtime\python\python.exe" (
    echo      Downloading Python 3.10.11 Embeddable...
    curl -L -sS "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip" -o python-embed.zip
    if errorlevel 1 (
        echo [ERROR] Failed to download Python.
        pause & exit /b 1
    )
    echo      Extracting Python...
    powershell -Command "Expand-Archive -Path python-embed.zip -DestinationPath runtime\python -Force"
    del python-embed.zip
)

:: Configure python310._pth for site-packages and the engine folder
if exist "runtime\python\python310._pth" (
    echo      Configuring Python paths...
    (
        echo python310.zip
        echo .
        echo ../../engine/manga-image-translator
        echo.
        echo import site
    ) > "runtime\python\python310._pth"
)

:: [3/7] Installing pip
if not exist "runtime\python\Scripts\pip.exe" (
    echo      Downloading pip installer...
    curl -L -sS "https://bootstrap.pypa.io/get-pip.py" -o runtime\python\get-pip.py
    echo      Installing pip...
    "runtime\python\python.exe" "runtime\python\get-pip.py" --no-warn-script-location
    del "runtime\python\get-pip.py"
)
echo      Python setup complete!

:: [4/7] Installing PyTorch with CUDA 11.8 support
echo [4/7] Installing PyTorch (CUDA 11.8)...
set "PIP_CACHE_DIR=%ROOT%runtime\pip-cache"
"runtime\python\python.exe" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118 --cache-dir "%PIP_CACHE_DIR%"
if errorlevel 1 (
    echo [ERROR] Failed to install PyTorch.
    pause & exit /b 1
)

:: [5/7] Cloning manga-image-translator
echo [5/7] Cloning manga-image-translator...
if not exist "engine\manga-image-translator" (
    mkdir "engine"
    git clone https://github.com/zyddnys/manga-image-translator.git engine/manga-image-translator
) else (
    echo      manga-image-translator already cloned.
)

:: Patch engine requirements.txt to remove pydensecrf (fails to compile on Windows, and is unused in OCR-only mode)
if exist "engine\manga-image-translator\requirements.txt" (
    echo      Patching engine requirements.txt...
    powershell -Command "(gc 'engine\manga-image-translator\requirements.txt') -replace 'pydensecrf.*', '' | Out-File -encoding ASCII 'engine\manga-image-translator\requirements.txt'"
)

:: [6/7] Installing dependencies & Engine dependencies
echo [6/7] Installing FastAPI, LiteLLM, PaddleOCR and other API dependencies...
"runtime\python\python.exe" -m pip install -r server\requirements.txt --cache-dir "%PIP_CACHE_DIR%"

echo      Installing manga-image-translator dependencies...
"runtime\python\python.exe" -m pip install -r engine/manga-image-translator/requirements.txt --cache-dir "%PIP_CACHE_DIR%"

:: [7/7] Patching manga-image-translator and downloading models
echo [7/7] Patching engine and downloading OCR/Detection models...
set "PYTHONPATH=%ROOT%engine\manga-image-translator;%PYTHONPATH%"
set "TORCH_HOME=%ROOT%runtime\torch-home"
set "HF_HOME=%ROOT%runtime\hf-home"
set "XDG_CACHE_HOME=%ROOT%runtime\xdg-cache"

"runtime\python\python.exe" scripts\patch_engine.py
if errorlevel 1 (
    echo [ERROR] Patching and downloading models failed.
    pause & exit /b 1
)

echo.
echo ===================================================
echo   ✅ Setup Complete!
echo ===================================================
echo.
echo To start ScanLate:
echo Double-click 'ScanLate.bat' in the root directory.
echo.
pause
