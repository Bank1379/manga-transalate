/**
 * ScanLate v3 — Settings Page Logic
 * Manages LLM provider/model selection, API key storage, server config, profiles & OCR settings
 */

// ── Exchange rate for cost display ──
const USD_TO_THB = 34.5;
const TOKENS_PER_EP = 5000; // ~5k tokens per episode
const INPUT_RATIO = 0.5;    // 50% input tokens
const OUTPUT_RATIO = 0.5;   // 50% output tokens

// ── State ──
let currentProvider = "openrouter";
let currentModel = "google/gemini-2.5-flash-lite";

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

// ─────────────────────────────────────────────
// Cost Calculator
// ─────────────────────────────────────────────
function calcCostPerEp(inputPricePerM, outputPricePerM) {
  const inputTokens  = TOKENS_PER_EP * INPUT_RATIO;
  const outputTokens = TOKENS_PER_EP * OUTPUT_RATIO;
  const usd = (inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM;
  const thb = usd * USD_TO_THB;
  if (thb === 0) return "FREE";
  if (thb < 0.01) return `~${(thb * 100).toFixed(3)} สต.`;
  return `~${thb.toFixed(3)} ฿`;
}

function updateCostBadge(modelEl) {
  if (!modelEl) return;
  const input  = parseFloat(modelEl.dataset.input  || 0);
  const output = parseFloat(modelEl.dataset.output || 0);
  const cost   = calcCostPerEp(input, output);
  $("cost-badge").textContent = cost === "FREE" ? "⚡ ฟรี" : `${cost}/ตอน`;
}

// ─────────────────────────────────────────────
// Provider Switching
// ─────────────────────────────────────────────
function setProvider(provider) {
  currentProvider = provider;

  // Update provider buttons
  document.querySelectorAll(".provider-card").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.provider === provider);
  });

  // Show correct model group
  document.querySelectorAll(".model-group").forEach(g => g.classList.remove("active"));
  const group = $(`models-${provider}`);
  if (group) group.classList.add("active");

  // Show correct API key row
  document.querySelectorAll(".api-key-row").forEach(r => hide(r));
  const keyRow = $(`key-${provider}`);
  if (keyRow) show(keyRow);

  // Auto-select first model in this group
  const firstModel = group?.querySelector(".model-option:not(.model-custom)");
  if (firstModel) selectModel(firstModel);
}

function selectModel(optionEl) {
  if (!optionEl) return;
  const modelId = optionEl.dataset.model;

  if (modelId === "__custom__") {
    currentModel = "__custom__";
    show($("custom-model-card"));
  } else {
    currentModel = modelId;
    hide($("custom-model-card"));
  }

  // Update radio styling in current group
  const activeGroup = document.querySelector(".model-group.active");
  if (activeGroup) {
    activeGroup.querySelectorAll(".model-option").forEach(el => {
      el.classList.toggle("selected", el === optionEl);
      el.querySelector(".model-radio")?.classList.toggle("selected", el === optionEl);
    });
  }

  updateCostBadge(optionEl);
}

function initProviderGrid() {
  document.querySelectorAll(".provider-card").forEach(btn => {
    btn.addEventListener("click", () => setProvider(btn.dataset.provider));
  });

  // Click on any model option row
  document.querySelectorAll(".model-option").forEach(opt => {
    opt.addEventListener("click", () => selectModel(opt));
  });
}

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
    "llmProvider", "llmModel", "customModel",
    "googleApiKey", "openrouterKey", "openaiKey", "ollamaUrl",
    "serverUrl", "ocrModel",
    "useMultimodal", "useGeminiOcr", "useAutoGlossary",
    "ocrProvider", "ocrModelSlug", "ocrApiKey"
  ]);

  // LLM
  if (data.llmProvider) setProvider(data.llmProvider);
  if (data.llmModel) {
    const opt = document.querySelector(`.model-option[data-model="${data.llmModel}"]`);
    if (opt) selectModel(opt);
    else if (data.llmModel === "__custom__") {
      const customOpt = document.querySelector(`#models-${currentProvider} .model-custom`);
      if (customOpt) selectModel(customOpt);
    }
  }
  if (data.customModel) $("custom-model-input").value = data.customModel;

  // API Keys
  if (data.googleApiKey)  $("input-google-api-key").value = data.googleApiKey;
  if (data.openrouterKey) $("input-openrouter-key").value = data.openrouterKey;
  if (data.openaiKey)     $("input-openai-key").value     = data.openaiKey;
  if (data.ollamaUrl)     $("input-ollama-url").value     = data.ollamaUrl;

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

  // LLM OCR sub-settings
  if (data.ocrProvider)   setOcrProvider(data.ocrProvider);
  if (data.ocrModelSlug)  $("input-ocr-model-slug").value = data.ocrModelSlug;
  if (data.ocrApiKey)     $("input-ocr-api-key").value    = data.ocrApiKey;

  // Update Visibility
  updateOcrEngineVisibility();

  return data;
}

// ─────────────────────────────────────────────
// Sync saved Extension settings → Server
// Called on page load so Server always has the right config
// even after a server restart
// ─────────────────────────────────────────────
async function syncSettingsToServer(data) {
  if (!data.llmProvider || !data.llmModel) return; // Nothing saved yet

  const serverUrl = data.serverUrl || "http://127.0.0.1:8745";
  const provider  = data.llmProvider;
  const model     = data.customModel && data.llmModel === "__custom__"
    ? data.customModel
    : data.llmModel;

  let api_key = "";
  let ollama_url = "";
  switch (provider) {
    case "gemini":     api_key    = data.googleApiKey  || ""; break;
    case "openrouter": api_key    = data.openrouterKey || ""; break;
    case "openai":     api_key    = data.openaiKey     || ""; break;
    case "ollama":     ollama_url = data.ollamaUrl     || "http://localhost:11434"; break;
  }

  try {
    await fetch(`${serverUrl}/settings/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model, api_key, ollama_url })
    });
    console.log(`[ScanLate] Synced LLM config to server: ${provider}/${model}`);
  } catch {
    // Server offline — will sync next time settings are saved
  }
}

// ─────────────────────────────────────────────
// Save LLM Settings → also push to server
// ─────────────────────────────────────────────
async function saveLLMSettings() {
  const model = currentModel === "__custom__"
    ? $("custom-model-input").value.trim()
    : currentModel;

  if (!model) {
    showToast("กรุณาระบุ Model Slug", true);
    return;
  }

  // Get the current API key based on provider
  let apiKey = "";
  switch (currentProvider) {
    case "gemini":     apiKey = $("input-google-api-key").value.trim(); break;
    case "openrouter": apiKey = $("input-openrouter-key").value.trim(); break;
    case "openai":     apiKey = $("input-openai-key").value.trim(); break;
    case "ollama":     apiKey = $("input-ollama-url").value.trim() || "http://localhost:11434"; break;
  }

  const storageData = {
    llmProvider: currentProvider,
    llmModel: currentModel === "__custom__" ? "__custom__" : model,
    customModel: currentModel === "__custom__" ? model : "",
    googleApiKey:  $("input-google-api-key").value.trim(),
    openrouterKey: $("input-openrouter-key").value.trim(),
    openaiKey:     $("input-openai-key").value.trim(),
    ollamaUrl:     $("input-ollama-url").value.trim(),
  };

  await saveToStorage(storageData);

  // Push to backend server
  try {
    const serverUrl = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
    const payload = {
      provider: currentProvider,
      model:    model,
      api_key:  apiKey,
    };
    if (currentProvider === "ollama") {
      payload.ollama_url = apiKey; // reuse api_key field for Ollama URL
      payload.api_key = "";
    }

    const resp = await fetch(`${serverUrl}/settings/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (resp.ok) {
      showToast(`✨ บันทึกแล้ว — ${currentProvider} / ${model}`);
    } else {
      const err = await resp.json().catch(() => ({}));
      showToast(`บันทึกใน Extension แล้ว — Server: ${err.detail || resp.status}`, true);
    }
  } catch (e) {
    // Server not running — settings still saved locally
    showToast("บันทึกใน Extension แล้ว (Server ออฟไลน์)", false);
  }
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

// ─────────────────────────────────────────────
// OCR Provider (mini grid for Advanced section)
// ─────────────────────────────────────────────
let currentOcrProvider = "openrouter";

const OCR_KEY_LABELS = {
  openrouter: { label: "OpenRouter", placeholder: "sk-or-v1-..." },
  gemini:     { label: "Google Gemini", placeholder: "AIzaSy..." },
  openai:     { label: "OpenAI", placeholder: "sk-proj-..." }
};

function setOcrProvider(provider) {
  currentOcrProvider = provider;
  document.querySelectorAll(".adv-mini-provider").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.ocrProvider === provider);
  });
  const info = OCR_KEY_LABELS[provider] || OCR_KEY_LABELS.openrouter;
  const keyTag = $("ocr-key-tag");
  const keyInput = $("input-ocr-api-key");
  if (keyTag)   keyTag.textContent   = info.label;
  if (keyInput) keyInput.placeholder = info.placeholder;
}

function initAdvancedFeatures() {
  // Toggle listener is added above

  // OCR Mini Provider buttons
  document.querySelectorAll(".adv-mini-provider").forEach(btn => {
    btn.addEventListener("click", () => setOcrProvider(btn.dataset.ocrProvider));
  });

  // Quick-fill model slug buttons
  document.querySelectorAll(".adv-quick-model").forEach(btn => {
    btn.addEventListener("click", () => {
      $("input-ocr-model-slug").value = btn.dataset.slug;
    });
  });

  // Save button
  $("btn-save-advanced").addEventListener("click", saveAdvancedSettings);

  // Auto-save on toggle changes (except OCR — handled above)
  $("toggle-multimodal").addEventListener("change", saveAdvancedSettings);
  $("toggle-auto-glossary").addEventListener("change", saveAdvancedSettings);
}

// ─────────────────────────────────────────────
// Save Advanced Settings
// ─────────────────────────────────────────────
async function saveAdvancedSettings() {
  const ocrModelSlug = $("input-ocr-model-slug")?.value.trim() || "google/gemini-2.5-flash";
  const ocrApiKey    = $("input-ocr-api-key")?.value.trim()    || "";

  await saveToStorage({
    useMultimodal:   $("toggle-multimodal").checked,
    useAutoGlossary: $("toggle-auto-glossary").checked,
    ocrProvider:     currentOcrProvider,
    ocrModelSlug,
    ocrApiKey
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
// Shared Access Keys Management
// ─────────────────────────────────────────────
let sharedAccessKeys = [];

async function loadAccessKeys() {
  const serverUrl = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
  const list = $("access-keys-list");
  if (!list) return;
  list.innerHTML = `<div class="profile-empty">กำลังโหลด...</div>`;
  try {
    const resp = await fetch(`${serverUrl}/settings/access_keys`);
    if (!resp.ok) throw new Error("not ok");
    const data = await resp.json();
    sharedAccessKeys = data.keys || [];
    renderAccessKeys();
  } catch {
    list.innerHTML = `<div class="profile-empty">⚠️ โหลดไม่ได้ (Server ออฟไลน์?)</div>`;
  }
}

function renderAccessKeys() {
  const list = $("access-keys-list");
  if (!list) return;
  if (sharedAccessKeys.length === 0) {
    list.innerHTML = `<div class="profile-empty">ยังไม่มี Access Key เพิ่มได้เลย</div>`;
    return;
  }
  list.innerHTML = sharedAccessKeys.map(k => `
    <div class="profile-item" style="padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); border-radius: 8px; margin-bottom: 6px;">
      <span style="font-family: monospace; color: #4ade80;">${k}</span>
      <button class="btn-secondary btn-remove-key" data-key="${k}" style="padding: 4px 8px; font-size: 12px;">ลบ ✕</button>
    </div>
  `).join("");
}

async function saveAccessKeysToServer(keys) {
  const serverUrl = $("input-server-url").value.trim() || "http://127.0.0.1:8745";
  try {
    const resp = await fetch(`${serverUrl}/settings/access_keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys })
    });
    if (!resp.ok) throw new Error("Save failed");
    showToast("บันทึก Access Keys แล้ว");
    await loadAccessKeys();
  } catch {
    showToast("บันทึกไม่สำเร็จ (Server ออฟไลน์?)", true);
  }
}

function initAccessKeys() {
  const btnAdd = $("btn-add-access-key");
  if (!btnAdd) return;

  btnAdd.addEventListener("click", () => {
    const input = $("input-new-access-key");
    const newKey = input.value.trim();
    if (!newKey) return;
    if (sharedAccessKeys.includes(newKey)) {
      showToast("มี Key นี้อยู่แล้ว", true);
      return;
    }
    const updatedKeys = [...sharedAccessKeys, newKey];
    input.value = "";
    saveAccessKeysToServer(updatedKeys);
  });

  $("access-keys-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-remove-key");
    if (btn) {
      const keyToRemove = btn.dataset.key;
      const updatedKeys = sharedAccessKeys.filter(k => k !== keyToRemove);
      saveAccessKeysToServer(updatedKeys);
    }
  });
  
  loadAccessKeys();
}

// ─────────────────────────────────────────────
// Main Init
// ─────────────────────────────────────────────
async function init() {
  initNav();
  initProviderGrid();
  initEyeToggles();
  initProfiles();
  initAdvancedFeatures();
  initDebugLogs();
  initAccessKeys();

  const savedData = await loadSettings();

  // ── Sync saved settings to server on open ──
  syncSettingsToServer(savedData);

  // Wire Save buttons
  $("btn-save-llm").addEventListener("click", saveLLMSettings);
  $("btn-save-server").addEventListener("click", saveServerSettings);
  $("btn-save-ocr").addEventListener("click", saveOCRSettings);
  $("btn-refresh-status").addEventListener("click", refreshServerStatus);

  // Initial server status check
  refreshServerStatus();
  setInterval(refreshServerStatus, 30_000);
}

document.addEventListener("DOMContentLoaded", init);
