# Manga-Trans2 (ScanLate) Project Handoff

## 📌 Project Overview
**Manga-Trans2 (ScanLate)** is a Chrome extension that translates manga/manhwa images directly in the browser. It overlays translated text on top of original speech bubbles without replacing the original images. It connects to a local backend (FastAPI/Python) which handles OCR and interacts with LLMs (Google Gemini, OpenRouter) to translate the text.

## 🛠️ Current State & Architecture
- **Backend (`server/`)**: Python FastAPI server that runs OCR (using Manga Image Translator tools or Gemini OCR) and translates text via LLMs.
- **Frontend (`extension/`)**: 
  - `popup/`: The control panel for the extension.
  - `settings/`: Advanced settings page for LLM Providers, OCR settings, Profiles, and Debug Logs.
  - `content/`: Injected script that finds manga images, requests translation, and renders the translated text overlays over the images.
  - `background/`: Service worker acting as the central state manager and API communicator.

## 🐛 Problems Encountered & Solved
1. **Extension Stuck at `0/30` (Race Condition)**: 
   - **Problem**: The UI would get stuck at `0/30` or show incorrect translation progress because multiple translation requests were hitting the service worker simultaneously, causing race conditions in state updates.
   - **Fix**: Implemented a Mutex/Async Lock (`tabStateLocks`) in `service-worker.js` to process `updateTabState` sequentially.
2. **Gemini OCR `NameError: name 'os' is not defined`**:
   - **Problem**: The backend crashed when trying to access the API key via `os.environ` because the `os` module was missing.
   - **Fix**: Added `import os` to `gemini_ocr.py`.
3. **Debug Log Migration & UI Crash**:
   - **Problem**: The user wanted to move the Debug Log from the Popup to the Settings page. During the migration, a dangling reference to `chkDebugMode` in `popup.js` caused a silent `ReferenceError`, making the Translate button unresponsive.
   - **Fix**: Cleaned up the undefined variable from `popup.js`, moved the UI elements to `settings.html`, added `initDebugLogs()` to `settings.js`, and updated `content.js` to read `debugMode` dynamically from `chrome.storage.local`.

## 🚀 Next Steps / Pending Tasks
1. **Advanced Features for Gemini OCR**: 
   - Implement the UI in the Advanced Settings to allow users to toggle Gemini OCR, enter a specific API Key for it, and choose the model specifically for OCR (separate from the translation LLM).
2. **GitHub Repository Cleanup**: 
   - Remove unused test files.
   - Write a comprehensive `README.md` in Thai.
3. **Refine Overlay Rendering (Future Enhancements)**:
   - Ensure the translated text scales perfectly with browser resizing and handles long texts elegantly inside original manga bubbles.

---
*You can provide this document to the agent in your next conversation to immediately resume where we left off!*
