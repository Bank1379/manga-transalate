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
  let isTranslating = false;

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
        startPageTranslation(message.profileName, message.sourceLang, message.dialogueOnly);
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
        
      case "clearOverlays":
        clearAllOverlays();
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

  function clearAllOverlays() {
    currentOverlayContainers.forEach(container => container.remove());
    currentOverlayContainers = [];
    detectedImages.forEach(img => {
      delete img.dataset.scanlateCheckedCache;
    });
  }

  function cancelAllTranslations() {
    isTranslating = false;
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
      const width = Math.max(img.clientWidth || 0, img.naturalWidth || 0);
      const height = Math.max(img.clientHeight || 0, img.naturalHeight || 0);
      
      // Manga pages are typically > 300px wide and tall, but sliced webtoons can be smaller
      const isLargeEnough = width > 200 && height > 150;
      
      return isLargeEnough;
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
    let low = 10;
    let high = 80;
    let optimal = 11;
    
    // Create temporary offscreen element for measurement
    const measurer = document.createElement("div");
    measurer.className = "scanlate-measurer";
    measurer.style.width = `${boxWidth}px`;
    // Force CSS overrides to bypass browser cache and prevent breaking Thai words
    measurer.style.wordWrap = "normal";
    measurer.style.wordBreak = "normal";
    measurer.style.overflowWrap = "normal";
    
    renderTextWithNoBreak(measurer, text);
    document.body.appendChild(measurer);
    
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      measurer.style.fontSize = `${mid}px`;
      
      // We check if rendered height and width overflow coordinate boundaries
      // Relax height constraints (4.0x) because OCR bounding boxes are often very tight vertically, and Thai text has tall tone marks
      if (measurer.offsetHeight <= boxHeight * 4.0 && measurer.scrollWidth <= boxWidth * 1.1) {
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
      
      // 1. Color Sampling (Use backend colors if available to prevent CORS fallback to white)
      let colors;
      let isTextDark = true;
      
      if (box.text_color && box.text_color.bg && box.text_color.fg) {
        const bgLuma = (box.text_color.bg[0] * 0.299 + box.text_color.bg[1] * 0.587 + box.text_color.bg[2] * 0.114);
        const fgLuma = (box.text_color.fg[0] * 0.299 + box.text_color.fg[1] * 0.587 + box.text_color.fg[2] * 0.114);
        
        isTextDark = fgLuma < 128;
        
        // Force better contrast if background and text colors are too similar
        if (Math.abs(bgLuma - fgLuma) < 70) {
            if (isTextDark) {
                box.text_color.bg = [245, 245, 245]; // Make bg light
            } else {
                box.text_color.bg = [30, 30, 30]; // Make bg dark
            }
        }
        
        colors = {
          bg: `rgb(${box.text_color.bg[0]}, ${box.text_color.bg[1]}, ${box.text_color.bg[2]})`,
          fg: `rgb(${box.text_color.fg[0]}, ${box.text_color.fg[1]}, ${box.text_color.fg[2]})`
        };
      } else {
        colors = getBubbleColors(imgElement, minX, minY, maxX, maxY);
        // Simple heuristic for fallback (default is usually black text on white bg)
        isTextDark = true;
      }
      
      // Clean up translated text (strip leading/trailing ellipses and punctuation)
      let displayText = box.translated || "";
      displayText = displayText.replace(/^[\.…,\-~]*\s*/, '').replace(/\s*[\.…,\-~]*$/, '');
      
      // 2. Binary search optimal font size
      // Calculate responsive box dimensions in pixels
      const currentWidthPx = imgElement.clientWidth || naturalWidth;
      const currentHeightPx = imgElement.clientHeight || naturalHeight;
      const boxWidthPx = (widthPercent / 100) * currentWidthPx;
      const boxHeightPx = (heightPercent / 100) * currentHeightPx;
      const optimalFontSize = calculateOptimalFontSize(displayText, boxWidthPx, boxHeightPx);
      
      // 3. Render CSS Overlay bubble
      const bubble = document.createElement("div");
      bubble.className = "scanlate-bubble-overlay";
      if (debugMode) {
        bubble.classList.add("debug-active");
      }
      bubble.style.left = `${leftPercent}%`;
      bubble.style.top = `${topPercent}%`;
      bubble.style.width = `${widthPercent}%`;
      bubble.style.minHeight = `${heightPercent}%`;
      bubble.style.height = `auto`;
      bubble.style.backgroundColor = colors.bg;
      bubble.style.color = colors.fg;
      bubble.style.fontSize = `${optimalFontSize}px`;

      // Add strong text-shadow for better readability against any background
      const shadowColor = isTextDark ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.95)';
      bubble.style.textShadow = `-1px -1px 2px ${shadowColor}, 1px -1px 2px ${shadowColor}, -1px 1px 2px ${shadowColor}, 1px 1px 2px ${shadowColor}`;
      
      // Save base font size on the bubble element for proportional scaling on resize
      bubble._baseFontSize = optimalFontSize;
      bubble.dataset.index = index;
            // Feature: Right-click to open context menu
        bubble.addEventListener("contextmenu", (e) => {
          e.preventDefault(); // Prevent default browser right-click menu
          showBubbleContextMenu(bubble, e.clientX, e.clientY);
        });
        
        // Feature: Double-click to edit translation
      bubble.addEventListener("dblclick", (e) => {
        e.preventDefault();
        bubble.contentEditable = "true";
        bubble.focus();
        bubble.style.border = "1px dashed rgba(255,255,255,0.5)";
        
        // When losing focus, save and remove editable state
        bubble.addEventListener("blur", () => {
          bubble.contentEditable = "false";
          bubble.style.border = "none";
          // We could also save it back to cache here if needed, but visual edit is enough for reading
        }, { once: true });
      });
      
      // Multi-line center typography for manga text
      if (!box.translated) {
        bubble.innerHTML = '<span class="scanlate-dots" style="animation: pulse 1.5s infinite;">...</span>';
      } else if (!displayText) {
        bubble.style.display = "none"; // Hide completely if it was just punctuation
      } else {
        renderTextWithNoBreak(bubble, displayText);
      }
      
      // Rotate if text was vertical or angled
      if (box.angle && Math.abs(box.angle) > 5) {
        bubble.style.transform = `rotate(${box.angle}deg)`;
      }
      
      container.appendChild(bubble);
    });
  }

  // Floating UI
  let floatingToggleBtn = null;

  function ensureFloatingUI() {
    if (floatingToggleBtn) return;
    
    floatingToggleBtn = document.createElement("div");
    floatingToggleBtn.id = "scanlate-floating-toggle";
    floatingToggleBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    `;
    floatingToggleBtn.title = "สลับมุมมอง (แปล/ต้นฉบับ)";
    floatingToggleBtn.addEventListener("click", () => {
      toggleOverlaysView();
    });
    document.body.appendChild(floatingToggleBtn);
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
    
    // Update floating button visual state if it exists
    if (floatingToggleBtn) {
      if (isOverlaysVisible) {
        floatingToggleBtn.classList.remove("scanlate-dimmed");
      } else {
        floatingToggleBtn.classList.add("scanlate-dimmed");
      }
    }
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
        
        // Save successful translations to local cache
        if (streamState.texts && streamState.texts.length > 0) {
            const baseUrl = imageUrl.split('?')[0];
            const cacheKey = `scanlate_img_${baseUrl}`;
            chrome.storage.local.set({ [cacheKey]: streamState.texts }).catch(err => {
                console.warn(`ScanLate: Failed to save translation cache for ${baseUrl}`, err);
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

  // Helper to safely render text while preventing specific words from breaking
  function renderTextWithNoBreak(element, textContent) {
    element.innerHTML = ""; // Clear existing
    
    // We wrap all text in a single block-level inner div because the parent bubble
    // is a flex container (display: flex). Without this wrapper, every text node 
    // and span becomes a flex item, causing them to render side-by-side in columns.
    const wrapper = document.createElement("div");
    wrapper.style.width = "100%";
    wrapper.style.textWrap = "balance"; // Make text flow beautifully across multiple lines
    
    const NO_BREAK_TERMS = [
      "ไอเทม", "ไอเท็ม", "เวทมนตร์", "เวทย์", "สเตตัส", "สกิล", "สไลม์", "เลเวล", 
      "กิลด์", "เควสต์", "ปาร์ตี้", "ดันเจี้ยน", "ฮีโร่", "ผู้กล้า", "จอมมาร", "ดรอป", 
      "อัพเกรด", "อัปเกรด", "บอส", "โพชั่น", "คลาส", "แรงก์", "ดาเมจ", "แทงก์", 
      "แท็งก์", "ฮีลเลอร์", "มาสเตอร์", "สเตมิน่า", "มานา", "เอลฟ์", "ดวอร์ฟ", 
      "ก็อบลิน", "ออร์ค", "มอนสเตอร์", "สแตตัส", "ทักษะ", "ฉายา", "อาชีพ", "อีเวนต์",
      "สถานะ", "อาวุธ", "ชุดเกราะ", "เพลเยอร์", "ระบบ"
    ];
    const regex = new RegExp(`(${NO_BREAK_TERMS.join('|')})`, 'g');
    const parts = textContent.split(regex);
    
    for (const part of parts) {
      if (!part) continue;
      if (NO_BREAK_TERMS.includes(part)) {
        const span = document.createElement("span");
        span.style.whiteSpace = "nowrap";
        span.textContent = part;
        wrapper.appendChild(span);
      } else {
        wrapper.appendChild(document.createTextNode(part));
      }
    }
    
    element.appendChild(wrapper);
  }

  function updateBubbleText(imgElement, index, text) {
    const wrapper = imgElement.parentNode;
    if (!wrapper || !wrapper.classList.contains("scanlate-wrapper")) return;
    const container = wrapper.querySelector(".scanlate-overlay-container");
    if (!container) return;
    
    const bubble = container.querySelector(`.scanlate-bubble-overlay[data-index="${index}"]`);
    if (bubble) {
        // Clean up translated text (strip leading/trailing ellipses and punctuation)
        let displayText = text || "";
        displayText = displayText.replace(/^[\.…,\-~]*\s*/, '').replace(/\s*[\.…,\-~]*$/, '');
        
        if (!displayText) {
            bubble.style.display = "none";
            return;
        }
        bubble.style.display = ""; // Ensure it's visible
        
        // Calculate font size for the new text
        const naturalWidth = imgElement.naturalWidth || imgElement.clientWidth;
        const naturalHeight = imgElement.naturalHeight || imgElement.clientHeight;
        const currentWidthPx = imgElement.clientWidth || naturalWidth;
        const currentHeightPx = imgElement.clientHeight || naturalHeight;
        
        const widthPercent = parseFloat(bubble.style.width);
        const heightPercent = parseFloat(bubble.style.height);
        
        const boxWidthPx = (widthPercent / 100) * currentWidthPx;
        const boxHeightPx = (heightPercent / 100) * currentHeightPx;
        
        const optimalFontSize = calculateOptimalFontSize(displayText, boxWidthPx, boxHeightPx);
        bubble.style.fontSize = `${optimalFontSize}px`;
        bubble._baseFontSize = optimalFontSize;
        
        renderTextWithNoBreak(bubble, displayText);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // PIPELINE COORDINATOR
  // ──────────────────────────────────────────────────────────────────────

  async function startPageTranslation(profileName, sourceLang, dialogueOnly = false) {
    isTranslating = true;
    ensureFloatingUI();
    console.log(`ScanLate: Page translation started. Profile: ${profileName}, Lang: ${sourceLang}, DialogueOnly: ${dialogueOnly}`);
    
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
        "ocrProvider", "ocrModelSlug", "ocrApiKey",
        "llmProvider", "llmModel", "customModel",
        "googleApiKey", "openrouterKey", "openaiKey", "ollamaUrl"
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

    // Resolve LLM API key from storage to send with every request
    let llmProvider = "";
    let llmApiKey = "";
    let llmModel = "";
    try {
      const stored = await chrome.storage.local.get([
        "llmProvider", "llmModel", "customModel",
        "googleApiKey", "openrouterKey", "openaiKey", "ollamaUrl"
      ]);
      llmProvider = stored.llmProvider || "";
      
      llmModel = stored.llmModel || "";
      if (llmModel === "__custom__") {
          llmModel = stored.customModel || "";
      }
      
      if (llmProvider === "gemini")     llmApiKey = stored.googleApiKey  || "";
      else if (llmProvider === "openrouter") llmApiKey = stored.openrouterKey || "";
      else if (llmProvider === "openai")    llmApiKey = stored.openaiKey     || "";
      else if (llmProvider === "ollama")    llmApiKey = stored.ollamaUrl     || "";
    } catch (e) {
      console.warn("ScanLate: Could not read LLM key from storage");
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
    
    // Process images with a concurrency limit (2) to prevent saturating the browser's 
    // 6-connection limit per origin, which blocks /status and other UI network requests.
    const CONCURRENCY_LIMIT = 2;
    
    async function processImage(img, i) {
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
              dialogueOnly,
              ocrProvider,
              ocrModelSlug,
              ocrApiKey,
              llmProvider,
              llmModel,
              llmApiKey,
              imageIndex: i + 1,
              totalImages: detectedImages.length

            }).then(translateRes => {
              if (!translateRes || !translateRes.success) {
                 reject(new Error(translateRes ? translateRes.error : "Translation proxy returned error status"));
              } else if (!translateRes.streaming) {
                 // Fallback for non-streaming (older version compatibility)
                 if (currentTranslationStreams[src].loader) currentTranslationStreams[src].loader.remove();
                 const regions = translateRes.data.detected_texts || [];
                 renderTranslationOverlays(img, regions);
                 if (regions.length > 0) {
                     const baseUrl = src.split('?')[0];
                     chrome.storage.local.set({ [`scanlate_img_${baseUrl}`]: regions });
                 }
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
    }

    await new Promise((resolveAll) => {
      let activeTasks = 0;
      let currentIndex = 0;
      const processNext = () => {
        if (!isTranslating) return resolveAll();
        if (currentIndex >= detectedImages.length && activeTasks === 0) return resolveAll();
        
        while (activeTasks < CONCURRENCY_LIMIT && currentIndex < detectedImages.length && isTranslating) {
          const index = currentIndex++;
          activeTasks++;
          processImage(detectedImages[index], index).finally(() => {
            activeTasks--;
            processNext();
          });
        }
      };
      processNext();
    });

    // Complete pipeline
    chrome.runtime.sendMessage({
      action: "updateTabState",
      updates: {
        status: "completed",
        translatedCount: translatedCount
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // LOCAL CACHE AUTO-LOADER
  // ──────────────────────────────────────────────────────────────────────

  async function autoLoadTranslations() {
    const images = findMangaImages();
    if (images.length === 0) return;

    for (const img of images) {
        if (img.dataset.scanlateCheckedCache) continue;
        img.dataset.scanlateCheckedCache = "true";

        const src = img.currentSrc || img.src || img.getAttribute("data-src");
        if (!src) continue;
        const baseUrl = src.split('?')[0];
        const cacheKey = `scanlate_img_${baseUrl}`;

        try {
            const stored = await chrome.storage.local.get(cacheKey);
            if (stored[cacheKey] && stored[cacheKey].length > 0) {
                console.log(`ScanLate: Auto-loaded cached translation for ${baseUrl}`);
                renderTranslationOverlays(img, stored[cacheKey]);
            }
        } catch (e) {
            console.warn("ScanLate: Error reading cache for auto-load", e);
        }
    }
  }

  // Run on initial load
  setTimeout(autoLoadTranslations, 500);

  // Observe dynamically loaded images (infinite scrolling)
  let _scanlateDebounce = null;
  const domObserver = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (let m of mutations) {
          if (m.addedNodes.length > 0) {
              hasNewNodes = true;
              break;
          }
      }
      if (hasNewNodes) {
          clearTimeout(_scanlateDebounce);
          _scanlateDebounce = setTimeout(autoLoadTranslations, 1000);
      }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

})();

// ==========================================
// BUBBLE CONTEXT MENU
// ==========================================
let currentContextMenu = null;

function showBubbleContextMenu(bubble, x, y) {
  // Remove existing if any
  if (currentContextMenu) {
    currentContextMenu.remove();
  }

  const menu = document.createElement("div");
  menu.className = "scanlate-context-menu";
  
  // Convert RGB string to Hex for input[type='color']
  function rgbToHex(rgbStr) {
    const match = rgbStr.match(/\d+/g);
    if (!match || match.length < 3) return '#ffffff';
    return '#' + match.slice(0,3).map(x => {
      const hex = parseInt(x).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  const currentBg = rgbToHex(bubble.style.backgroundColor);
  const currentFg = rgbToHex(bubble.style.color);

  menu.innerHTML = `
    <div class="scanlate-context-menu-item" id="ctx-light">
      <span>☀️</span> <span>กรอบสว่าง (Light)</span>
    </div>
    <div class="scanlate-context-menu-item" id="ctx-dark">
      <span>🌙</span> <span>กรอบมืด (Dark)</span>
    </div>
    <div class="scanlate-context-menu-divider"></div>
    <div class="scanlate-color-picker-group">
      <label>🎨 พื้นหลัง</label>
      <input type="color" id="ctx-bg-color" value="${currentBg}">
    </div>
    <div class="scanlate-color-picker-group">
      <label>🎨 ตัวอักษร</label>
      <input type="color" id="ctx-fg-color" value="${currentFg}">
    </div>
    <div class="scanlate-context-menu-divider"></div>
    <div class="scanlate-context-menu-item" id="ctx-delete" style="color: #ef4444;">
      <span>🗑️</span> <span>ลบกรอบนี้</span>
    </div>
  `;

  // Position menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  document.body.appendChild(menu);
  currentContextMenu = menu;

  // Prevent click inside menu from closing it
  menu.addEventListener("click", (e) => e.stopPropagation());

  // Event Listeners
  menu.querySelector("#ctx-light").addEventListener("click", () => {
    bubble.style.backgroundColor = 'rgb(245, 245, 245)';
    bubble.style.color = 'rgb(30, 30, 30)';
    bubble.style.textShadow = '-1px -1px 2px rgba(255,255,255,0.95), 1px -1px 2px rgba(255,255,255,0.95), -1px 1px 2px rgba(255,255,255,0.95), 1px 1px 2px rgba(255,255,255,0.95)';
  });

  menu.querySelector("#ctx-dark").addEventListener("click", () => {
    bubble.style.backgroundColor = 'rgb(30, 30, 30)';
    bubble.style.color = 'rgb(245, 245, 245)';
    bubble.style.textShadow = '-1px -1px 2px rgba(0,0,0,0.95), 1px -1px 2px rgba(0,0,0,0.95), -1px 1px 2px rgba(0,0,0,0.95), 1px 1px 2px rgba(0,0,0,0.95)';
  });

  menu.querySelector("#ctx-bg-color").addEventListener("input", (e) => {
    bubble.style.backgroundColor = e.target.value;
  });

  menu.querySelector("#ctx-fg-color").addEventListener("input", (e) => {
    bubble.style.color = e.target.value;
  });

  menu.querySelector("#ctx-delete").addEventListener("click", () => {
    bubble.remove();
    menu.remove();
    currentContextMenu = null;
  });
}

// Close context menu when clicking outside
document.addEventListener("click", (e) => {
  if (currentContextMenu && !currentContextMenu.contains(e.target)) {
    currentContextMenu.remove();
    currentContextMenu = null;
  }
});
