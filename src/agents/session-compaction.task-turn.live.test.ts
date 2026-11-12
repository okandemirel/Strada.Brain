/**
 * Compaction keeps the run's task turn on the REAL run path (board #63, steer 3).
 *
 * The person sends a task; the run makes tool calls, one answer is cut off at max_tokens (the
 * loop pushes the continuation gate as a plain-text user turn), and more tool calls follow until
 * the history passes the compaction trigger. Picking "the newest user turn", compaction kept the
 * GATE verbatim and left the task only in the summary's preview, so the model continued with a
 * history whose only user words were "continue exactly where you left off".
 *
 * It drives Orchestrator.handleMessage -> v2 runner -> maybeCompactSession -> compactSession and
 * reads what the provider was sent on every call (`provider.interactions[i].messages`).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TASK_CONFIG } from "../config/config-types.js";
import { createLogger } from "../utils/logger.js";
import { Orchestrator } from "./orchestrator.js";
import type { ITool } from "./tools/tool.interface.js";
import type { ConversationMessage } from "./providers/provider.interface.js";
import { MAX_TOKENS_CONTINUATION_GATE } from "./orchestrator-loop-shared.js";
import { createMockProvider, createMockToolCall } from "../tests/helpers/mock-provider.js";
import { createMockTelegramChannel } from "../tests/helpers/mock-channel.js";

beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

/**
 * Small enough that a dozen tool turns pass the trigger (0.7 x 16k; the target is the 9.6k
 * share) while the history stays under the message-count trim (40), which keeps the task turn
 * on its own (board #58): the cut measured here is compaction's, not the trim's.
 */
const CONTEXT_WINDOW = 16_000;
const CALLS_BEFORE_GATE = 3;
const CALLS_AFTER_GATE = 12;
const TASK_TEXT = "Audit the library loans: list every overdue loan that overlaps a reading-room booking.";
/** Assistant text stage 1 does not shorten: it is what makes the history outgrow the window. */
const NOTE = "Cross-checking the loan row against the booking table; ".repeat(80);

const loanTool: ITool = {
  name: "loan_lookup",
  description: "Look up one loan in the library register (read-only).",
  inputSchema: {
    type: "object",
    properties: { loan: { type: "number", description: "Loan number" } },
    required: ["loan"],
  },
  async execute(input) {
    return { content: `loan ${String(input["loan"])}: due back day 0${String(input["loan"])}` };
  },
};

function textOf(message: ConversationMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((b) => (b as { type: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : "")
    .join("");
}

describe("compaction keeps the task turn (real run path)", { timeout: 60_000 }, () => {
  let tempDir = "";
  const channels: Array<ReturnType<typeof createMockTelegramChannel>> = [];

  afterEach(async () => {
    for (const channel of channels.splice(0)) await channel.disconnect();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the task verbatim, not the max_tokens continuation gate, once the history is compacted", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strada-compaction-task-turn-live-"));
    const provider = createMockProvider();
    const channel = createMockTelegramChannel({ autoConfirm: true });
    channels.push(channel);
    const orchestrator = new Orchestrator({
      providerManager: {
        getProvider: () => provider,
        getProviderCapabilities: () => ({ ...provider.capabilities, contextWindow: CONTEXT_WINDOW }),
        shutdown: () => undefined,
      } as never,
      tools: [loanTool],
      channel,
      projectPath: tempDir,
      readOnly: true,
      requireConfirmation: false,
      streamingEnabled: false,
      taskConfig: { ...DEFAULT_TASK_CONFIG, interactiveMaxIterations: 200 },
    });
    await channel.connect();
    channel.onMessage((msg) => orchestrator.handleMessage(msg));

    let step = 0;
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
    provider.registerResponseHandler("loan-audit", () => {
      step += 1;
      if (step === CALLS_BEFORE_GATE + 1) {
        return { text: "Partial findings so far: loans 1-3 checked, two overlaps", toolCalls: [], stopReason: "max_tokens", usage };
      }
      if (step > CALLS_BEFORE_GATE + 1 + CALLS_AFTER_GATE) return undefined;
      return {
        text: `${NOTE}loan ${step}.`,
        toolCalls: [createMockToolCall(`loan-${step}`, "loan_lookup", { loan: step })],
        stopReason: "tool_use",
        usage,
      };
    });
    provider.setDefaultResponse({ text: "Final answer: loans 3 and 9 overlap a booking.", toolCalls: [], stopReason: "end_turn" });

    await channel.simulateIncomingMessage("chat-1", TASK_TEXT);

    const calls = provider.interactions;
    expect(step).toBeGreaterThan(CALLS_BEFORE_GATE + 1 + CALLS_AFTER_GATE);

    // The gate was pushed, and compaction ran after it (its summary rides in the system prompt
    // from then on); the history stayed under the message-count trim, so the cut is compaction's.
    // Without these the test would measure nothing.
    const gateCall = calls.findIndex((c) => c.messages.some((m) => textOf(m) === MAX_TOKENS_CONTINUATION_GATE));
    expect(gateCall, "the continuation gate reached the provider").toBeGreaterThan(0);
    const compacted = calls.findIndex((c) => c.systemPrompt.includes("Compacted conversation summary"));
    expect(compacted, "no call after the gate carried a compaction summary").toBeGreaterThan(gateCall);
    expect(calls.length - compacted, "calls ran on the compacted history").toBeGreaterThan(1);
    expect(Math.max(...calls.map((c) => c.messages.length)), "the history stayed under the message-count trim").toBeLessThan(40);

    for (let i = compacted; i < calls.length; i++) {
      const history = calls[i]!.messages;
      const userTexts = history.filter((m) => m.role === "user").map(textOf);
      expect(userTexts, `call ${i} keeps the task verbatim`).toContain(TASK_TEXT);
      expect(userTexts, `call ${i} does not keep the gate in the task's place`).not.toContain(MAX_TOKENS_CONTINUATION_GATE);
      expect(history[0]!.role, `call ${i} head role`).toBe("user");
    }
  });
});
