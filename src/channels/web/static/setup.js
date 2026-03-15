/* eslint-disable no-undef */
// Setup Wizard Client Logic

let currentStep = 1;
const totalSteps = 5;
let csrfToken = null;
let csrfReady = false;

// Provider registry — mirrors backend PROVIDER_PRESETS + claude + ollama
const PROVIDERS = [
  {
    id: "claude",
    name: "Claude",
    envKey: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-...",
    recommended: true,
    helpUrl: "https://console.anthropic.com",
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    placeholder: "sk-...",
    helpUrl: "https://platform.deepseek.com",
  },
  {
    id: "kimi",
    name: "Kimi",
    envKey: "KIMI_API_KEY",
    placeholder: "sk-...",
    helpUrl: "https://platform.moonshot.cn",
  },
  {
    id: "qwen",
    name: "Qwen",
    envKey: "QWEN_API_KEY",
    placeholder: "sk-...",
    helpUrl: "https://dashscope.console.aliyun.com",
  },
  {
    id: "gemini",
    name: "Gemini",
    envKey: "GEMINI_API_KEY",
    placeholder: "...",
    helpUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    placeholder: "gsk_...",
    helpUrl: "https://console.groq.com/keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    envKey: "MISTRAL_API_KEY",
    placeholder: "...",
    helpUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "together",
    name: "Together",
    envKey: "TOGETHER_API_KEY",
    placeholder: "...",
    helpUrl: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    envKey: "FIREWORKS_API_KEY",
    placeholder: "...",
    helpUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "minimax",
    name: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    placeholder: "...",
    helpUrl: "https://www.minimaxi.com",
  },
  { id: "ollama", name: "Ollama", envKey: null, placeholder: null, helpUrl: "https://ollama.com" },
];

// O(1) lookup map for provider metadata
const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

function getCheckedProviders() {
  return Array.from(document.querySelectorAll('input[name="provider"]:checked'));
}

// Fetch CSRF token on page load
fetch("/api/setup/csrf")
  .then((r) => r.json())
  .then((d) => {
    csrfToken = d.token;
    csrfReady = true;
  })
  .catch(() => {});

// Initialize step indicators and provider grid
(function init() {
  const container = document.getElementById("stepIndicators");
  for (let i = 1; i <= totalSteps; i++) {
    const dot = document.createElement("div");
    dot.className = "step-dot" + (i === 1 ? " active" : "");
    dot.dataset.step = String(i);
    container.appendChild(dot);
  }

  // Build provider grid
  buildProviderGrid();

  // Channel selection listeners
  document.querySelectorAll('input[name="channel"]').forEach((radio) => {
    radio.addEventListener("change", onChannelChange);
  });

  // Wire up all button event listeners (CSP blocks inline onclick)
  document.getElementById("btnGetStarted").addEventListener("click", nextStep);
  document.getElementById("btnBack2").addEventListener("click", prevStep);
  document.getElementById("btnNext2").addEventListener("click", nextStep);
  document.getElementById("btnBrowse").addEventListener("click", openBrowser);
  document.getElementById("btnValidate").addEventListener("click", validatePath);
  document.getElementById("btnBack3").addEventListener("click", prevStep);
  document.getElementById("btnNext3").addEventListener("click", nextStep);
  document.getElementById("btnBack4").addEventListener("click", prevStep);
  document.getElementById("btnNext4").addEventListener("click", nextStep);
  document.getElementById("btnBack5").addEventListener("click", prevStep);
  document.getElementById("saveBtn").addEventListener("click", saveConfig);
  document.getElementById("btnBrowserClose").addEventListener("click", closeBrowser);
  document.getElementById("btnBrowserCancel").addEventListener("click", closeBrowser);
  document.getElementById("browserSelectBtn").addEventListener("click", selectFolder);

  // RAG toggle + provider-aware info
  document.getElementById("ragEnabled").addEventListener("change", updateRagInfo);
  updateRagInfo();
})();

function buildProviderGrid() {
  const grid = document.getElementById("providerGrid");

  PROVIDERS.forEach((p) => {
    const label = document.createElement("label");
    label.className = "provider-option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "provider";
    input.value = p.id;
    if (p.recommended) input.checked = true;
    input.addEventListener("change", onProviderToggle);

    const card = document.createElement("div");
    card.className = "provider-card";

    const name = document.createElement("span");
    name.className = "provider-name";
    name.textContent = p.name;
    card.appendChild(name);

    if (p.recommended) {
      const badge = document.createElement("span");
      badge.className = "provider-badge";
      badge.textContent = "recommended";
      card.appendChild(badge);
    }

    label.appendChild(input);
    label.appendChild(card);
    grid.appendChild(label);
  });

  // Show config for pre-checked providers
  updateProviderConfigs();
}

function onProviderToggle() {
  updateProviderConfigs();
  updateRagInfo();
}

function updateProviderConfigs() {
  const container = document.getElementById("providerConfigs");
  const checked = getCheckedProviders();
  const checkedIds = new Set(checked.map((cb) => cb.value));

  // Remove configs for unchecked providers
  container.querySelectorAll(".provider-config-item").forEach((el) => {
    if (!checkedIds.has(el.dataset.providerId)) {
      el.remove();
    }
  });

  // Add configs for newly checked providers
  checked.forEach((cb) => {
    const p = PROVIDER_MAP[cb.value];
    if (!p || !p.envKey) return; // Ollama doesn't need a key
    if (container.querySelector(`[data-provider-id="${p.id}"]`)) return; // already exists

    const item = document.createElement("div");
    item.className = "provider-config-item";
    item.dataset.providerId = p.id;

    const lbl = document.createElement("label");
    lbl.setAttribute("for", "key_" + p.id);
    lbl.textContent = p.name + " API Key";
    item.appendChild(lbl);

    const input = document.createElement("input");
    input.type = "password";
    input.id = "key_" + p.id;
    input.placeholder = p.placeholder;
    input.autocomplete = "off";
    item.appendChild(input);

    if (p.helpUrl) {
      const small = document.createElement("small");
      const link = document.createElement("a");
      link.href = p.helpUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Get API key";
      small.appendChild(link);
      item.appendChild(small);
    }

    container.appendChild(item);
  });
}

// Providers that support embeddings — must mirror backend EMBEDDING_PRESETS.
// When adding a new provider, add its id here if it supports embeddings.
const EMBEDDING_CAPABLE = new Set([
  "openai", "mistral", "together",
  "fireworks", "qwen", "gemini", "ollama",
]);

function updateRagInfo() {
  const infoEl = document.getElementById("ragInfo");
  const ragCheckbox = document.getElementById("ragEnabled");
  if (!infoEl || !ragCheckbox) return;

  if (!ragCheckbox.checked) {
    infoEl.textContent = "RAG is disabled. Code search will not be available.";
    infoEl.className = "rag-info";
    return;
  }

  const checked = getCheckedProviders().map((cb) => cb.value);

  // Find first embedding-capable provider from selection
  const embeddingProvider = checked.find((id) => EMBEDDING_CAPABLE.has(id));

  if (embeddingProvider) {
    const name = PROVIDER_MAP[embeddingProvider]?.name ?? embeddingProvider;
    if (embeddingProvider === "gemini") {
      infoEl.textContent = "RAG will use " + name + " for embeddings. Tip: Gemini offers free embedding with excellent quality.";
    } else {
      // If Gemini is also checked, hint that it's a good choice for embeddings
      const hasGemini = checked.includes("gemini");
      infoEl.textContent = "RAG will use " + name + " for embeddings." +
        (hasGemini ? " Tip: Gemini offers free embedding with excellent quality and will be auto-selected." : "");
    }
    infoEl.className = "rag-info";
  } else if (checked.length > 0) {
    const names = checked.map((id) => PROVIDER_MAP[id]?.name ?? id).join(", ");
    infoEl.textContent =
      names +
      " does not support embeddings. Add OpenAI, Mistral, or Ollama for code search.";
    infoEl.className = "rag-info warning";
  } else {
    infoEl.textContent = "Select a provider to enable RAG.";
    infoEl.className = "rag-info warning";
  }
}

function showStep(step) {
  document.querySelectorAll(".step").forEach((el) => el.classList.remove("active"));
  const target = document.querySelector(`.step[data-step="${step}"]`);
  if (target) target.classList.add("active");

  // Update progress
  document.getElementById("progressFill").style.width = `${(step / totalSteps) * 100}%`;

  // Update dots
  document.querySelectorAll(".step-dot").forEach((dot) => {
    const s = parseInt(dot.dataset.step, 10);
    dot.className = "step-dot";
    if (s < step) dot.classList.add("completed");
    else if (s === step) dot.classList.add("active");
  });

  // Build review on step 5
  if (step === 5) buildReview();
}

function nextStep() {
  if (!validateCurrentStep()) return;
  if (currentStep < totalSteps) {
    currentStep++;
    showStep(currentStep);
  }
}

function prevStep() {
  if (currentStep > 1) {
    currentStep--;
    showStep(currentStep);
  }
}

function validateCurrentStep() {
  if (currentStep === 2) {
    const checked = getCheckedProviders();
    if (checked.length === 0) {
      alert("Please select at least one AI provider.");
      return false;
    }
    // Verify at least one checked provider has a key (or is Ollama)
    let hasKey = false;
    checked.forEach((cb) => {
      const p = PROVIDER_MAP[cb.value];
      if (!p) return;
      if (!p.envKey) {
        hasKey = true;
        return;
      } // Ollama
      const input = document.getElementById("key_" + p.id);
      if (input && input.value.trim()) hasKey = true;
    });
    if (!hasKey) {
      alert("Please enter an API key for at least one selected provider.");
      return false;
    }
  }
  if (currentStep === 3) {
    const path = document.getElementById("projectPath").value.trim();
    if (!path) {
      alert("Unity Project Path is required.");
      return false;
    }
  }
  return true;
}

function onChannelChange() {
  const selected = document.querySelector('input[name="channel"]:checked').value;

  // Show/hide config
  ["telegram", "discord", "slack"].forEach((ch) => {
    const el = document.getElementById(ch + "Config");
    if (el) el.style.display = selected === ch ? "block" : "none";
  });
}

async function validatePath() {
  const path = document.getElementById("projectPath").value.trim();
  const status = document.getElementById("pathStatus");

  if (!path) {
    status.textContent = "Please enter a path.";
    status.className = "validation-status invalid";
    return;
  }

  status.textContent = "Validating...";
  status.className = "validation-status";

  try {
    const res = await fetch(`/api/setup/validate-path?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.valid) {
      status.textContent = "Valid Unity project directory.";
      status.className = "validation-status valid";
    } else {
      status.textContent = data.error || "Invalid path.";
      status.className = "validation-status invalid";
    }
  } catch {
    status.textContent = "Could not validate. Server may be unreachable.";
    status.className = "validation-status invalid";
  }
}

function getConfig() {
  const channel = document.querySelector('input[name="channel"]:checked').value;
  const config = {
    UNITY_PROJECT_PATH: document.getElementById("projectPath").value.trim(),
  };

  // Collect all checked provider keys
  const providerChain = [];
  const checked = getCheckedProviders();
  checked.forEach((cb) => {
    const p = PROVIDER_MAP[cb.value];
    if (!p) return;
    providerChain.push(p.id);
    if (p.envKey) {
      const input = document.getElementById("key_" + p.id);
      const val = input ? input.value.trim() : "";
      if (val) config[p.envKey] = val;
    }
  });

  if (providerChain.length > 0) {
    config.PROVIDER_CHAIN = providerChain.join(",");
  }

  if (channel === "telegram") {
    const token = document.getElementById("telegramToken").value.trim();
    const users = document.getElementById("telegramUsers").value.trim();
    if (token) config.TELEGRAM_BOT_TOKEN = token;
    if (users) config.ALLOWED_TELEGRAM_USER_IDS = users;
  } else if (channel === "discord") {
    const token = document.getElementById("discordToken").value.trim();
    if (token) config.DISCORD_BOT_TOKEN = token;
  } else if (channel === "slack") {
    const bot = document.getElementById("slackBotToken").value.trim();
    const app = document.getElementById("slackAppToken").value.trim();
    if (bot) config.SLACK_BOT_TOKEN = bot;
    if (app) config.SLACK_APP_TOKEN = app;
  }

  // Language preference
  const langSelect = document.getElementById("languageSelect");
  if (langSelect && langSelect.value && langSelect.value !== "en") {
    config.LANGUAGE_PREFERENCE = langSelect.value;
  }

  // RAG configuration
  const ragEnabled = document.getElementById("ragEnabled");
  if (ragEnabled && !ragEnabled.checked) {
    config.RAG_ENABLED = "false";
  }

  // Gemini embedding recommendation: auto-set when Gemini key is present
  // and no explicit embedding provider override, and RAG is enabled
  if (config.GEMINI_API_KEY && config.RAG_ENABLED !== "false") {
    config.EMBEDDING_PROVIDER = config.EMBEDDING_PROVIDER || "gemini";
  }

  config._channel = channel;
  return config;
}

function maskKey(key) {
  if (!key || key.length < 8) return "***";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

function buildReview() {
  const config = getConfig();
  const list = document.getElementById("reviewList");
  while (list.firstChild) list.removeChild(list.firstChild);

  const items = [];

  // Derive provider display from config (no redundant DOM query)
  PROVIDERS.forEach((p) => {
    if (p.envKey && config[p.envKey]) {
      items.push([p.name + " Key", maskKey(config[p.envKey])]);
    } else if (!p.envKey && config.PROVIDER_CHAIN?.includes(p.id)) {
      items.push([p.name, "Local (no key)"]);
    }
  });

  if (config.PROVIDER_CHAIN) {
    items.push(["Provider Chain", config.PROVIDER_CHAIN]);
  }

  items.push(["Project Path", config.UNITY_PROJECT_PATH]);
  items.push(["Channel", config._channel]);

  // Language preference
  const LANG_LABELS = {
    en: "English", tr: "T\u00fcrk\u00e7e", ja: "\u65e5\u672c\u8a9e",
    ko: "\ud55c\uad6d\uc5b4", zh: "\u4e2d\u6587", de: "Deutsch",
    es: "Espa\u00f1ol", fr: "Fran\u00e7ais",
  };
  const langVal = config.LANGUAGE_PREFERENCE || "en";
  items.push(["Language", LANG_LABELS[langVal] || langVal]);

  // Show RAG status with embedding provider info
  if (config.RAG_ENABLED === "false") {
    items.push(["RAG (Code Search)", "Disabled"]);
  } else {
    const chain = config.PROVIDER_CHAIN ? config.PROVIDER_CHAIN.split(",") : [];
    const embProvider = chain.find((id) => EMBEDDING_CAPABLE.has(id.trim()));
    const embName = embProvider
      ? PROVIDER_MAP[embProvider.trim()]?.name ?? embProvider.trim()
      : null;
    items.push(["RAG (Code Search)", embName ? "Enabled (" + embName + " embeddings)" : "Enabled"]);
  }

  items.forEach(([key, value]) => {
    const div = document.createElement("div");
    div.className = "review-item";

    const keySpan = document.createElement("span");
    keySpan.className = "review-key";
    keySpan.textContent = key;

    const valSpan = document.createElement("span");
    valSpan.className = "review-value";
    valSpan.textContent = value;

    div.appendChild(keySpan);
    div.appendChild(valSpan);
    list.appendChild(div);
  });
}

// ===== Directory Browser =====
let browserCurrentPath = "";

function openBrowser() {
  document.getElementById("browserOverlay").style.display = "flex";
  browseTo(""); // empty = server defaults to homedir
}

function closeBrowser() {
  document.getElementById("browserOverlay").style.display = "none";
}

async function browseTo(path) {
  const list = document.getElementById("browserList");
  list.textContent = "Loading...";

  try {
    const url = path ? `/api/setup/browse?path=${encodeURIComponent(path)}` : "/api/setup/browse";
    const res = await fetch(url);
    const data = await res.json();

    if (data.error && !data.entries) {
      list.textContent = data.error;
      return;
    }

    browserCurrentPath = data.path;
    renderBreadcrumb(data.path);
    renderEntries(data.entries);

    // Unity project detection
    const statusEl = document.getElementById("browserUnityStatus");
    if (data.isUnityProject) {
      statusEl.textContent = "Unity project detected";
      statusEl.className = "browser-unity-status detected";
    } else {
      statusEl.textContent = "Not a Unity project";
      statusEl.className = "browser-unity-status";
    }
    document.getElementById("browserSelectBtn").disabled = false;
  } catch {
    list.textContent = "Could not reach server.";
  }
}

function renderBreadcrumb(fullPath) {
  const container = document.getElementById("browserBreadcrumb");
  while (container.firstChild) container.removeChild(container.firstChild);

  const parts = fullPath.split("/").filter(Boolean);
  // Root
  const rootSpan = document.createElement("span");
  rootSpan.className = "breadcrumb-segment";
  rootSpan.textContent = "/";
  rootSpan.onclick = () => browseTo("/");
  container.appendChild(rootSpan);

  let accumulated = "";
  parts.forEach((part) => {
    accumulated += "/" + part;
    const sep = document.createElement("span");
    sep.className = "breadcrumb-sep";
    sep.textContent = "/";
    container.appendChild(sep);

    const span = document.createElement("span");
    span.className = "breadcrumb-segment";
    span.textContent = part;
    const target = accumulated;
    span.onclick = () => browseTo(target);
    container.appendChild(span);
  });
}

function renderEntries(entries) {
  const list = document.getElementById("browserList");
  while (list.firstChild) list.removeChild(list.firstChild);

  if (entries.length === 0) {
    list.textContent = "Empty directory";
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "browser-entry directory";

    const icon = document.createElement("span");
    icon.className = "browser-entry-icon";
    icon.textContent = "\uD83D\uDCC1"; // folder emoji

    const name = document.createElement("span");
    name.className = "browser-entry-name";
    name.textContent = entry.name;

    row.appendChild(icon);
    row.appendChild(name);

    row.onclick = () => browseTo(browserCurrentPath + "/" + entry.name);
    list.appendChild(row);
  });
}

function selectFolder() {
  document.getElementById("projectPath").value = browserCurrentPath;
  closeBrowser();
  validatePath();
}

async function saveConfig() {
  const config = getConfig();
  const status = document.getElementById("saveStatus");
  const btn = document.getElementById("saveBtn");

  if (!csrfReady) {
    status.textContent = "Security token not loaded. Please refresh.";
    status.className = "save-status error";
    return;
  }

  btn.disabled = true;
  status.textContent = "Saving configuration...";
  status.className = "save-status saving";

  try {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(config),
    });

    const data = await res.json();
    if (data.success) {
      status.textContent = "Configuration saved! Starting agent...";
      status.className = "save-status success";
      // Poll until the main web channel is ready (wizard server shuts down, app restarts)
      let attempts = 0;
      const maxAttempts = 30;
      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          const check = await fetch("/", { method: "HEAD" });
          // If we get a response and it's NOT the setup page, the app is ready
          if (check.ok) {
            clearInterval(pollInterval);
            status.textContent = "Agent ready! Redirecting...";
            window.location.href = "/";
          }
        } catch {
          // Server not ready yet — keep polling
          status.textContent = `Starting agent... (${attempts}s)`;
        }
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          status.textContent = "Agent is starting. Please refresh the page manually.";
        }
      }, 1000);
    } else {
      status.textContent = data.error || "Save failed.";
      status.className = "save-status error";
      btn.disabled = false;
    }
  } catch {
    status.textContent = "Could not reach server.";
    status.className = "save-status error";
    btn.disabled = false;
  }
}
