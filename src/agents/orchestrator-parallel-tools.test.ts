/**
 * Tests for the intelligence-NEUTRAL read-only tool parallelization in executeToolCalls.
 *
 * The LLM often batches several INDEPENDENT read-only tool calls in one turn (e.g. 3× file_read).
 * Running them strictly serial wastes wall-clock on I/O-bound waits with no ordering dependency.
 * executeToolCalls now runs the LEADING contiguous run of parallel-safe calls (read-only, not a
 * write op, not ask_user, not a registry-mutating control tool) concurrently, then falls back to
 * the serial loop the instant a non-safe call appears — so writes stay strictly ordered and a read
 * AFTER a write stays serial. Results remain keyed by toolCallId and ordered by original position.
 */
import { Orchestrator } from "./orchestrator.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

function createMockProvider() {
  return {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn().mockResolvedValue({
      text: "Hello!",
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  };
}

function createMockChannel() {
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

/**
 * A tool whose execute() resolves after a controllable deferred barrier so we can observe
 * concurrency: if N calls are in-flight at once, `maxConcurrent` reaches N.
 */
function createTrackingTool(name: string, isWrite: boolean, tracker: { active: number; max: number }) {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(async () => {
      tracker.active++;
      tracker.max = Math.max(tracker.max, tracker.active);
      // Yield to the event loop so siblings dispatched via Promise.all can also enter before we exit.
      await new Promise((resolve) => setTimeout(resolve, 5));
      tracker.active--;
      return { content: `${name} result`, isError: isWrite ? false : false };
    }),
  };
}

function buildOrchestrator(tools: unknown[]) {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: tools as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
  });
}

describe("executeToolCalls — read-only parallelization", () => {
  it("runs a leading group of independent read-only tools concurrently, preserving id-keyed order", async () => {
    const tracker = { active: 0, max: 0 };
    const grep = createTrackingTool("grep", false, tracker);
    const list = createTrackingTool("list_directory", false, tracker);
    const read = createTrackingTool("file_read", false, tracker);
    const orch = buildOrchestrator([grep, list, read]);

    const toolCalls = [
      { id: "c1", name: "grep", input: {} },
      { id: "c2", name: "list_directory", input: {} },
      { id: "c3", name: "file_read", input: {} },
    ];
    const results = await (orch as never as {
      executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<Array<{ toolCallId: string }>>;
    }).executeToolCalls("chat-par", toolCalls, {});

    // All three read-only calls overlapped in flight (concurrency observed).
    expect(tracker.max).toBe(3);
    // Results are id-keyed and stay in original toolCall order.
    expect(results.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps a read AFTER a write strictly serial (no overlap once a write appears)", async () => {
    const tracker = { active: 0, max: 0 };
    const read1 = createTrackingTool("file_read", false, tracker);
    const write = createTrackingTool("file_write", true, tracker);
    const read2 = createTrackingTool("grep", false, tracker);
    // Register distinct tool names so each createTrackingTool maps 1:1.
    const orch = buildOrchestrator([read1, write, read2]);

    const toolCalls = [
      { id: "w1", name: "file_write", input: { path: "a.txt" } },
      { id: "r1", name: "file_read", input: {} },
      { id: "g1", name: "grep", input: {} },
    ];
    const results = await (orch as never as {
      executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<Array<{ toolCallId: string }>>;
    }).executeToolCalls("chat-serial", toolCalls, {});

    // The turn STARTS with a write → boundary is 0 → fully serial → never more than 1 in flight.
    expect(tracker.max).toBe(1);
    expect(results.map((r) => r.toolCallId)).toEqual(["w1", "r1", "g1"]);
  });

  it("parallelizes only the LEADING read group, then runs the write (and trailing read) serial", async () => {
    const tracker = { active: 0, max: 0 };
    const read1 = createTrackingTool("file_read", false, tracker);
    const grep = createTrackingTool("grep", false, tracker);
    const write = createTrackingTool("file_write", true, tracker);
    const orch = buildOrchestrator([read1, grep, write]);

    const toolCalls = [
      { id: "r1", name: "file_read", input: {} },
      { id: "g1", name: "grep", input: {} },
      { id: "w1", name: "file_write", input: { path: "a.txt" } },
    ];
    const results = await (orch as never as {
      executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<Array<{ toolCallId: string }>>;
    }).executeToolCalls("chat-lead", toolCalls, {});

    // The two leading reads overlap (max 2); the write runs after, alone.
    expect(tracker.max).toBe(2);
    expect(results.map((r) => r.toolCallId)).toEqual(["r1", "g1", "w1"]);
  });
});
