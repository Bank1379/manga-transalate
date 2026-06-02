// ScanLate v3 Content Script - Page Scanner & Client-side Renderer

(function() {
  // Prevent double injection
  if (window.hasScanLateInjected) {
    return;
  }
  window.hasScanLateInjected = true;

  console.log("⚡ ScanLate v3 Content Script Injected.");

  // Global variables
  let currentOverlayContainers = [];
  let isOverlaysVisible = true;
  let detectedImages = [];
  let debugMode = false;

  // Global ResizeObserver to dynamically scale font size on browser resize
  const resizeObserver = new ResizeObserver(entries => {
    for (let entry of entries) {
      const wrapper = entry.target;
      const img = wrapper.querySelector("img");
      if (!img) continue;
      
      const initialWidth = wrapper._initialWidth;
      if (!initialWidth) continue;

      const currentWidth = img.clientWidth;
      const scale = currentWidth / initialWidth;
      
      const bubbles = wrapper.querySelectorAll(".scanlate-bubble-overlay");
      bubbles.forEach(bubble => {
        if (bubble._baseFontSize) {
          bubble.style.fontSize = `${Math.max(6, bubble._baseFontSize * scale)}px`;
        }
      });
    }
  });

  // Listen for messages from service worker or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "ping":
        sendResponse({ pong: true });
        break;

      case "startTranslation":
        startPageTranslation(message.profileName, message.sourceLang, message.debugMode);
        sendResponse({ success: true });
        break;

      case "toggleView":
        toggleOverlaysView();
        sendResponse({ success: true, visible: isOverlaysVisible });
        break;

      case "setDebugMode":
        setDebugMode(message.debugMode);
        sendResponse({ success: true });
        break;
        
      case "cancelTranslation":
        cancelAllTranslations();
        sendResponse({ success: true });
        break;
        
      default:
        break;
    }
    return true;
  });

  // Toggle debug classes on all active bubbles
  function setDebugMode(active) {
    debugMode = !!active;
    const bubbles = document.querySelectorAll(".scanlate-bubble-overlay");
    bubbles.forEach(bubble => {
      if (debugMode) {
        bubble.classList.add("debug-active");
      } else {
        bubble.classList.remove("debug-active");
      }
    });
  }

  function cancelAllTranslations() {
    console.log("ScanLate: Cancelling all translations...");
    for (const url in currentTranslationStreams) {
        const streamState = currentTranslationStreams[url];
        if (streamState.reject) {
            streamState.reject(new Error("Translation cancelled by user"));
        }
    }
    chrome.runtime.sendMessage({
      action: "updateTabState",
      updates: { status: "idle" }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // IMAGE DETECTION
  // ──────────────────────────────────────────────────────────────────────

  function findMangaImages() {
    // Scan all images on the page
    const imgs = Array.from(document.querySelectorAll("img"));
    
    // Filter based on size criteria (typically manga pages are vertical and large)
    return imgs.filter(img => {
      // Ignore tiny icons, badges, UI elements
      const width = img.clientWidth || img.naturalWidth || 0;
      const height = img.clientHeight || img.naturalHeight || 0;
      
      // Manga pages are typically > 500px wide, and height > width
      const isLargeEnough = width > 500 && height > 400;
      const isNotAlreadyOverlay = !img.closest(".scanlate-wrapper");
      
      return isLargeEnough && isNotAlreadyOverlay;
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // RENDERING & CLEANING ENGINE
  // ──────────────────────────────────────────────────────────────────────

  // Wrap target image to attach relative positioning overlays
  function wrapMangaImage(imgElement) {
    if (imgElement.parentElement.classList.contains("scanlate-wrapper")) {
      return imgElement.parentElement;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "scanlate-wrapper";
    
    // Copy visual display layouts from the image to wrapper to prevent breaking target site design
    const computedStyle = window.getComputedStyle(imgElement);
    wrapper.style.position = "relative";
    wrapper.style.display = computedStyle.display === "inline" ? "inline-block" : computedStyle.display;
    wrapper.style.margin = computedStyle.margin;
    wrapper.style.padding = computedStyle.padding;
    wrapper.style.float = computedStyle.float;
    wrapper.style.width = "100%";
    wrapper.style.maxWidth = `${imgElement.clientWidth || imgElement.naturalWidth}px`;
    wrapper.style.height = "auto";
    
    // Insert wrapper in DOM
    imgElement.parentNode.insertBefore(wrapper, imgElement);
    wrapper.appendChild(imgElement);
    
    // Apply responsive rule to child image
    imgElement.style.width = "100%";
    imgElement.style.height = "auto";
    imgElement.style.maxWidth = "100%";
    imgElement.style.margin = "0";
    imgElement.style.padding = "0";

    // Begin observing resize
    resizeObserver.observe(wrapper);

    return wrapper;
  }

  // Canvas sampling: Determine bubble background color and contrast text color
  function getBubbleColors(imgElement, minX, minY, maxX, maxY) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    canvas.width = width;
    canvas.height = height;
    
    try {
      // Draw image region onto temporary canvas
      ctx.drawImage(imgElement, minX, minY, width, height, 0, 0, width, height);
      const imgData = ctx.getImageData(0, 0, width, height);
      const data = imgData.data;
      
      const borderColors = [];
      
      // Sample along borders (edges of speech bubbles are normally plain background)
      const samplePixel = (x, y) => {
        const idx = (y * width + x) * 4;
        return [data[idx], data[idx+1], data[idx+2]];
      };
      
      // Sample horizontal borders
      for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 8))) {
        borderColors.push(samplePixel(x, 0));
        borderColors.push(samplePixel(x, height - 1));
      }
      // Sample vertical borders
      for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 8))) {
        borderColors.push(samplePixel(0, y));
        borderColors.push(samplePixel(width - 1, y));
      }
      
      // Sort colors by brightness (luminance) to calculate median color
      // Luminance = 0.299R + 0.587G + 0.114B
      const getLuminance = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      borderColors.sort((a, b) => getLuminance(a) - getLuminance(b));
      
      // Find median background RGB
      const medianRgb = borderColors[Math.floor(borderColors.length / 2)] || [255, 255, 255];
      const luminance = getLuminance(medianRgb);
      
      // Contrasting text color (black for white bubble, white for dark bubble)
      const textColor = luminance > 130 ? [0, 0, 0] : [255, 255, 255];
      
      return {
        bg: `rgb(${medianRgb[0]}, ${medianRgb[1]}, ${medianRgb[2]})`,
        fg: `rgb(${textColor[0]}, ${textColor[1]}, ${textColor[2]})`
      };
    } catch (e) {
      console.warn("Canvas reading blocked by CORS rules. Falling back to default bubble styling.");
      // Fallback: Default to solid white bubble with black text if CORS blocks reading image pixels
      return {
        bg: "rgb(255, 255, 255)",
        fg: "rgb(0, 0, 0)"
      };
    }
  }

  // Binary search auto-font sizing to fit speech text inside box boundaries
  function calculateOptimalFontSize(text, boxWidth, boxHeight) {
    let low = 7;
    let high = 80;
    let optimal = 11;
    
    // Create temporary offscreen element for measurement
    const measurer = document.createElement("div");
    measurer.className = "scanlate-measurer";
    measurer.style.width = `${boxWidth}px`;
    measurer.innerText = text;
    document.body.appendChild(measurer);
    
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      measurer.style.fontSize = `${mid}px`;
      
      // We check if rendered height overflows coordinate boundaries
      if (measurer.offsetHeight <= boxHeight) {
        optimal = mid;
        low = mid + 1; // Try bigger font size
      } else {
        high = mid - 1; // Try smaller font size
      }
    }
    
    document.body.removeChild(measurer);
    return optimal;
  }

  // Create absolute overlay layer over image
  function renderTranslationOverlays(imgElement, detectedTexts) {
    const wrapper = wrapMangaImage(imgElement);
    
    // Clear old container if exists
    const oldContainer = wrapper.querySelector(".scanlate-overlay-container");
    if (oldContainer) {
      oldContainer.remove();
    }
    
    const container = document.createElement("div");
    container.className = "scanlate-overlay-container";
    if (!isOverlaysVisible) {
      container.classList.add("hidden");
    }
    wrapper.appendChild(container);
    currentOverlayContainers.push(container);
    
    const naturalWidth = imgElement.naturalWidth || imgElement.clientWidth;
    const naturalHeight = imgElement.naturalHeight || imgElement.clientHeight;
    
    // Set initial size details for proportional font scaling on resize
    wrapper._initialWidth = imgElement.clientWidth || naturalWidth;
    
    detectedTexts.forEach((box, index) => {
      let [minX, minY, maxX, maxY] = box.bbox;
      
      // Inflate bounding box slightly to ensure original text is fully covered
      const paddingX = 8;
      const paddingY = 6;
      minX = Math.max(0, minX - paddingX);
      minY = Math.max(0, minY - paddingY);
      maxX = Math.min(naturalWidth, maxX + paddingX);
      maxY = Math.min(naturalHeight, maxY + paddingY);

      const widthPercent = ((maxX - minX) / naturalWidth) * 100;
      const heightPercent = ((maxY - minY) / naturalHeight) * 100;
      const leftPercent = (minX / naturalWidth) * 100;
      const topPercent = (minY / naturalHeight) * 100;
      
      // 1. Color Sampling (Clean bubble)
      const colors = getBubbleColors(imgElement, minX, minY, maxX, maxY);
      
      // 2. Binary search optimal font size
      // Calculate responsive box dimensions in pixels
      const currentWidthPx = imgElement.clientWidth || naturalWidth;
      const currentHeightPx = imgElement.clientHeight || naturalHeight;
      const boxWidthPx = (widthPercent / 100) * currentWidthPx;
      const boxHeightPx = (heightPercent / 100) * currentHeightPx;
      const optimalFontSize = calculateOptimalFontSize(box.translated, boxWidthPx, boxHeightPx);
      
      // 3. Render CSS Overlay bubble
      const bubble = document.createElement("div");
      bubble.className = "scanlate-bubble-overlay";
      if (debugMode) {
        bubble.classList.add("debug-active");
      }
      bubble.style.left = `${leftPercent}%`;
      bubble.style.top = `${topPercent}%`;
      bubble.style.width = `${widthPercent}%`;
      bubble.style.height = `${heightPercent}%`;
      bubble.style.backgroundColor = colors.bg;
      bubble.style.color = colors.fg;
      bubble.style.fontSize = `${optimalFontSize}px`;
      
      // Save base font size on the bubble element for proportional scaling on resize
      bubble._baseFontSize = optimalFontSize;
      bubble.dataset.index = index;
      
      // Multi-line center typography for manga text
      if (!box.translated) {
        bubble.innerHTML = '<span class="scanlate-dots" style="animation: pulse 1.5s infinite;">...</span>';
      } else {
        bubble.innerText = box.translated;
      }
      
      // Rotate if text was vertical or angled
      if (box.angle && Math.abs(box.angle) > 5) {
        bubble.style.transform = `rotate(${box.angle}deg)`;
      }
      
      container.appendChild(bubble);
    });
  }

  // Toggle visible states
  function toggleOverlaysView() {
    isOverlaysVisible = !isOverlaysVisible;
    currentOverlayContainers.forEach(container => {
      if (isOverlaysVisible) {
        container.classList.remove("hidden");
      } else {
        container.classList.add("hidden");
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // STREAMING HANDLERS
  // ──────────────────────────────────────────────────────────────────────
  let currentTranslationStreams = {}; // imageUrl -> stream state

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "translateStreamEvent") {
      const { imageUrl, event } = message;
      const streamState = currentTranslationStreams[imageUrl];
      if (!streamState) return;

      if (event.type === "metadata") {
        if (streamState.loader) {
            streamState.loader.remove();
            streamState.loader = null;
        }
        renderTranslationOverlays(streamState.img, event.regions);
        streamState.texts = event.regions;
      } else if (event.type === "translation") {
        const index = event.index;
        const text = event.text;
        
        if (streamState.texts && streamState.texts[index]) {
            streamState.texts[index].translated = text;
            updateBubbleText(streamState.img, index, text);
        }
      } else if (event.type === "done") {
        if (streamState.loader) streamState.loader.remove();
        
        // Fallback: If real-time translation chunks were dropped, update using the final payload
        if (event.translations && streamState.texts) {
            event.translations.forEach((text, index) => {
                if (text && streamState.texts[index] && !streamState.texts[index].translated) {
                    streamState.texts[index].translated = text;
                    updateBubbleText(streamState.img, index, text);
                }
            });
        }
        
        delete currentTranslationStreams[imageUrl];
        if (streamState.resolve) streamState.resolve();
      } else if (event.type === "error" || event.type === "stream_closed") {
        if (streamState.loader) streamState.loader.remove();
        delete currentTranslationStreams[imageUrl];
        if (streamState.reject) streamState.reject(new Error(event.message || "Translation interrupted by server disconnection"));
      }
    }
  });

  function updateBubbleText(imgElement, index, text) {
    const wrapper = imgElement.parentNode;
    if (!wrapper || !wrapper.classList.contains("scanlate-wrapper")) return;
    const container = wrapper.querySelector(".scanlate-overlay-container");
    if (!container) return;
    
    const bubble = container.querySelector(`.scanlate-bubble-overlay[data-index="${index}"]`);
    if (bubble) {
        // Calculate font size for the new text
        const naturalWidth = imgElement.naturalWidth || imgElement.clientWidth;
        const naturalHeight = imgElement.naturalHeight || imgElement.clientHeight;
        const currentWidthPx = imgElement.clientWidth || naturalWidth;
        const currentHeightPx = imgElement.clientHeight || naturalHeight;
        
        const widthPercent = parseFloat(bubble.style.width);
        const heightPercent = parseFloat(bubble.style.height);
        
        const boxWidthPx = (widthPercent / 100) * currentWidthPx;
        const boxHeightPx = (heightPercent / 100) * currentHeightPx;
        
        const optimalFontSize = calculateOptimalFontSize(text, boxWidthPx, boxHeightPx);
        bubble.style.fontSize = `${optimalFontSize}px`;
        bubble._baseFontSize = optimalFontSize;
        
        if (!text) {
            bubble.innerHTML = '<span class="scanlate-dots" style="animation: pulse 1.5s infinite;">...</span>';
        } else {
            bubble.innerText = text;
        }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PIPELINE COORDINATOR
  // ──────────────────────────────────────────────────────────────────────

  async function startPageTranslation(profileName, sourceLang) {
    console.log(`ScanLate: Page translation started. Profile: ${profileName}, Lang: ${sourceLang}`);
    
    // Read debug mode from storage
    const debugStored = await chrome.storage.local.get("debugMode");
    debugMode = !!debugStored.debugMode;
    
    detectedImages = findMangaImages();
    // Sort by vertical position on page so top images are translated first (reading order)
    detectedImages.sort((a, b) => {
      const aTop = a.getBoundingClientRect().top + window.scrollY;
      const bTop = b.getBoundingClientRect().top + window.scrollY;
      return aTop - bTop;
    });
    if (detectedImages.length === 0) {
      console.log("ScanLate: No suitable manga images detected.");
      chrome.runtime.sendMessage({
        action: "updateTabState",
        updates: { status: "idle" }
      });
      return;
    }

    // Read OCR and Advanced settings from Chrome Storage (set in Settings page)
    let ocrModel = "48px";
    let useMultimodal = false;
    let useGeminiOcr = false;
    let useAutoGlossary = false;
    let ocrProvider = "openrouter";
    let ocrModelSlug = "google/gemini-2.5-flash";
    let ocrApiKey = "";
    try {
      const stored = await chrome.storage.local.get([
        "ocrModel", "useGeminiOcr", "useMultimodal", "useAutoGlossary",
        "ocrProvider", "ocrModelSlug", "ocrApiKey"
      ]);
      if (stored.ocrModel) ocrModel = stored.ocrModel;
      useMultimodal = !!stored.useMultimodal;
      useGeminiOcr = stored.useGeminiOcr !== undefined ? !!stored.useGeminiOcr : true;
      useAutoGlossary = !!stored.useAutoGlossary;
      if (stored.ocrProvider)   ocrProvider   = stored.ocrProvider;
      if (stored.ocrModelSlug)  ocrModelSlug  = stored.ocrModelSlug;
      if (stored.ocrApiKey)     ocrApiKey     = stored.ocrApiKey;
    } catch (e) {
      console.warn("ScanLate: Could not read settings from storage, using defaults");
    }
    console.log(`ScanLate: Gemini OCR: ${useGeminiOcr} (Model: ${ocrModel}), Multimodal: ${useMultimodal}, Auto Glossary: ${useAutoGlossary}`);

    
    // Update background session total image counts
    chrome.runtime.sendMessage({
      action: "updateTabState",
      updates: {
        status: "translating",
        translatedCount: 0,
        totalCount: detectedImages.length
      }
    });

    let translatedCount = 0;
    
    // Process all images concurrently. 
    // The browser's connection limit (usually 6) and the backend's OCR semaphore 
    // will naturally pipeline the requests (OCR -> LLM Stream) without exploding VRAM.
    const translationPromises = detectedImages.map(async (img, i) => {
      const src = img.currentSrc || img.src || img.getAttribute("data-src");
      if (!src) {
        console.warn(`ScanLate: Skipping image at index ${i} because it has no source URL.`);
        return;
      }
      
      // Add visual loader spinner overlay on top of image
      const wrapper = wrapMangaImage(img);
      const loader = document.createElement("div");
      loader.className = "scanlate-image-loader";
      loader.innerHTML = `
        <div class="scanlate-spinner"></div>
        <div class="scanlate-loader-text">กำลังแปลรูปที่ ${i + 1}/${detectedImages.length}...</div>
      `;
      wrapper.appendChild(loader);

      try {
        await new Promise((resolve, reject) => {
            currentTranslationStreams[src] = {
                img: img,
                resolve: resolve,
                reject: reject,
                loader: loader
            };

            chrome.runtime.sendMessage({
              action: "translateImage",
              imageUrl: src,
              sourceLang,
              profileName,
              ocrModel,
              useMultimodal,
              useGeminiOcr,
              useAutoGlossary,
              ocrProvider,
              ocrModelSlug,
              ocrApiKey,
              imageIndex: i + 1,
              totalImages: detectedImages.length

            }).then(translateRes => {
              if (!translateRes || !translateRes.success) {
                 reject(new Error(translateRes ? translateRes.error : "Translation proxy returned error status"));
              } else if (!translateRes.streaming) {
                 // Fallback for non-streaming (older version compatibility)
                 if (currentTranslationStreams[src].loader) currentTranslationStreams[src].loader.remove();
                 renderTranslationOverlays(img, translateRes.data.detected_texts || []);
                 resolve();
              }
            }).catch(reject);
        });
        
        // Increment and broadcast success
        translatedCount++;
        chrome.runtime.sendMessage({
          action: "updateTabState",
          updates: {
            translatedCount: translatedCount
          }
        });
        
      } catch (err) {
        console.error(`ScanLate: Failed to translate image index ${i}:`, err);
        if (loader.parentNode) loader.remove();
      }
    });

    await Promise.all(translationPromises);

    // Complete pipeline
    chrome.runtime.sendMessage({
      action: "updateTabState",
      updates: {
        status: "completed",
        translatedCount: translatedCount
      }
    });
  }

})();
