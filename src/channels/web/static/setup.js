/* eslint-disable no-undef */
// Setup Wizard Client Logic

let currentStep = 1;
const totalSteps = 5;

// Initialize step indicators
(function init() {
  const container = document.getElementById("stepIndicators");
  for (let i = 1; i <= totalSteps; i++) {
    const dot = document.createElement("div");
    dot.className = "step-dot" + (i === 1 ? " active" : "");
    dot.dataset.step = String(i);
    container.appendChild(dot);
  }

  // Channel selection listeners
  document.querySelectorAll('input[name="channel"]').forEach((radio) => {
    radio.addEventListener("change", onChannelChange);
  });
})();

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
    const key = document.getElementById("anthropicKey").value.trim();
    if (!key) {
      alert("Anthropic API Key is required.");
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

  // Update selected class
  document.querySelectorAll(".channel-option").forEach((opt) => {
    opt.classList.toggle("selected", opt.querySelector("input").value === selected);
  });

  // Show/hide config
  document.getElementById("telegramConfig").style.display = selected === "telegram" ? "block" : "none";
  document.getElementById("discordConfig").style.display = selected === "discord" ? "block" : "none";
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
    ANTHROPIC_API_KEY: document.getElementById("anthropicKey").value.trim(),
    UNITY_PROJECT_PATH: document.getElementById("projectPath").value.trim(),
  };

  const openaiKey = document.getElementById("openaiKey").value.trim();
  if (openaiKey) config.OPENAI_API_KEY = openaiKey;

  if (channel === "telegram") {
    const token = document.getElementById("telegramToken").value.trim();
    const users = document.getElementById("telegramUsers").value.trim();
    if (token) config.TELEGRAM_BOT_TOKEN = token;
    if (users) config.ALLOWED_TELEGRAM_USER_IDS = users;
  } else if (channel === "discord") {
    const token = document.getElementById("discordToken").value.trim();
    if (token) config.DISCORD_BOT_TOKEN = token;
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
  // Clear previous review items safely
  while (list.firstChild) list.removeChild(list.firstChild);

  const items = [
    ["Anthropic Key", maskKey(config.ANTHROPIC_API_KEY)],
    ["OpenAI Key", config.OPENAI_API_KEY ? maskKey(config.OPENAI_API_KEY) : "Not set"],
    ["Project Path", config.UNITY_PROJECT_PATH],
    ["Channel", config._channel],
  ];

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

async function saveConfig() {
  const config = getConfig();
  const status = document.getElementById("saveStatus");
  const btn = document.getElementById("saveBtn");

  btn.disabled = true;
  status.textContent = "Saving configuration...";
  status.className = "save-status saving";

  try {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    const data = await res.json();
    if (data.success) {
      status.textContent = "Configuration saved! Restarting...";
      status.className = "save-status success";
      setTimeout(() => {
        status.textContent = "Reloading...";
        window.location.reload();
      }, 3000);
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
