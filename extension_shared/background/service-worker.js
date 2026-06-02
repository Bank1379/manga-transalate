import { ScanLateAPI } from "../lib/api.js";
import { Logger } from "../lib/logger.js";

// Initialize session storage rules (required for Manifest V3 memory preservation)
chrome.runtime.onInstalled.addListener(() => {
  // Set default server URL
  chrome.storage.local.set({ serverUrl: "http://127.0.0.1:8745" });
  Logger.info("ScanLate v3 Service Worker Initialized.", "ServiceWorker");
});

// Self-healing migration check for server URL
chrome.storage.local.get("serverUrl").then((result) => {
  if (!result.serverUrl || result.serverUrl.includes(":8000") || result.serverUrl.includes("localhost:8000")) {
    chrome.storage.local.set({ serverUrl: "http://127.0.0.1:8745" });
    Logger.info("Server URL self-healed to http://127.0.0.1:8745", "ServiceWorker");
  }
});

// Helper: Get key name for tab session storage
const getTabKey = (tabId) => `tabState_${tabId}`;

// Helper: Fetch state for a specific tab
async function getTabState(tabId) {
  const key = getTabKey(tabId);
  const result = await chrome.storage.session.get(key);
  if (result[key]) {
    return result[key];
  }
  
  // If no tab state, load from global last saved state
  const globalState = await chrome.storage.local.get(["lastProfileName", "lastSourceLang"]);
  return {
    profileName: globalState.lastProfileName || null,
    sourceLang: globalState.lastSourceLang || "auto",
    status: "idle",
    translatedCount: 0,
    totalCount: 0,
    debugMode: false
  };
}

// Helper: Save state for a specific tab
async function setTabState(tabId, state) {
  const key = getTabKey(tabId);
  await chrome.storage.session.set({ [key]: state });
  
  // Also save profileName and sourceLang globally as last used
  const toSave = {};
  if (state.profileName) toSave.lastProfileName = state.profileName;
  if (state.sourceLang) toSave.lastSourceLang = state.sourceLang;
  if (Object.keys(toSave).length > 0) {
    await chrome.storage.local.set(toSave);
  }
}

// Active translation fetch abort controllers
const activeTranslationControllers = {};

// Handle message commands from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : message.tabId;
  
  if (!tabId && message.action !== "getDebugLogs" && message.action !== "clearDebugLogs" && message.action !== "checkServer") {
    sendResponse({ error: "Missing Tab ID context." });
    return true;
  }

  // Handle async operations
  (async () => {
    try {
      switch (message.action) {
        case "getTabState": {
          const state = await getTabState(tabId);
          sendResponse({ state });
          break;
        }

        case "updateTabState": {
          // Use an async lock to prevent race conditions from concurrent background updates
          if (!globalThis.tabStateLocks) globalThis.tabStateLocks = {};
          if (!globalThis.tabStateLocks[tabId]) globalThis.tabStateLocks[tabId] = Promise.resolve();
          
          globalThis.tabStateLocks[tabId] = globalThis.tabStateLocks[tabId].then(async () => {
              const currentState = await getTabState(tabId);
              const newState = { ...currentState, ...message.updates };
              await setTabState(tabId, newState);
              
              // Notify any listening popups about state change
              chrome.runtime.sendMessage({ action: "tabStateChanged", tabId, state: newState }).catch(() => {});
              
              sendResponse({ success: true, state: newState });
          }).catch(err => {
              Logger.error(`updateTabState race lock error: ${err.message}`, "ServiceWorker");
              sendResponse({ success: false, error: err.message });
          });
          break;
        }

        case "checkServer": {
          Logger.info("Checking server connection status...", "ServiceWorker");
          const status = await ScanLateAPI.getStatus();
          const profiles = status.status === "online" ? await ScanLateAPI.getProfiles() : [];
          Logger.info(`Server status: ${status.status}`, "ServiceWorker");
          sendResponse({ status, profiles });
          break;
        }

        case "injectContentScript": {
          // Check if already injected by sending a ping message to active tab
          let isInjected = false;
          try {
            const res = await chrome.tabs.sendMessage(tabId, { action: "ping" });
            if (res && res.pong) isInjected = true;
          } catch (e) {
            // Expected if script is not yet injected
          }

          if (!isInjected) {
            Logger.info(`Injecting content script into Tab ${tabId}...`, "ServiceWorker");
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ["content/content.js"]
            });
            await chrome.scripting.insertCSS({
              target: { tabId },
              files: ["content/content.css"]
            });
          }
          sendResponse({ success: true });
          break;
        }

        case "fetchImageBytes": {
          const url = message.url;
          Logger.info(`Proxy-fetching image: ${url}`, "ServiceWorker");
          try {
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`Failed to fetch image: HTTP ${response.status}`);
            }
            const buffer = await response.arrayBuffer();
            Logger.info(`Successfully fetched image. Size: ${buffer.byteLength} bytes`, "ServiceWorker");
            sendResponse({ success: true, arrayBuffer: buffer });
          } catch (e) {
            Logger.error(`Failed proxy-fetching image ${url}: ${e.message}`, "ServiceWorker");
            sendResponse({ success: false, error: e.message });
          }
          break;
        }

        case "cancelTranslation": {
          Logger.info(`Cancelling translations for tab ${tabId}`, "ServiceWorker");
          if (activeTranslationControllers[tabId]) {
            activeTranslationControllers[tabId].forEach(c => c.abort());
            activeTranslationControllers[tabId] = [];
          }
          sendResponse({ success: true });
          break;
        }

        case "translateImage": {
          const { imageUrl, sourceLang, profileName, ocrModel, contextJson, useMultimodal, useGeminiOcr, useAutoGlossary, ocrProvider, ocrModelSlug, ocrApiKey, imageIndex, totalImages } = message;
          Logger.info(`Proxy-translating image URL: ${imageUrl} using profile: ${profileName}`, "ServiceWorker");
          try {
            const response = await fetch(imageUrl);
            if (!response.ok) {
              throw new Error(`Failed to fetch image: HTTP ${response.status}`);
            }
            let imageBuffer = await response.arrayBuffer();
            Logger.info(`Successfully downloaded image (size: ${imageBuffer.byteLength} bytes)`, "ServiceWorker");
            
            // --- Image Resizing Optimization ---
            let scaleRatio = 1.0;
            const MAX_WIDTH = 1200;
            
            try {
              const blob = new Blob([imageBuffer]);
              const bitmap = await createImageBitmap(blob);
              
              if (bitmap.width > MAX_WIDTH) {
                scaleRatio = MAX_WIDTH / bitmap.width;
                const newWidth = MAX_WIDTH;
                const newHeight = Math.floor(bitmap.height * scaleRatio);
                
                Logger.info(`Resizing image from ${bitmap.width}x${bitmap.height} to ${newWidth}x${newHeight} (ratio: ${scaleRatio})`, "ServiceWorker");
                
                const offscreen = new OffscreenCanvas(newWidth, newHeight);
                const ctx = offscreen.getContext('2d');
                ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
                
                const resizedBlob = await offscreen.convertToBlob({ type: "image/jpeg", quality: 0.85 });
                imageBuffer = await resizedBlob.arrayBuffer();
                Logger.info(`Resized image size: ${imageBuffer.byteLength} bytes`, "ServiceWorker");
              }
              bitmap.close();
            } catch (resizeErr) {
              Logger.error(`Failed to resize image, continuing with original: ${resizeErr.message}`, "ServiceWorker");
            }
            // -----------------------------------
            
            if (!activeTranslationControllers[tabId]) {
              activeTranslationControllers[tabId] = [];
            }
            const abortController = new AbortController();
            activeTranslationControllers[tabId].push(abortController);

            ScanLateAPI.translateImageStream(imageBuffer, sourceLang, profileName, ocrModel, contextJson, imageIndex, totalImages, useMultimodal, useGeminiOcr, useAutoGlossary, ocrProvider, ocrModelSlug, ocrApiKey, (eventObj) => {

                // Scale bounding boxes back up to match the original image size in the browser
                if (scaleRatio !== 1.0 && eventObj.type === "metadata" && eventObj.regions) {
                    eventObj.regions.forEach(box => {
                        if (box.bbox) box.bbox = box.bbox.map(coord => Math.round(coord / scaleRatio));
                    });
                }
                
                // Forward the SSE event to the content script
                chrome.tabs.sendMessage(tabId, { 
                    action: "translateStreamEvent", 
                    imageUrl: imageUrl, 
                    event: eventObj 
                }).catch(() => {
                    // Ignore errors if content script is gone
                });
            }, abortController.signal).then(() => {
                Logger.info(`Translation stream complete for ${imageUrl}.`, "ServiceWorker");
                chrome.tabs.sendMessage(tabId, { 
                    action: "translateStreamEvent", 
                    imageUrl: imageUrl, 
                    event: { type: "stream_closed" } 
                }).catch(() => {});
            }).catch(err => {
                Logger.error(`Translation stream failed: ${err.message}`, "ServiceWorker");
                chrome.tabs.sendMessage(tabId, { 
                    action: "translateStreamEvent", 
                    imageUrl: imageUrl, 
                    event: { type: "error", message: err.message } 
                }).catch(() => {});
            }).finally(() => {
                if (activeTranslationControllers[tabId]) {
                    activeTranslationControllers[tabId] = activeTranslationControllers[tabId].filter(c => c !== abortController);
                }
            });
            
            // Immediately respond that streaming has started
            sendResponse({ success: true, streaming: true });
          } catch (e) {
            Logger.error(`Translation process failed: ${e.message}`, "ServiceWorker");
            sendResponse({ success: false, error: e.message });
          }
          break;
        }


        case "getDebugLogs": {
          const logs = await Logger.getLogs();
          sendResponse({ success: true, logs });
          break;
        }

        case "clearDebugLogs": {
          await Logger.clearLogs();
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ error: "Unknown action: " + message.action });
      }
    } catch (err) {
      Logger.error(`Message handler error: ${err.message}`, "ServiceWorker");
      sendResponse({ error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});

// Clear tab state from session storage when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const key = getTabKey(tabId);
  chrome.storage.session.remove(key).catch(() => {});
});
