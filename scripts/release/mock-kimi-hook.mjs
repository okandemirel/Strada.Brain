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

/**
 * The same completion as an OpenAI-compatible SSE stream, for requests that
 * set `stream: true`. The orchestrator streams, and the provider's stream
 * parser read the plain JSON body as an empty response, so every turn failed.
 * Shape matches what OpenAIProvider.chatStream parses: `data: <chunk>` lines
 * whose choices[0].delta carries the content and tool_calls, a final chunk with
 * finish_reason, a usage chunk, then `data: [DONE]`.
 */
function streamResponse(completion) {
  const { id, created, model } = completion;
  const choice = completion.choices[0];
  const chunk = (choices, extra = {}) => ({ id, object: "chat.completion.chunk", created, model, choices, ...extra });
  const delta = (value) => chunk([{ index: 0, delta: value, finish_reason: null }]);

  const chunks = [delta({ role: "assistant", content: "" })];
  const text = choice.message.content ?? "";
  // Two content deltas, so the parser's accumulation is exercised as well.
  const mid = Math.ceil(text.length / 2);
  for (const part of [text.slice(0, mid), text.slice(mid)]) {
    if (part) chunks.push(delta({ content: part }));
  }
  (choice.message.tool_calls ?? []).forEach((call, index) => {
    chunks.push(delta({
      tool_calls: [{
        index,
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      }],
    }));
  });
  chunks.push(chunk([{ index: 0, delta: {}, finish_reason: choice.finish_reason }]));
  chunks.push(chunk([], { usage: completion.usage }));

  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
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

function extractSynthesisResult(normalizedUserText) {
  if (!normalizedUserText.includes("create the final user-facing response for this completed decomposed task.")) {
    return null;
  }

  const exactLiteralMatch = normalizedUserText.match(
    /original user request:\n[\s\S]*?reply with only:\s*"([^"\n]+)"/i,
  );
  if (exactLiteralMatch?.[1]) {
    return exactLiteralMatch[1];
  }

  const verifiedSectionMatch = normalizedUserText.match(
    /verified sub-goal outcomes:\n([\s\S]*?)\n\nraw sub-goal draft:/i,
  );
  if (!verifiedSectionMatch?.[1]) {
    return "mock ok";
  }

  const verifiedLines = verifiedSectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [ok] "));

  for (let index = verifiedLines.length - 1; index >= 0; index -= 1) {
    const line = verifiedLines[index];
    const separator = line.lastIndexOf(": ");
    if (separator >= 0) {
      return line.slice(separator + 2).trim();
    }
  }

  return "mock ok";
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
  const assistantNameMatch = systemPrompt.match(/^Assistant Identity:\s+When referring to yourself, use the name "(.+?)"\.$/m);
  const preferredAssistantName = assistantNameMatch?.[1]?.trim();
  const responseFormatInstructionMatch = systemPrompt.match(/^Response Format Instruction:\s*(.+)$/m);
  const preferredResponseFormatInstruction = responseFormatInstructionMatch?.[1]?.trim();
  const synthesisResult = extractSynthesisResult(normalizedUserText);

  if (synthesisResult) {
    return buildChatCompletion({
      text: synthesisResult,
    });
  }

  // Goal decomposition gets no plan, so each scripted scenario runs as the one
  // task it scripts. The PAOR script's numbered plan was otherwise read as
  // three sub-goals whose node prompts no scenario recognises.
  if (normalizedUserText.includes("decompose this task into sub-goals:")) {
    return buildChatCompletion({
      text: "No decomposition: this is a single task.",
    });
  }

  if (normalizedSystemPrompt.includes("completion reviewer")) {
    const hasTouchedFiles = !/touched files:\s*\(none\)/i.test(lastUserText);
    const hasOpenFailures = !/recent unresolved failures:\s*\(none\)/i.test(lastUserText);
    const hasLogIssues = !/recent log issues since the latest clean verification:\s*\(none\)/i.test(lastUserText);

    return buildChatCompletion({
      text: JSON.stringify({
        decision: hasOpenFailures || hasLogIssues ? "continue" : "approve",
        summary:
          hasOpenFailures || hasLogIssues
            ? "Completion review found unresolved failure or log evidence."
            : "Completion review passed with clean evidence.",
        findings: [
          ...(hasOpenFailures ? ["Recent failures still appear open."] : []),
          ...(hasLogIssues ? ["Recent log issues still appear open."] : []),
        ],
        requiredActions: [
          ...(hasOpenFailures ? ["Resolve the open failure path and rerun verification."] : []),
          ...(hasLogIssues ? ["Inspect the console/log issues and confirm they are cleared."] : []),
        ],
        reviews: {
          security: hasTouchedFiles ? "clean" : "not_applicable",
          code: hasTouchedFiles ? "clean" : "not_applicable",
          simplify: hasTouchedFiles ? "clean" : "not_applicable",
        },
        logStatus: hasLogIssues ? "issues" : "clean",
      }),
    });
  }

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

  if (normalizedUserText.includes("adın atlas olsun")) {
    return buildChatCompletion({
      text: "Preference update acknowledged.",
    });
  }

  if (normalizedUserText.includes("what assistant name should you use")) {
    return buildChatCompletion({
      text: preferredAssistantName && preferredResponseFormatInstruction
        ? `Assistant name: ${preferredAssistantName}. Format: ${preferredResponseFormatInstruction}`
        : "No assistant preferences found.",
    });
  }

  if (normalizedUserText.includes('reply with only: "atlas"')) {
    return buildChatCompletion({
      text: "Atlas\nExtra details that should never reach the user.",
    });
  }

  if (normalizedUserText.includes("rapid message smoke part 1") || normalizedUserText.includes("rapid message smoke part 2")) {
    return buildChatCompletion({
      text:
        normalizedUserText.includes("rapid message smoke part 1") &&
          normalizedUserText.includes("rapid message smoke part 2")
          ? "rapid batch ok"
          : "rapid batch incomplete",
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

  const isAnalysisContinuationTurn =
    normalizedUserText.includes("analysis continuation smoke") ||
    normalizedUserText.includes("[autonomy required]") ||
    normalizedToolResult.includes("contents of 'assets/resources/levels'") ||
    normalizedToolResult.includes("file: assets/resources/levels/level_031.asset");

  if (isAnalysisContinuationTurn) {
    if (normalizedToolResult.includes("file: assets/resources/levels/level_031.asset")) {
      return buildChatCompletion({
        text: "analysis continuation ok",
      });
    }

    if (normalizedUserText.includes("[autonomy required]")) {
      return buildChatCompletion({
        text: "The directory check was not enough. Inspecting the concrete level asset now.",
        toolCalls: [
          makeToolCall("tool-analysis-read", "file_read", {
            path: "Assets/Resources/Levels/Level_031.asset",
          }),
        ],
      });
    }

    if (normalizedToolResult.includes("contents of 'assets/resources/levels'")) {
      return buildChatCompletion({
        text: "I checked the directory and Level_031 may still be wrong. What should I do next?",
      });
    }

    return buildChatCompletion({
      text: "Starting with a directory-level inspection.",
      toolCalls: [
        makeToolCall("tool-analysis-list", "list_directory", {
          path: "Assets/Resources/Levels",
        }),
      ],
    });
  }

  const isPaorRecoveryTurn =
    normalizedUserText.includes("paor recovery smoke") ||
    normalizedUserText.includes("## reflection phase") ||
    normalizedUserText.includes("please create a new plan.") ||
    normalizedToolResult.includes("assets/paor-proof.txt") ||
    normalizedToolResult.includes("assets/missing-proof.txt") ||
    normalizedToolResult.includes("test -f assets/paor-proof.txt");

  if (isPaorRecoveryTurn) {
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
          "3. Verify the proof file with a real command before concluding.",
        ].join("\n"),
        toolCalls: [
          makeToolCall("tool-paor-write", "file_write", {
            path: "Assets/paor-proof.txt",
            content: "paor ok\n",
          }),
        ],
      });
    }

    if (
      (normalizedToolResult.includes("file written: assets/paor-proof.txt") ||
        conversationText.includes("file written: assets/paor-proof.txt")) &&
      !conversationText.includes("test -f assets/paor-proof.txt")
    ) {
      return buildChatCompletion({
        text: "The proof file exists. Running an explicit verification command now.",
        toolCalls: [
          makeToolCall("tool-paor-verify", "shell_exec", {
            command: "test -f Assets/paor-proof.txt && grep -qx 'paor ok' Assets/paor-proof.txt",
          }),
        ],
      });
    }

    if (
      conversationText.includes("test -f assets/paor-proof.txt") &&
      conversationText.includes("exit code: 0")
    ) {
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

  // Every turn of the fallback task, whatever its last message (see mockFetch).
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
    // Kimi is down for every request of the fallback task, not only the one
    // whose last user message is the prompt: the agent loop's follow-up turns
    // carry other last messages, and a primary that answered those would never
    // be failed over from.
    const inFallbackSmoke = getConversationText(body.messages ?? []).toLowerCase().includes("provider fallback smoke");
    if (url.includes("api.kimi.com") && inFallbackSmoke) {
      // An outage answered with 503, not a thrown "fetch failed": fetchWithRetry
      // deliberately waits out a transport failure for about four minutes
      // (networkMaxRetries) before the chain may fail over, far past this
      // smoke's budget. A 5xx spends the short status-retry budget instead.
      const error = "503 Service Unavailable";
      log({
        type: "chat-failure",
        url,
        lastUserText,
        error,
      });
      return jsonResponse({ error: { message: "smoke: primary provider unavailable", type: "server_error" } }, 503);
    }
    const response = buildResponse(body);
    log({
      type: "chat",
      url,
      lastUserText,
      lastToolResult: getLastToolResult(body.messages ?? []),
      stream: body.stream === true,
      response,
    });
    return body.stream === true ? streamResponse(response) : jsonResponse(response);
  }

  if (originalFetch) {
    return originalFetch(input, init);
  }

  throw new Error(`No mock response configured for ${url}`);
};
