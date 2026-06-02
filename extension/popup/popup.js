// ScanLate v3 Popup Controller

document.addEventListener("DOMContentLoaded", async () => {
  // Elements
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.getElementById("status-text");
  const offlineOverlay = document.getElementById("offline-overlay");
  const profileSelect = document.getElementById("profile-select");
  const langSelect = document.getElementById("lang-select");
  const dialogueOnlyToggle = document.getElementById("dialogue-only-toggle");
  const btnTranslate = document.getElementById("btn-translate");
  const btnCancel = document.getElementById("btn-cancel");
  const btnToggleView = document.getElementById("btn-toggle-view");
  const toggleRow = document.getElementById("toggle-row");
  const statusCard = document.getElementById("status-card");
  const progressFill = document.getElementById("progress-bar-fill");
  const progressPercent = document.getElementById("status-progress-percent");
  const progressMsg = document.getElementById("status-progress-msg");
  const progressSub = document.getElementById("status-progress-sub");
  
  const btnRetry = document.getElementById("btn-retry");
  const btnOptions = document.getElementById("btn-options");
  const btnOptionsOffline = document.getElementById("btn-options-offline");
  const linkCreateProfile = document.getElementById("link-create-profile");



  // Get active tab context (allow popup to initialize connection check even if active tab is unavailable)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab ? activeTab.id : null;

  // Initialize and check server connection
  async function checkServerAndLoad() {
    statusText.textContent = "กำลังเชื่อมต่อ...";
    statusDot.className = "status-dot offline";
    btnTranslate.disabled = true;
    btnTranslate.classList.add("disabled");

    try {
      // Send query to service worker
      const response = await chrome.runtime.sendMessage({ action: "checkServer" });
      
      if (response && response.status && response.status.status === "online") {
        // Server is Online
        statusDot.className = "status-dot online";
        statusText.textContent = "เชื่อมต่อแล้ว";
        offlineOverlay.classList.add("hidden");
        
        // Populate profile selector
        const profiles = response.profiles || [];
        populateProfiles(profiles);
        
        // Restore tab state
        if (tabId) {
          await restoreTabState();
        }
      } else {
        // Server is Offline
        showOffline();
      }
    } catch (e) {
      console.error("Connection check failed:", e);
      showOffline();
    }
  }

  function showOffline() {
    statusDot.className = "status-dot offline";
    statusText.textContent = "ไม่ได้เชื่อมต่อ";
    offlineOverlay.classList.remove("hidden");
    btnTranslate.disabled = true;
    btnTranslate.classList.add("disabled");
  }

  function populateProfiles(profiles) {
    // Keep placeholder but clear other options
    profileSelect.innerHTML = '<option value="" disabled selected>-- เลือก Profile --</option>';
    
    profiles.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      profileSelect.appendChild(option);
    });
  }

  async function restoreTabState() {
    const res = await chrome.runtime.sendMessage({ action: "getTabState", tabId });
    if (res && res.state) {
      const state = res.state;
      
      // Restore selected profile
      if (state.profileName && profileSelect.querySelector(`option[value="${state.profileName}"]`)) {
        profileSelect.value = state.profileName;
      }
      
      // Restore language
      langSelect.value = state.sourceLang || "auto";
      
      if (state.dialogueOnly !== undefined) {
        dialogueOnlyToggle.checked = state.dialogueOnly;
      }

      // Adjust UI based on status
      updateUIStatus(state);
    }
  }

  function updateUIStatus(state) {
    const hasProfile = !!profileSelect.value;
    
    if (state.status === "translating") {
      // In progress
      profileSelect.disabled = true;
      langSelect.disabled = true;
      dialogueOnlyToggle.disabled = true;
      btnTranslate.disabled = true;
      btnTranslate.classList.add("disabled");
      btnTranslate.style.display = "none";
      btnCancel.classList.remove("hidden");
      btnCancel.style.display = "block";
      toggleRow.classList.add("hidden");
      statusCard.classList.remove("hidden");
      
      // Calculate progress
      const percent = state.totalCount > 0 ? Math.round((state.translatedCount / state.totalCount) * 100) : 0;
      progressFill.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;
      progressMsg.textContent = "⏳ กำลังดำเนินการแปล...";
      progressSub.textContent = `🚀 แปลเสร็จแล้ว ${state.translatedCount} ภาพ จากทั้งหมด ${state.totalCount} ภาพ`;
      
    } else {
      // Idle or completed
      profileSelect.disabled = false;
      langSelect.disabled = false;
      dialogueOnlyToggle.disabled = false;
      
      btnTranslate.disabled = false;
      btnTranslate.classList.remove("disabled");
      btnTranslate.style.display = "block";
      btnCancel.classList.add("hidden");
      btnCancel.style.display = "none";
      
      statusCard.classList.add("hidden");

      if (state.status === "completed") {
        toggleRow.classList.remove("hidden");
      } else {
        toggleRow.classList.add("hidden");
      }
    }
  }

  // Handle updates to profile/language controls
  async function saveControlsState() {
    if (!tabId) return;
    const profileName = profileSelect.value;
    const sourceLang = langSelect.value;
    const dialogueOnly = dialogueOnlyToggle.checked;
    const updates = { profileName, sourceLang, dialogueOnly };
    const res = await chrome.runtime.sendMessage({ action: "updateTabState", tabId, updates });
    if (res && res.state) {
      updateUIStatus(res.state);
    }
  }

  profileSelect.addEventListener("change", saveControlsState);
  langSelect.addEventListener("change", saveControlsState);
  dialogueOnlyToggle.addEventListener("change", saveControlsState);



  // Trigger Translation Command
  btnTranslate.addEventListener("click", async () => {
    if (!tabId) return;
    const profileName = profileSelect.value || "default";
    const sourceLang = langSelect.value;
    const dialogueOnly = dialogueOnlyToggle.checked;

    // 1. Update state to translating
    const updates = {
      status: "translating",
      translatedCount: 0,
      totalCount: 0
    };
    await chrome.runtime.sendMessage({ action: "updateTabState", tabId, updates });

    try {
      // 2. Instruct service worker to inject content script (if not already)
      await chrome.runtime.sendMessage({ action: "injectContentScript", tabId });

      // 3. Ping content script to start page scans
      await chrome.tabs.sendMessage(tabId, {
        action: "startTranslation",
        profileName,
        sourceLang,
        dialogueOnly
      });
      
    } catch (e) {
      console.error("Translation initiation failed:", e);
      // Reset state on failure
      await chrome.runtime.sendMessage({
        action: "updateTabState",
        tabId,
        updates: { status: "idle" }
      });
    }
  });

  // Cancel Translation Command
  btnCancel.addEventListener("click", async () => {
    if (!tabId) return;
    try {
        await chrome.runtime.sendMessage({ action: "cancelTranslation", tabId });
        chrome.tabs.sendMessage(tabId, { action: "cancelTranslation" }).catch(() => {});
        await chrome.runtime.sendMessage({
            action: "updateTabState",
            tabId,
            updates: { status: "idle" }
        });
    } catch (e) {
        console.error("Failed to cancel translation:", e);
    }
  });

  // Toggle translated overlays view
  btnToggleView.addEventListener("click", async () => {
    if (!tabId) return;
    try {
      chrome.tabs.sendMessage(tabId, { action: "toggleView" });
    } catch (e) {
      console.error("Failed to toggle view in tab:", e);
    }
  });

  // Listen for background state broadcasts (e.g. from page translation completion)
  chrome.runtime.onMessage.addListener((message) => {
    if (tabId && message.action === "tabStateChanged" && message.tabId === tabId) {
      updateUIStatus(message.state);
    }
  });

  // Page Redirection buttons
  btnRetry.addEventListener("click", checkServerAndLoad);
  
  btnOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  if (btnOptionsOffline) {
    btnOptionsOffline.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }

  linkCreateProfile.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const btnClearCache = document.getElementById("btn-clear-cache");
  if (btnClearCache) {
    btnClearCache.addEventListener("click", async () => {
      try {
        btnClearCache.innerHTML = "⏳ กำลังล้าง...";
        btnClearCache.style.color = "#a1a1aa";
        
        // Clear local browser cache (image translations) FIRST
        const allKeys = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(allKeys).filter(k => k.startsWith('scanlate_img_'));
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
        }
        
        // Also clear overlays on the active tab so the user sees it immediately
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { action: "clearOverlays" }).catch(() => {});
        }

        const response = await fetch("http://localhost:8745/cache/clear", { method: "POST" });
        
        if (response.ok) {
          btnClearCache.innerHTML = "✅ ล้างแคชสำเร็จ!";
          btnClearCache.style.color = "#10b981";
          setTimeout(() => {
            btnClearCache.innerHTML = "🗑️ ล้างแคช (Clear Cache)";
            btnClearCache.style.color = "#ef4444";
          }, 2000);
        } else {
          throw new Error("Server response not ok");
        }
      } catch (e) {
        btnClearCache.innerHTML = "❌ ล้างแคชล้มเหลว!";
        setTimeout(() => {
          btnClearCache.innerHTML = "🗑️ ล้างแคช (Clear Cache)";
          btnClearCache.style.color = "#ef4444";
        }, 2000);
      }
    });
  }

  // Run initial server check
  checkServerAndLoad();
});
