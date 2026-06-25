/**
 * orchestrator-goal-decomposition — FIX 2 surfacing tests.
 *
 * Verifies that a genuine provider OUTAGE during proactive goal decomposition
 * (all-providers-failed / first-response timeout, surfaced as a
 * {@link GoalDecompositionProviderError}) is NOT swallowed into a silent PENDING
 * state. Instead it must:
 *   (a) surface a clear user-facing notice (system pill / chat) via
 *       sendVisibleAssistantNotice, and
 *   (b) settle the monitor episode as FAILED via monitorLifecycle.requestEnd(scope, true),
 *   (c) re-throw the typed error so the run terminates cleanly.
 *
 * It also verifies that a transient parse/validation failure stays silent (returns
 * the original agentState unchanged, no notice, no requestEnd) — the existing
 * single-node fallback behavior is preserved.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { runProactiveGoalDecomposition } from "./orchestrator-goal-decomposition.js";
import type { GoalDecompositionDeps } from "./orchestrator-goal-decomposition.js";
import { GoalDecompositionProviderError } from "../goals/goal-decomposer.js";
import { createInitialState } from "./agent-state.js";
import type { Session } from "./orchestrator-session-manager.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try {
    createLogger("error", "/tmp/strada-goal-decomp-test.log");
  } catch {
    /* already initialized */
  }
});

function buildSession(): Session {
  return {
    messages: [],
    lastActivity: new Date(),
  };
}

function buildDeps(overrides: {
  decomposeProactive: () => Promise<unknown>;
  sendVisibleAssistantNotice?: ReturnType<typeof vi.fn>;
  requestEnd?: ReturnType<typeof vi.fn>;
}): {
  deps: GoalDecompositionDeps;
  sendVisibleAssistantNotice: ReturnType<typeof vi.fn>;
  sendVisibleAssistantMarkdown: ReturnType<typeof vi.fn>;
  requestEnd: ReturnType<typeof vi.fn>;
} {
  const sendVisibleAssistantNotice = overrides.sendVisibleAssistantNotice ?? vi.fn(async () => {});
  const sendVisibleAssistantMarkdown = vi.fn(async () => {});
  const requestEnd = overrides.requestEnd ?? vi.fn();

  const deps = {
    goalDecomposer: {
      shouldDecompose: () => true,
      decomposeProactive: vi.fn(overrides.decomposeProactive),
    } as unknown as GoalDecompositionDeps["goalDecomposer"],
    activeGoalTrees: new Map(),
    sessionManager: {
      sendVisibleAssistantNotice,
      sendVisibleAssistantMarkdown,
    } as unknown as GoalDecompositionDeps["sessionManager"],
    monitorLifecycle: {
      goalDecomposed: vi.fn(),
      requestEnd,
    } as unknown as GoalDecompositionDeps["monitorLifecycle"],
    eventEmitter: null,
    workspaceBus: null,
  } satisfies GoalDecompositionDeps;

  return { deps, sendVisibleAssistantNotice, sendVisibleAssistantMarkdown, requestEnd };
}

describe("runProactiveGoalDecomposition — provider-outage surfacing (FIX 2)", () => {
  const baseOpts = {
    conversationScope: "scope-1",
    userMessage: "Build a complex multi-step feature that requires decomposition into goals",
    chatId: "chat-1",
    session: buildSession(),
    agentState: createInitialState("Build a complex multi-step feature"),
    language: "en",
  };

  it("surfaces a notice + settles the monitor as FAILED + re-throws on a provider outage", async () => {
    const { deps, sendVisibleAssistantNotice, requestEnd } = buildDeps({
      decomposeProactive: async () => {
        throw new GoalDecompositionProviderError(
          'Provider "x" sent no response within 90000ms (unresponsive endpoint or model)',
        );
      },
    });

    await expect(
      runProactiveGoalDecomposition(deps, baseOpts),
    ).rejects.toBeInstanceOf(GoalDecompositionProviderError);

    // (a) user-facing notice surfaced (system pill / chat).
    expect(sendVisibleAssistantNotice).toHaveBeenCalledTimes(1);
    const noticeText = sendVisibleAssistantNotice.mock.calls[0]?.[2] as string;
    expect(noticeText).toMatch(/not responding|provider/i);

    // (b) monitor episode settled as FAILED (failed=true), not left pending.
    expect(requestEnd).toHaveBeenCalledTimes(1);
    expect(requestEnd).toHaveBeenCalledWith("scope-1", true);
  });

  it("localizes the outage notice to the resolved language", async () => {
    const { deps, sendVisibleAssistantNotice } = buildDeps({
      decomposeProactive: async () => {
        throw new GoalDecompositionProviderError("All providers failed");
      },
    });

    await expect(
      runProactiveGoalDecomposition(deps, { ...baseOpts, language: "tr" }),
    ).rejects.toBeInstanceOf(GoalDecompositionProviderError);

    const noticeText = sendVisibleAssistantNotice.mock.calls[0]?.[2] as string;
    // Turkish provider_abort message contains "yapay zeka sağlayıcısı".
    expect(noticeText).toContain("sağlayıcı");
  });

  it("still re-throws even if surfacing the notice itself fails", async () => {
    const failingNotice = vi.fn(async () => {
      throw new Error("channel down");
    });
    const { deps, requestEnd } = buildDeps({
      decomposeProactive: async () => {
        throw new GoalDecompositionProviderError("All providers failed");
      },
      sendVisibleAssistantNotice: failingNotice,
    });

    await expect(
      runProactiveGoalDecomposition(deps, baseOpts),
    ).rejects.toBeInstanceOf(GoalDecompositionProviderError);

    // The monitor is still settled FAILED even though the notice send threw.
    expect(requestEnd).toHaveBeenCalledWith("scope-1", true);
  });

  it("does NOT surface or fail on a transient (non-outage) decomposition error", async () => {
    const { deps, sendVisibleAssistantNotice, requestEnd } = buildDeps({
      decomposeProactive: async () => {
        // A non-outage error (e.g. a bug) → swallowed, original state returned.
        throw new Error("some transient internal hiccup");
      },
    });

    const result = await runProactiveGoalDecomposition(deps, baseOpts);

    // Original agentState returned unchanged — no surfacing, no terminal-fail.
    expect(result).toBe(baseOpts.agentState);
    expect(sendVisibleAssistantNotice).not.toHaveBeenCalled();
    expect(requestEnd).not.toHaveBeenCalled();
  });
});
