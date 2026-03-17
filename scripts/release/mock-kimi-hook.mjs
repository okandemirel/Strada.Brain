import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch?.bind(globalThis);
const logPath = process.env.STRADA_MOCK_LOG_PATH;

function log(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort logging only.
  }
}

function asUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url ?? String(input);
}

function parseJsonBody(init) {
  if (!init?.body || typeof init.body !== "string") {
    return {};
  }
  try {
    return JSON.parse(init.body);
  } catch {
    return {};
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function getSystemPrompt(messages) {
  const system = messages.find((message) => message?.role === "system");
  return extractText(system?.content);
}

function getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") {
      return extractText(message.content).trim();
    }
  }
  return "";
}

function getLastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "tool") {
      return typeof message.content === "string" ? message.content.trim() : "";
    }
  }
  return "";
}

function getConversationText(messages) {
  return messages
    .map((message) => extractText(message?.content))
    .filter(Boolean)
    .join("\n");
}

function makeToolCall(id, name, input) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(input),
    },
  };
}

function buildChatCompletion({ text = "", toolCalls = [] }) {
  return {
    id: "chatcmpl-smoke",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "kimi-for-coding",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };
}

function buildResponse(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemPrompt = getSystemPrompt(messages);
  const lastUserText = getLastUserText(messages);
  const lastToolResult = getLastToolResult(messages);
  const conversationText = getConversationText(messages).toLowerCase();
  const normalizedUserText = lastUserText.toLowerCase();
  const normalizedSystemPrompt = systemPrompt.toLowerCase();
  const normalizedToolResult = lastToolResult.toLowerCase();
  const nameMatch = systemPrompt.match(/^Name:\s*(.+)$/m);
  const rememberedName = nameMatch?.[1]?.trim();

  if (normalizedUserText.includes("my name is codextester")) {
    return buildChatCompletion({
      text: "Nice to meet you, CodexTester.",
    });
  }

  if (normalizedUserText.includes("what is my name")) {
    return buildChatCompletion({
      text: rememberedName
        ? `Your name is ${rememberedName}.`
        : "I don't know your name yet.",
    });
  }

  if (lastUserText.includes("Task: Summarize release risk in one sentence.")) {
    return buildChatCompletion({
      text: "Sub-agent analysis: release risk looks low for this smoke scenario.",
    });
  }

  if (normalizedUserText.includes("release-risk analysis")) {
    if (!lastToolResult) {
      return buildChatCompletion({
        text: "Delegating the release-risk analysis now.",
        toolCalls: [
          makeToolCall("tool-delegate", "delegate_analysis", {
            task: "Summarize release risk in one sentence.",
            context: "Focus on whether the launch looks safe.",
          }),
        ],
      });
    }
    return buildChatCompletion({
      text: `Delegation complete. ${lastToolResult}`,
    });
  }

  if (conversationText.includes("paor recovery smoke")) {
    if (normalizedUserText.includes("## reflection phase")) {
      return buildChatCompletion({
        text: [
          "The initial file-read approach failed because the target does not exist.",
          "I should switch strategies and create the proof file directly.",
          "",
          "**REPLAN**",
        ].join("\n"),
      });
    }

    if (normalizedSystemPrompt.includes("## replanning phase")) {
      return buildChatCompletion({
        text: [
          "1. Stop retrying the missing file read.",
          "2. Create Assets/paor-proof.txt directly with the requested content.",
          "3. Verify the write result and conclude.",
        ].join("\n"),
        toolCalls: [
          makeToolCall("tool-paor-write", "file_write", {
            path: "Assets/paor-proof.txt",
            content: "paor ok\n",
          }),
        ],
      });
    }

    if (normalizedToolResult.includes("file written: assets/paor-proof.txt")) {
      return buildChatCompletion({
        text: "PAOR recovery completed after replanning.",
      });
    }

    if (!lastToolResult) {
      return buildChatCompletion({
        text: [
          "1. Inspect the expected proof target.",
          "2. Recover if the inspection fails.",
          "3. Produce the requested proof file.",
        ].join("\n"),
        toolCalls: [
          makeToolCall("tool-paor-read", "file_read", {
            path: "Assets/missing-proof.txt",
          }),
        ],
      });
    }
  }

  if (conversationText.includes("provider fallback smoke")) {
    return buildChatCompletion({
      text: "provider fallback ok",
    });
  }

  if (normalizedUserText.includes("autonomy-proof.txt") && normalizedUserText.includes("file_write")) {
    if (!lastToolResult) {
      return buildChatCompletion({
        text: "Creating the smoke file now.",
        toolCalls: [
          makeToolCall("tool-autonomy", "file_write", {
            path: "Assets/autonomy-proof.txt",
            content: "autonomy ok\n",
          }),
        ],
      });
    }
    return buildChatCompletion({
      text: "Autonomy write completed.",
    });
  }

  return buildChatCompletion({
    text: "mock ok",
  });
}

globalThis.fetch = async function mockFetch(input, init) {
  const url = asUrl(input);

  if (url.includes("/api/tags")) {
    return jsonResponse({ models: [] }, 503);
  }

  if (url.includes("/models")) {
    const response = {
      object: "list",
      data: [
        { id: "kimi-for-coding", object: "model" },
      ],
    };
    log({ type: "models", url, response });
    return jsonResponse(response);
  }

  if (url.includes("/chat/completions")) {
    const body = parseJsonBody(init);
    const lastUserText = getLastUserText(body.messages ?? []);
    const conversationText = getConversationText(body.messages ?? []).toLowerCase();
    if (url.includes("api.kimi.com") && conversationText.includes("provider fallback smoke")) {
      const error = new TypeError("fetch failed");
      log({
        type: "chat-failure",
        url,
        lastUserText,
        error: error.message,
      });
      throw error;
    }
    const response = buildResponse(body);
    log({
      type: "chat",
      url,
      lastUserText,
      lastToolResult: getLastToolResult(body.messages ?? []),
      response,
    });
    return jsonResponse(response);
  }

  if (originalFetch) {
    return originalFetch(input, init);
  }

  throw new Error(`No mock response configured for ${url}`);
};
