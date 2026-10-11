/**
 * Loop recovery in the V2 spine fires a delegate (delegate_code_review, …)
 * through the intervention pipeline, whose executeToolCalls scopes the tool
 * to `workspaceLease?.path ?? projectPath`. Both background context builders
 * passed `workspaceLease: undefined`, so a delegate fired inside a leased
 * background run got the PROJECT ROOT as its caller tree: it reviewed a tree
 * without the run's edits and published into the real project behind the
 * run's lease (review 2026-10-11, multi-agent#1's remaining half).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../agents/orchestrator-end-turn-handler.js", () => ({
  handleBgEndTurn: vi.fn(),
  handleInteractiveEndTurn: vi.fn(),
}));
vi.mock("../../agents/orchestrator-reflection-handler.js", () => ({
  handleBgReflectionDone: vi.fn(),
  handleBgReflectionReplan: vi.fn(),
  handleBgReflectionContinue: vi.fn(),
  handleInteractiveReflectionDone: vi.fn(),
  handleInteractiveReflectionReplan: vi.fn(),
  handleInteractiveReflectionContinue: vi.fn(),
}));
vi.mock("./render.js", () => ({
  emitVisibleBoundary: vi.fn(async (_d: unknown, _c: unknown, _s: unknown, text: string) => ({ text, marked: false })),
  sanitizeBlockedVisibleText: vi.fn((_d: unknown, text: string) => ({ text, marked: false })),
}));

import { handleBgEndTurn } from "../../agents/orchestrator-end-turn-handler.js";
import { handleBgReflectionContinue, handleBgReflectionDone } from "../../agents/orchestrator-reflection-handler.js";
import { portDispatchEndTurn, portDispatchReflection, type ReflectionDeps } from "./reflection.js";
import type { EngineRunContext } from "./engine-deps.js";
import type { WorkspaceLease } from "../../agents/multi/workspace-lease-manager.js";
import { createInitialState } from "../../agents/agent-state.js";

const bgEndTurn = vi.mocked(handleBgEndTurn);
const bgReflectionDone = vi.mocked(handleBgReflectionDone);
const bgReflectionContinue = vi.mocked(handleBgReflectionContinue);

const lease = { id: "lease-1", path: "/leases/task-1", sourceRoot: "/project" } as unknown as WorkspaceLease;

function deps(): ReflectionDeps {
  return {
    sessionManager: {
      getPendingSelfManagedWriteRejectionVisibleText: () => null,
      extractLastUserMessage: () => "build the board",
      formatBoundaryVisibleText: (b: { visibleText: string }) => b.visibleText,
      appendVisibleAssistantMessage: () => {},
      persistSessionToMemory: async () => {},
      getVisibleTranscript: () => [],
    },
    buildInterventionDeps: () => ({}),
    taskClassifier: { classify: () => ({ type: "code_generation", criticality: "normal" }) },
    progressAssessmentEnabled: false,
    buildStructuredProgressSignal: (_p: unknown, _t: unknown, s: unknown) => s,
    getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: new Map() }),
    synthesizeUserFacingResponse: async () => "",
  } as unknown as ReflectionDeps;
}

function runCtx(workspaceLease: WorkspaceLease | undefined): EngineRunContext {
  return {
    chatId: "c",
    identityKey: "u",
    session: { messages: [] },
    executionStrategy: {},
    lastToolNames: [],
    systemPrompt: "s",
    emitProgress: () => {},
    workspaceLease,
  } as unknown as EngineRunContext;
}

const params = (extra: Record<string, unknown> = {}) =>
  ({ mode: "background", agentState: createInitialState("build the board"), responseText: "Done.", chatId: "c", ...extra }) as never;

describe("V2 loop recovery runs in the run's own workspace", () => {
  beforeEach(() => {
    bgEndTurn.mockReset();
    bgReflectionDone.mockReset();
    bgReflectionContinue.mockReset();
  });

  it("the background end-turn context carries the run's lease", async () => {
    bgEndTurn.mockResolvedValue({ flow: "done", newState: createInitialState("x"), visibleText: "ok" } as never);

    await portDispatchEndTurn(deps(), params(), runCtx(lease));

    expect(bgEndTurn.mock.calls[0]![1].workspaceLease).toBe(lease);
  });

  it("the background reflection context carries the run's lease, on DONE and on CONTINUE", async () => {
    bgReflectionDone.mockResolvedValue({ flow: "done", newState: createInitialState("x"), visibleText: "ok" } as never);
    bgReflectionContinue.mockResolvedValue({ flow: "continue", newState: createInitialState("x") } as never);

    await portDispatchReflection(deps(), params({ decision: "DONE" }), runCtx(lease));
    await portDispatchReflection(deps(), params({ decision: "CONTINUE" }), runCtx(lease));

    expect(bgReflectionDone.mock.calls[0]![1].workspaceLease).toBe(lease);
    expect(bgReflectionContinue.mock.calls[0]![1].workspaceLease).toBe(lease);
  });

  it("a run without a lease still hands none on", async () => {
    bgEndTurn.mockResolvedValue({ flow: "done", newState: createInitialState("x"), visibleText: "ok" } as never);

    await portDispatchEndTurn(deps(), params(), runCtx(undefined));

    expect(bgEndTurn.mock.calls[0]![1].workspaceLease).toBeUndefined();
  });
});
