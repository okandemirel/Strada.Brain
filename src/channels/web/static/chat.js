/* eslint-disable no-undef */
// Chat WebSocket Client

(function () {
  "use strict";

  // === State ===
  let ws = null;
  let chatId = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  const streams = new Map(); // streamId -> DOM element
  let userScrolledUp = false;
  let pendingConfirmation = null;

  // === DOM refs ===
  const messagesEl = document.getElementById("messages");
  const emptyState = document.getElementById("emptyState");
  const input = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const themeToggle = document.getElementById("themeToggle");
  const confirmOverlay = document.getElementById("confirmOverlay");
  const confirmQuestion = document.getElementById("confirmQuestion");
  const confirmDetails = document.getElementById("confirmDetails");
  const confirmOptions = document.getElementById("confirmOptions");

  // === Theme ===
  const savedTheme = localStorage.getItem("strada-theme") || "dark";
  setTheme(savedTheme);

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
    localStorage.setItem("strada-theme", theme);
    // Switch highlight.js theme
    const hljsLink = document.getElementById("hljs-theme");
    if (hljsLink) {
      hljsLink.href =
        theme === "dark"
          ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
          : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
    }
  }

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "light" : "dark");
  });

  // === Markdown rendering ===
  if (typeof marked !== "undefined") {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: function (code, lang) {
        if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return code;
      },
    });
  }

  function renderMarkdown(text) {
    if (typeof marked !== "undefined") {
      // Use marked.parse which returns sanitized HTML by default in v12+
      return marked.parse(text);
    }
    // Fallback: escape HTML and convert newlines
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // === Scroll ===
  messagesEl.addEventListener("scroll", () => {
    const threshold = 100;
    const atBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    userScrolledUp = !atBottom;
  });

  function scrollToBottom() {
    if (!userScrolledUp) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // === Messages ===
  function hideEmptyState() {
    if (emptyState) emptyState.style.display = "none";
  }

  function addMessage(text, sender, useMarkdown) {
    hideEmptyState();
    const div = document.createElement("div");
    div.className = `message ${sender}`;
    if (sender === "ai" && useMarkdown) {
      // Create a container and set rendered markdown
      const rendered = renderMarkdown(text);
      // Use DOMParser for safe HTML insertion
      const parser = new DOMParser();
      const doc = parser.parseFromString(rendered, "text/html");
      // Move parsed nodes into the div
      while (doc.body.firstChild) {
        div.appendChild(doc.body.firstChild);
      }
    } else {
      div.textContent = text;
    }
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addTypingIndicator() {
    hideEmptyState();
    // Remove existing typing indicator
    removeTypingIndicator();
    const div = document.createElement("div");
    div.className = "typing-indicator";
    div.id = "typingIndicator";
    for (let i = 0; i < 3; i++) {
      div.appendChild(document.createElement("span"));
    }
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const el = document.getElementById("typingIndicator");
    if (el) el.remove();
  }

  // === Streaming ===
  function handleStreamStart(streamId) {
    hideEmptyState();
    removeTypingIndicator();
    const div = document.createElement("div");
    div.className = "message ai";
    div.textContent = "";
    messagesEl.appendChild(div);
    streams.set(streamId, div);
    scrollToBottom();
  }

  function handleStreamUpdate(streamId, text) {
    const div = streams.get(streamId);
    if (!div) return;
    const rendered = renderMarkdown(text);
    const parser = new DOMParser();
    const doc = parser.parseFromString(rendered, "text/html");
    // Clear and re-render
    while (div.firstChild) div.removeChild(div.firstChild);
    while (doc.body.firstChild) div.appendChild(doc.body.firstChild);
    scrollToBottom();
  }

  function handleStreamEnd(streamId, text) {
    const div = streams.get(streamId);
    if (!div) {
      // Stream div missing, just add as message
      addMessage(text, "ai", true);
    } else {
      const rendered = renderMarkdown(text);
      const parser = new DOMParser();
      const doc = parser.parseFromString(rendered, "text/html");
      while (div.firstChild) div.removeChild(div.firstChild);
      while (doc.body.firstChild) div.appendChild(doc.body.firstChild);
      // Highlight code blocks
      div.querySelectorAll("pre code").forEach((block) => {
        if (typeof hljs !== "undefined") hljs.highlightElement(block);
      });
      streams.delete(streamId);
    }
    scrollToBottom();
  }

  // === Confirmation ===
  function showConfirmation(data) {
    confirmQuestion.textContent = data.question;
    confirmDetails.textContent = data.details || "";
    confirmDetails.style.display = data.details ? "block" : "none";

    // Clear previous options
    while (confirmOptions.firstChild) confirmOptions.removeChild(confirmOptions.firstChild);

    data.options.forEach((option) => {
      const btn = document.createElement("button");
      btn.textContent = option;
      btn.addEventListener("click", () => {
        sendConfirmationResponse(data.confirmId, option);
        confirmOverlay.classList.remove("active");
      });
      confirmOptions.appendChild(btn);
    });

    confirmOverlay.classList.add("active");
    pendingConfirmation = data.confirmId;
  }

  function sendConfirmationResponse(confirmId, option) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "confirmation_response", confirmId, option }));
    }
    pendingConfirmation = null;
  }

  // === WebSocket ===
  function connect() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.addEventListener("open", () => {
      statusDot.classList.add("connected");
      statusText.textContent = "Connected";
      reconnectDelay = 1000;
    });

    ws.addEventListener("close", () => {
      statusDot.classList.remove("connected");
      statusText.textContent = "Disconnected";
      chatId = null;
      // Auto-reconnect with exponential backoff
      setTimeout(() => {
        statusText.textContent = "Reconnecting...";
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    });

    ws.addEventListener("error", () => {
      // error event is always followed by close
    });

    ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (data.type) {
        case "connected":
          chatId = data.chatId;
          break;

        case "text":
          removeTypingIndicator();
          addMessage(data.text, "ai", false);
          break;

        case "markdown":
          removeTypingIndicator();
          addMessage(data.text, "ai", true);
          break;

        case "typing":
          if (data.active) addTypingIndicator();
          else removeTypingIndicator();
          break;

        case "stream_start":
          handleStreamStart(data.streamId);
          break;

        case "stream_update":
          handleStreamUpdate(data.streamId, data.text);
          break;

        case "stream_end":
          handleStreamEnd(data.streamId, data.text);
          break;

        case "confirmation":
          showConfirmation(data);
          break;
      }
    });
  }

  // === Send message ===
  function sendMessage() {
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    addMessage(text, "user", false);
    ws.send(JSON.stringify({ type: "message", text }));
    input.value = "";
    input.style.height = "auto";
  }

  sendBtn.addEventListener("click", sendMessage);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  // === Start ===
  connect();
})();
