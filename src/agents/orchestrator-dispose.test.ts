/**
 * ORC-11 — an Orchestrator is built per agent and per delegation. dispose() releases what the
 * instance holds past its useful life, so constructing and disposing many leaves no timers.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

const { Orchestrator } = await import("./orchestrator.js");

function build() {
  return new Orchestrator({
    providerManager: {
      getProvider: vi.fn(),
      getActiveInfo: () => ({ providerName: "mock", model: "mock-model", isDefault: true }),
      shutdown: vi.fn(),
    },
    tools: [],
    channel: { name: "mock", connect: vi.fn(), disconnect: vi.fn(), onMessage: vi.fn(), sendText: vi.fn(), sendMarkdown: vi.fn(), isHealthy: () => true },
    projectPath: "/tmp/dispose-project",
    readOnly: false,
    requireConfirmation: false,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Orchestrator.dispose (ORC-11)", () => {
  it("constructing and disposing 50 orchestrators leaves the timer count at its baseline", () => {
    vi.useFakeTimers();
    const baseline = vi.getTimerCount();
    for (let i = 0; i < 50; i++) build().dispose();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("detaches the budget-config listener", () => {
    const orch = build();
    const unsubscribe = vi.fn();
    orch.setUnifiedBudgetManager({ onConfigUpdated: () => unsubscribe } as never);
    orch.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
