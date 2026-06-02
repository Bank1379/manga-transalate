/**
 * ScanLate v3 — Settings Page Logic
 * Manages LLM provider/model selection, API key storage, server config, profiles & OCR settings
 */

// Shared Edition Settings

// ─────────────────────────────────────────────
// DOM Helpers
// ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove("hidden");
const hide = (el) => el?.classList.add("hidden");

function showToast(msg, isError = false) {
  const toast = $("toast");
  const toastMsg = $("toast-msg");
  const toastIcon = toast.querySelector(".toast-icon");
  toast.classList.remove("hidden", "error");
  if (isError) toast.classList.add("error");
  toastIcon.textContent = isError ? "❌" : "✅";
  toastMsg.textContent = msg;
  toast.style.animation = "none";
  toast.offsetHeight; // force reflow
  toast.style.animation = "";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => hide(toast), 3000);
}

// ─────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────
function initNav() {
  document.querySelectorAll(".nav-item").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const sectionId = link.dataset.section;
      document.querySelectorAll(".nav-item").forEach(l => l.classList.remove("active"));
      document.querySelectorAll(".settings-section").forEach(s => s.classList.remove("active"));
      link.classList.add("active");
      $(sectionId)?.classList.add("active");
    });
  });
}

// Removed Cost Calculator and Provider Switching

// ─────────────────────────────────────────────
// Eye Toggle (show/hide password)
// ─────────────────────────────────────────────
function initEyeToggles() {
  document.querySelectorAll(".btn-eye").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.target);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁️" : "🙈";
    });
  });
}

// ─────────────────────────────────────────────
// Chrome Storage Helpers
// ─────────────────────────────────────────────
async function loadFromStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

async function saveToStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

// ─────────────────────────────────────────────
// Load Saved Settings
// ─────────────────────────────────────────────
async function loadSettings() {
  const data = await loadFromStorage([
    "clientAccessKey",
    "serverUrl", "ocrModel",
    "useMultimodal", "useGeminiOcr", "useAutoGlossary"
  ]);

  if (data.clientAccessKey) $("input-client-access-key").value = data.clientAccessKey;

  // Server
  $("input-server-url").value = data.serverUrl || "http://127.0.0.1:8745";

  // OCR (local model)
  if (data.ocrModel) {
    const radio = document.querySelector(`input[name="ocr-model"][value="${data.ocrModel}"]`);
    if (radio) radio.checked = true;
  }

  // OCR (Gemini OCR Toggle)
  if (data.useGeminiOcr !== undefined) {
    const toggle = $("toggle-gemini-ocr");
    if (toggle) toggle.checked = data.useGeminiOcr;
  }

  // Advanced
  if (data.useMultimodal !== undefined) $("toggle-multimodal").checked = data.useMultimodal;
  if (data.useAutoGlossary !== undefined) $("toggle-auto-glossary").checked = data.useAutoGlossary;

  // Update Visibility
  updateOcrEngineVisibility();

  return data;
}

// ─────────────────────────────────────────────
// Save Access Key
// ─────────────────────────────────────────────
async function saveAccessKey() {
  const key = $("input-client-access-key").value.trim();
  await saveToStorage({ clientAccessKey: key });
  showToast("✨ บันทึก Access Key แล้ว");
}

// ─────────────────────────────────────────────
// Save Server Settings
// ─────────────────────────────────────────────
async function saveServerSettings() {
  const url = $("input-server-url").value.trim();
  if (!url) { showToast("กรุณาใส่ Server URL", true); return; }
  await saveToStorage({ serverUrl: url });
  showToast("บันทึก Server URL แล้ว");
  refreshServerStatus();
}

// ─────────────────────────────────────────────
// Server Status
// ─────────────────────────────────────────────
async function refreshServerStatus() {
  const url = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
  const dot  = $("server-pill").querySelector(".pill-dot");
  const pill = $("pill-text");

  dot.className = "pill-dot loading";
  pill.textContent = "กำลังเชื่อมต่อ...";

  try {
    const resp = await fetch(`${url}/status`, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) throw new Error("not ok");
    const data = await resp.json();

    dot.className = "pill-dot online";
    pill.textContent = "Online";

    const engine = data.engine || {};
    const sys    = data.system || {};
    const gpu    = data.gpu   || {};

    $("sv-status").textContent = "🟢 Online";
    $("sv-status").className   = "status-value online";
    $("sv-engine").textContent = engine.healthy ? "Ready ✅" : (engine.running ? "Starting..." : "Offline");
    $("sv-cpu").textContent    = sys.cpu_usage_percent != null ? `${sys.cpu_usage_percent.toFixed(1)}%` : "—";
    $("sv-ram").textContent    = sys.ram_used_gb       != null ? `${sys.ram_used_gb.toFixed(1)} GB` : "—";
    $("sv-gpu").textContent    = gpu.device_name       || (gpu.cuda_available ? "GPU" : "CPU only");
    $("sv-vram").textContent   = gpu.vram_allocated_mb != null ? `${(gpu.vram_allocated_mb/1024).toFixed(1)} GB` : "—";
  } catch {
    dot.className = "pill-dot offline";
    pill.textContent = "Offline";
    $("sv-status").textContent = "🔴 Offline";
    $("sv-status").className   = "status-value offline";
    ["sv-engine","sv-cpu","sv-ram","sv-gpu","sv-vram"].forEach(id => { $(id).textContent = "—"; });
  }
}

// ─────────────────────────────────────────────
// Save OCR Settings
// ─────────────────────────────────────────────
async function saveOCRSettings() {
  const ocrModel = document.querySelector("input[name='ocr-model']:checked")?.value || "48px";
  const useGeminiOcr = $("toggle-gemini-ocr")?.checked || false;
  await saveToStorage({ ocrModel, useGeminiOcr });
  showToast(`บันทึก OCR Settings แล้ว`);
}

function updateOcrEngineVisibility() {
  const useGeminiOcr = $("toggle-gemini-ocr")?.checked || false;
  
  // Show/hide Local Model selector (Hide if using Gemini OCR)
  const mitCard = $("card-mit-model");
  const llmActiveCard = $("card-ocr-llm-active");
  if (mitCard) {
    mitCard.style.display = useGeminiOcr ? "none" : "block";
  }
  if (llmActiveCard) {
    llmActiveCard.style.display = useGeminiOcr ? "block" : "none";
  }
  
  // Show/hide LLM OCR config (Show if using Gemini OCR)
  const llmSubSettings = $("ocr-sub-settings");
  if (llmSubSettings) {
    if (useGeminiOcr) {
      llmSubSettings.classList.add("open");
      llmSubSettings.style.display = "block";
    } else {
      llmSubSettings.classList.remove("open");
      // Optional: Wait for transition before hiding completely
      setTimeout(() => { if (!llmSubSettings.classList.contains("open")) llmSubSettings.style.display = "none"; }, 400);
    }
  }
}

// Add listener for Gemini OCR Toggle
const toggleGeminiOcr = $("toggle-gemini-ocr");
if (toggleGeminiOcr) {
  toggleGeminiOcr.addEventListener("change", () => {
    updateOcrEngineVisibility();
    saveOCRSettings();
  });
}

function initAdvancedFeatures() {
  $("btn-save-advanced").addEventListener("click", saveAdvancedSettings);

  $("toggle-multimodal").addEventListener("change", saveAdvancedSettings);
  $("toggle-auto-glossary").addEventListener("change", saveAdvancedSettings);
}

// ─────────────────────────────────────────────
// Save Advanced Settings
// ─────────────────────────────────────────────
async function saveAdvancedSettings() {
  await saveToStorage({
    useMultimodal:   $("toggle-multimodal").checked,
    useAutoGlossary: $("toggle-auto-glossary").checked
  });
  showToast("บันทึก Advanced Settings แล้ว");
}

// ─────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────
async function loadProfiles() {
  const serverUrl = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
  const list = $("profiles-list");
  list.innerHTML = `<div class="profile-empty">กำลังโหลด...</div>`;
  try {
    const resp = await fetch(`${serverUrl}/profiles`);
    const data = await resp.json();
    const profiles = data.profiles || [];
    if (profiles.length === 0) {
      list.innerHTML = `<div class="profile-empty">ยังไม่มี Profile — กด "+ สร้างใหม่" เพื่อเพิ่ม</div>`;
      return;
    }
    list.innerHTML = profiles.map(p => {
      const autoProfiles = data.auto_profiles || [];
      const isAuto = autoProfiles.includes(p);
      const tag = isAuto
        ? `<span class="profile-tag profile-tag-auto">✨ Auto Glossary</span>`
        : `<span class="profile-tag profile-tag-manual">✍️ Manual</span>`;
      return `
        <div class="profile-item">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="profile-name">📋 ${p}</span>
            ${tag}
          </div>
          <div class="profile-actions">
            <button class="btn-secondary" data-profile="${p}">✏️ แก้ไข</button>
          </div>
        </div>
      `;
    }).join("");
  } catch {
    list.innerHTML = `<div class="profile-empty">⚠️ ไม่สามารถโหลด Profiles ได้ (Server ออฟไลน์?)</div>`;
  }
}


async function editProfile(name) {
  const serverUrl = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
  try {
    const resp = await fetch(`${serverUrl}/profiles/${encodeURIComponent(name)}`);
    const data = await resp.json();
    $("profile-name-input").value = name;
    $("profile-content").value = data.content || "";
    show($("profile-editor"));
  } catch {
    showToast("ไม่สามารถโหลด Profile ได้", true);
  }
}

async function saveProfile() {
  const name    = $("profile-name-input").value.trim();
  const content = $("profile-content").value;
  if (!name) { showToast("กรุณาใส่ชื่อ Profile", true); return; }
  const serverUrl = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
  try {
    const resp = await fetch(`${serverUrl}/profiles/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!resp.ok) throw new Error("Save failed");
    showToast(`บันทึก Profile "${name}" แล้ว`);
    hide($("profile-editor"));
    loadProfiles();
  } catch {
    showToast("บันทึก Profile ไม่สำเร็จ", true);
  }
}

function initProfiles() {
  $("btn-new-profile").addEventListener("click", () => {
    $("profile-name-input").value = "";
    $("profile-content").value = "";
    show($("profile-editor"));
    $("profile-name-input").focus();
  });

  $("btn-close-editor").addEventListener("click", () => {
    hide($("profile-editor"));
  });

  $("btn-save-profile").addEventListener("click", saveProfile);

  // Event delegation for dynamically-rendered Edit buttons (MV3 CSP blocks inline onclick)
  $("profiles-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-profile]");
    if (btn) editProfile(btn.dataset.profile);
  });

  // Load when Profiles section is shown
  document.querySelector("[data-section='section-profiles']")?.addEventListener("click", () => {
    loadProfiles();
  });
}

// ─────────────────────────────────────────────
// Debug Logs
// ─────────────────────────────────────────────
function initDebugLogs() {
  const chkDebugMode = $("chk-debug-mode");
  const btnClearLogs = $("btn-clear-logs");
  const logEntries = $("log-entries");
  const debugLogConsole = $("debug-log-console");
  let logInterval = null;

  async function updateLogs() {
    try {
      const response = await chrome.runtime.sendMessage({ action: "getDebugLogs" });
      if (response && response.success && response.logs) {
        // Only update if the number of logs has changed or we want to redraw
        logEntries.innerHTML = "";
        response.logs.forEach(log => {
          const div = document.createElement("div");
          div.className = "log-entry";
          
          if (log.includes("[ERROR]")) {
            div.className += " log-entry-error";
            div.style.color = "#ff4d4f";
          } else if (log.includes("[WARN]")) {
            div.className += " log-entry-warn";
            div.style.color = "#faad14";
          } else {
            div.className += " log-entry-info";
            div.style.color = "#4caf50";
          }
          
          div.textContent = log;
          logEntries.appendChild(div);
        });
        
        // Auto scroll
        debugLogConsole.scrollTop = debugLogConsole.scrollHeight;
      }
    } catch (e) {
      console.error("Log fetch error:", e);
    }
  }

  function startLogPolling() {
    if (logInterval) clearInterval(logInterval);
    updateLogs();
    logInterval = setInterval(updateLogs, 1000);
  }

  function stopLogPolling() {
    if (logInterval) {
      clearInterval(logInterval);
      logInterval = null;
    }
  }

  if (chkDebugMode) {
    chkDebugMode.addEventListener("change", async () => {
      const debugMode = chkDebugMode.checked;
      if (debugMode) {
        debugLogConsole.classList.remove("hidden");
        debugLogConsole.style.display = "block";
        startLogPolling();
      } else {
        debugLogConsole.classList.add("hidden");
        debugLogConsole.style.display = "none";
        stopLogPolling();
      }

      // Save globally
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.runtime.sendMessage({
          action: "updateTabState",
          tabId: activeTab.id,
          updates: { debugMode }
        });
        try {
          await chrome.tabs.sendMessage(activeTab.id, { action: "setDebugMode", debugMode });
        } catch (e) { }
      }
      
      // Save debugMode setting globally in local storage
      chrome.storage.local.set({ debugMode });
    });

    // Load initial debugMode
    chrome.storage.local.get("debugMode", (res) => {
      if (res.debugMode) {
        chkDebugMode.checked = true;
        debugLogConsole.classList.remove("hidden");
        debugLogConsole.style.display = "block";
        startLogPolling();
      } else {
        debugLogConsole.classList.add("hidden");
        debugLogConsole.style.display = "none";
      }
    });
  }

  if (btnClearLogs) {
    btnClearLogs.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ action: "clearDebugLogs" });
      logEntries.innerHTML = "";
    });
  }
}

// ─────────────────────────────────────────────
// Main Init
// ─────────────────────────────────────────────
async function init() {
  initNav();
  initEyeToggles();
  initProfiles();
  initAdvancedFeatures();
  initDebugLogs();

  await loadSettings();

  // Wire Save buttons
  $("btn-save-llm").addEventListener("click", saveAccessKey);
  $("btn-save-server").addEventListener("click", saveServerSettings);
  $("btn-save-ocr").addEventListener("click", saveOCRSettings);
  $("btn-refresh-status").addEventListener("click", refreshServerStatus);

  // Initial server status check
  refreshServerStatus();
  setInterval(refreshServerStatus, 30_000);
}

document.addEventListener("DOMContentLoaded", init);
