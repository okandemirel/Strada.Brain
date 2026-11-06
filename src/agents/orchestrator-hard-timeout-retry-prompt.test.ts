/**
 * The non-streaming retry after a hard timeout carries the summary the
 * compaction just wrote.
 *
 * The retry compacts the session first: the dropped turns move into
 * session.compactionSummary, which reaches the model only through the system
 * prompt. The retry was sent the prompt built BEFORE the compaction, so for
 * that call the dropped turns were in neither the messages nor the prompt.
 */
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { Session } from "./orchestrator-session-manager.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { FakeClock } from "../agent-core/control/clock.js";
import { openRunClock, type RunClock } from "../agent-core/control/run-clock.js";
import { RecallLedger } from "./recall-ledger.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

const SYSTEM = "You are the test agent.";
const HARD_TIMEOUT = 'Call aborted: {"kind":"hard-timeout","scope":"call"}';

function provider() {
  return {
    name: "mock-hung",
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
      thinkingSupported: false,
    },
    chatStream: vi.fn(async (): Promise<ProviderResponse> => {
      throw new Error(HARD_TIMEOUT);
    }),
    chat: vi.fn(async (): Promise<ProviderResponse> => ({
      text: "done",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  };
}

function orchestrator(p: ReturnType<typeof provider>): Orchestrator {
  return new Orchestrator({
    providerManager: {
      getProvider: () => p,
      getActiveInfo: () => ({ providerName: p.name, model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { name: "mock", connect: vi.fn(), disconnect: vi.fn(), onMessage: vi.fn(), sendText: vi.fn(), sendMarkdown: vi.fn(), isHealthy: () => true } as never,
    projectPath: "/tmp/hard-timeout-retry-prompt",
    readOnly: false,
    requireConfirmation: false,
  } as never);
}

/** A text-heavy conversation: halving it takes summarization, not tool-result trimming. */
function longConversation(): Session {
  const messages: Session["messages"] = [];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "user", content: `Request ${i}: ${"describe the level layout in detail. ".repeat(110)}` });
    messages.push({ role: "assistant", content: `Answer ${i}: ${"the board has rows of tiles and a spawner. ".repeat(100)}` });
  }
  return { messages, visibleMessages: [], lastActivity: new Date() };
}

type SilentStream = (
  chatId: string,
  systemPrompt: string,
  session: Session,
  p: unknown,
  tools: unknown[],
  externalSignal?: AbortSignal,
  onLiveness?: () => void,
  runClock?: RunClock,
) => Promise<ProviderResponse>;

const silentStreamOf = (orch: Orchestrator): SilentStream =>
  (orch as unknown as { silentStream: SilentStream }).silentStream;

describe("hard-timeout retry prompt", () => {
  for (const [label, clock] of [
    ["run-clock path", () => openRunClock(new FakeClock(0), {
      mode: "background",
      taskHardMs: Number.POSITIVE_INFINITY,
      taskInactivityMs: 600_000,
      callFirstResponseMs: 600_000,
      callStallMs: 600_000,
      callHardMs: 600_000,
      outputTokenCap: 100_000,
      costCapUsd: 10,
    })],
    ["watchdog path", () => undefined],
  ] as const) {
    it(`${label}: the retry's system prompt carries the summary the compaction wrote`, async () => {
      const p = provider();
      const orch = orchestrator(p);
      const session = longConversation();

      await silentStreamOf(orch)("chat-hung", SYSTEM, session, p, [], undefined, undefined, clock());

      expect(p.chatStream).toHaveBeenCalledTimes(1);
      expect(p.chat).toHaveBeenCalledTimes(1);
      // The compaction ran and moved turns into a summary.
      expect(session.compactionSummary, "the retry compaction did not summarize").toBeTruthy();
      const retryPrompt = p.chat.mock.calls[0]![0] as unknown as string;
      expect(retryPrompt.startsWith(SYSTEM)).toBe(true);
      expect(retryPrompt).toContain(session.compactionSummary!);
      orch.dispose();
    });

    it(`${label}: what a memory refresh recalled into a turn the compaction drops reaches the retry (recall-ledger.ts)`, async () => {
      const p = provider();
      const orch = orchestrator(p);
      const session = longConversation();
      const RECALLED = "RECALLED-NOTE-7: the spawner reads its rates from a sidecar file";
      // The refresh appended its recall to an early user turn, as the tool turn does.
      const early = session.messages.slice(0, 3);
      new RecallLedger().add(early, RECALLED);
      session.messages.splice(0, 3, ...early);
      const recallTurn = JSON.stringify(session.messages[2]);

      await silentStreamOf(orch)("chat-hung", SYSTEM, session, p, [], undefined, undefined, clock());

      expect(p.chat).toHaveBeenCalledTimes(1);
      const retryMessages = p.chat.mock.calls[0]![1] as unknown as Array<{ content: unknown }>;
      // The compaction dropped the turn that carried the recall ...
      expect(retryMessages.some((m) => JSON.stringify(m) === recallTurn)).toBe(false);
      // ... and the recall rode on to the retry, once.
      expect(JSON.stringify(retryMessages).split(RECALLED).length - 1).toBe(1);
      orch.dispose();
    });
  }
});
