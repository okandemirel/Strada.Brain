/**
 * Task turn survives the history trim on the REAL run path.
 *
 * What this pins: an interactive chat holds an old chat turn; the person then
 * sends a new task WITH AN IMAGE (a multimodal user turn, which the soft trim
 * never treats as a safe cut boundary), and the run makes ~60 sequential tool
 * calls. Past the hard cap (2x the recommended max messages) the trim used to
 * cut by position alone, keep the OLD chat turn as the head and drop the image
 * task, so the model kept working without knowing what it was asked (board #58).
 *
 * It drives Orchestrator.handleMessage -> v2 runner -> assembleStepContext ->
 * trimContextWindowForRun -> SessionManager.trimSession and reads what the
 * provider was actually sent on every call (`provider.interactions[i].messages`),
 * so it measures the wire history, not trimSessionMessages in isolation.
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
import { createMockProvider, createMockToolCall } from "../tests/helpers/mock-provider.js";
import { createMockTelegramChannel } from "../tests/helpers/mock-channel.js";

beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

const TOOL_CALLS = 60;
const OLD_QUESTION = "old question: which jetty does the morning ferry leave from?";
const TASK_TEXT = "Compare the attached ferry timetable photo against the bakery delivery slots and list the clashes.";

/** A read-only lookup that answers with a short, distinct line per call. */
const slotLookupTool: ITool = {
  name: "slot_lookup",
  description: "Look up one delivery slot in the bakery timetable (read-only).",
  inputSchema: {
    type: "object",
    properties: { slot: { type: "number", description: "Slot number" } },
    required: ["slot"],
  },
  async execute(input) {
    return { content: `slot ${String(input["slot"])}: sourdough drop 0${String(input["slot"])}:15` };
  },
};

function textOf(message: ConversationMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((b) => (b as { type: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : "")
    .join("");
}

function blocksOf(message: ConversationMessage): Array<{ type?: string; tool_use_id?: string }> {
  return Array.isArray(message.content) ? (message.content as Array<{ type?: string; tool_use_id?: string }>) : [];
}

describe("task turn survives the history trim (real run path)", { timeout: 60_000 }, () => {
  let tempDir = "";
  const channels: Array<ReturnType<typeof createMockTelegramChannel>> = [];

  afterEach(async () => {
    for (const channel of channels.splice(0)) await channel.disconnect();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the image task as the history head through a 60-call tool loop", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strada-task-turn-live-"));
    const provider = createMockProvider();
    (provider.capabilities as { vision: boolean }).vision = true;
    const channel = createMockTelegramChannel({ autoConfirm: true });
    channels.push(channel);
    const orchestrator = new Orchestrator({
      providerManager: { getProvider: () => provider, shutdown: () => undefined } as never,
      tools: [slotLookupTool],
      channel,
      projectPath: tempDir,
      readOnly: true,
      requireConfirmation: false,
      streamingEnabled: false,
      // The interactive default (25 iterations) would end the run before the history reaches the cap.
      taskConfig: { ...DEFAULT_TASK_CONFIG, interactiveMaxIterations: 200 },
    });
    await channel.connect();
    channel.onMessage((msg) => orchestrator.handleMessage(msg));

    // First message: a plain chat turn that ends with an answer (no tools).
    provider.setDefaultResponse({ text: "The morning ferry leaves from the east jetty.", toolCalls: [], stopReason: "end_turn" });
    await channel.simulateIncomingMessage("chat-1", OLD_QUESTION);
    const callsBefore = provider.interactions.length;
    expect(callsBefore).toBeGreaterThan(0);

    // Second message: the image task; the provider then asks for 60 distinct tool calls.
    let issued = 0;
    provider.registerResponseHandler("sixty-lookups", () => {
      if (issued >= TOOL_CALLS) return undefined;
      issued += 1;
      return {
        text: `Checking slot ${issued}.`,
        toolCalls: [createMockToolCall(`lookup-${issued}`, "slot_lookup", { slot: issued })],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
    });
    provider.setDefaultResponse({ text: "Final answer: three slots clash with the ferry.", toolCalls: [], stopReason: "end_turn" });

    await channel.simulateIncomingMessage("chat-1", TASK_TEXT, "test-user", [
      { type: "image", name: "timetable.png", mimeType: "image/png", data: Buffer.from("not-really-a-png"), size: 16 },
    ]);

    const calls = provider.interactions.slice(callsBefore);
    const lengths = calls.map((c) => c.messages.length);

    expect(issued).toBe(TOOL_CALLS);

    // The trim ran: the un-trimmed history grows by 2 per tool call (to ~123 here), so a longest
    // history under that, and a call whose history is SHORTER than the one before it, show the
    // history was cut. Without this the test would measure nothing.
    const produced = 3 + 2 * TOOL_CALLS;
    expect(Math.max(...lengths)).toBeLessThan(produced);
    const firstTrimmed = lengths.findIndex((n, i) => i > 0 && n < lengths[i - 1]!);
    expect(firstTrimmed, "no call showed a trimmed history").toBeGreaterThan(0);
    // The hard cap (2x the recommended 40) is what cuts a run whose task is multimodal: the
    // history sent just before the cut was already one turn pair short of passing it.
    expect(lengths[firstTrimmed - 1]! + 2).toBeGreaterThan(2 * 40);

    for (const [i, call] of calls.entries()) {
      const history = call.messages;
      const head = history[0]!;

      // The image task is in every call, text and image block together.
      const task = history.find((m) => textOf(m).includes(TASK_TEXT));
      expect(task, `call ${i} has the task turn`).toBeDefined();
      expect(blocksOf(task!).some((b) => b.type === "image"), `call ${i} task image block`).toBe(true);

      // Once the history has been trimmed, its first message is the task turn, never the old chat turn.
      if (i >= firstTrimmed) {
        expect(head, `call ${i} head is the task turn`).toBe(task);
        expect(history.some((m) => textOf(m).includes(OLD_QUESTION)), `call ${i} old chat turn`).toBe(false);
      }

      // The history is one a provider accepts.
      expect(head.role, `call ${i} head role`).toBe("user");
      expect(blocksOf(head).some((b) => b.type === "tool_result"), `call ${i} head tool_result`).toBe(false);
      for (let m = 1; m < history.length; m++) {
        const results = blocksOf(history[m]!).filter((b) => b.type === "tool_result");
        if (results.length === 0) continue;
        const prev = history[m - 1]!;
        const calledIds = new Set(
          prev.role === "assistant" ? ((prev as { tool_calls?: Array<{ id: string }> }).tool_calls ?? []).map((t) => t.id) : [],
        );
        for (const r of results) {
          expect(calledIds.has(r.tool_use_id!), `call ${i} message ${m} tool_result ${r.tool_use_id}`).toBe(true);
        }
      }
    }
  });
});
