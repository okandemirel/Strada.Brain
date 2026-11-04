/**
 * Every executed tool leaves its duration in the daemon's log.
 *
 * The orchestrator timed each tool and logged the time at debug, which the
 * daemon does not write. Proof Run 1 (2026-10-14..20) logged 12 h of active
 * work, of which provider calls took 31%. The other 69% could not be split
 * by tool, because no line in the log said how long any tool took. Speed work
 * starts from that split, so the line is written at info. These tests drive
 * the real executeToolCalls.
 */

import { Orchestrator } from "./orchestrator.js";

const logged = vi.hoisted(() => ({ info: [] as Array<[string, Record<string, unknown>]> }));

vi.mock("../utils/logger.js", () => {
  const logger = {
    info: vi.fn((msg: string, meta: Record<string, unknown>) => logged.info.push([msg, meta])),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { getLoggerSafe: () => logger, getLogger: () => logger, getLogRingBuffer: () => [] };
});

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

interface ToolCallsHost {
  executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<Array<{ isError?: boolean }>>;
}

function orchestratorWith(tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: string; isError?: boolean }> }) {
  return new Orchestrator({
    providerManager: {
      getProvider: () => ({ name: "mock", capabilities: { toolCalling: true }, chat: vi.fn() }),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [{ description: "probe", inputSchema: { type: "object", properties: {} }, ...tool }] as never,
    channel: {
      name: "mock",
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: vi.fn(),
      sendText: vi.fn(),
      sendMarkdown: vi.fn(),
      isHealthy: () => true,
    } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
  }) as unknown as ToolCallsHost;
}

const executedLines = () => logged.info.filter(([msg]) => msg === "Tool executed").map(([, meta]) => meta);

describe("a tool's duration reaches the daemon log", () => {
  beforeEach(() => {
    logged.info.length = 0;
  });

  it("writes one info line per executed tool, naming the tool and how long it took", async () => {
    const orch = orchestratorWith({
      name: "slow_probe",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { content: "done" };
      },
    });

    await orch.executeToolCalls("chat-duration", [{ id: "c1", name: "slow_probe", input: {} }], {});

    const lines = executedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ chatId: "chat-duration", tool: "slow_probe", isError: false });
    expect(lines[0]!["durationMs"]).toBeGreaterThanOrEqual(35);
  });

  it("times a failing tool too: a retry loop is where the time goes", async () => {
    const orch = orchestratorWith({
      name: "failing_probe",
      execute: async () => ({ content: "Error: nothing here", isError: true }),
    });

    await orch.executeToolCalls("chat-duration", [{ id: "c2", name: "failing_probe", input: {} }], {});

    const lines = executedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "failing_probe", isError: true });
    expect(typeof lines[0]!["durationMs"]).toBe("number");
  });
});
