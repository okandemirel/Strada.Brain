/**
 * Audit 01.1 (2026-09-13) + Codex plan review #1 (2026-09-16), plan 0-A.1.
 *
 * The background end-turn handler settles NOT DELIVERED as
 * `{ flow: "done", status: "blocked" }`, loop recovery as `{ flow: "blocked" }`,
 * and a write rejected by the autonomous safety review returns from
 * portDispatchEndTurn before either. None of the three carried a terminal
 * status, so the spine's default "completed" closed the task row and told the
 * dev-knowledge hook `success: true` for a run that had just said it could
 * not deliver. Only `status: "failed"` was threaded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../agents/orchestrator-end-turn-handler.js", () => ({
  handleBgEndTurn: vi.fn(),
  handleInteractiveEndTurn: vi.fn(),
}));
vi.mock("./render.js", () => ({
  emitVisibleBoundary: vi.fn(async (_d: unknown, _c: unknown, _s: unknown, text: string) => ({
    text,
    marked: false,
  })),
  // Background runs record the boundary text without rendering it (ORC-1).
  sanitizeBlockedVisibleText: vi.fn((_d: unknown, text: string) => ({ text, marked: false })),
}));

import { handleBgEndTurn, handleInteractiveEndTurn } from "../../agents/orchestrator-end-turn-handler.js";
import { portDispatchEndTurn, type ReflectionDeps } from "./reflection.js";
import type { EngineRunContext } from "./engine-deps.js";
import { createInitialState } from "../../agents/agent-state.js";

const bgEndTurn = vi.mocked(handleBgEndTurn);
const interactiveEndTurn = vi.mocked(handleInteractiveEndTurn);

function deps(rejectionText: string | null = null, toolMetadataByName: Map<string, { readOnly?: boolean }> = new Map()): ReflectionDeps {
  return {
    sessionManager: {
      getPendingSelfManagedWriteRejectionVisibleText: (_s: unknown, _d: unknown, isWriteCapable?: (n: string) => boolean) =>
        typeof rejectionText === "function" ? (rejectionText as (p: (n: string) => boolean) => string | null)(isWriteCapable!) : rejectionText,
      extractLastUserMessage: () => "build the game",
      formatBoundaryVisibleText: (b: { visibleText: string }) => b.visibleText,
      appendVisibleAssistantMessage: () => {},
      persistSessionToMemory: async () => {},
      getVisibleTranscript: () => [],
    },
    buildInterventionDeps: () => ({}),
    taskClassifier: { classify: () => ({ type: "code_generation", criticality: "normal" }) },
    progressAssessmentEnabled: false,
    buildStructuredProgressSignal: (_p: unknown, _t: unknown, s: unknown) => s,
    getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName }),
    synthesizeUserFacingResponse: async () => "",
  } as unknown as ReflectionDeps;
}

function runCtx(): EngineRunContext {
  return {
    chatId: "c",
    identityKey: "u",
    session: { messages: [] },
    executionStrategy: {},
    lastToolNames: [],
    systemPrompt: "s",
    emitProgress: () => {},
  } as unknown as EngineRunContext;
}

const state = () => createInitialState("build the game");

function params(mode: "background" | "interactive") {
  return { mode, agentState: state(), responseText: "Done.", chatId: "c", session: { messages: [] } } as never;
}

describe("portDispatchEndTurn carries a blocked settlement (audit 01.1)", () => {
  beforeEach(() => {
    bgEndTurn.mockReset();
    interactiveEndTurn.mockReset();
  });

  it("NOT DELIVERED (flow done, status blocked) → terminalStatus blocked in background", async () => {
    bgEndTurn.mockResolvedValue({ flow: "done", visibleText: "NOT DELIVERED: …", newState: state(), status: "blocked" });
    const out = await portDispatchEndTurn(deps(), params("background"), runCtx());
    expect(out.terminalStatus).toBe("blocked");
    expect(out.continueRun).toBeFalsy();
  });

  it("a loop-detected stop (flow blocked) → terminalStatus blocked in background", async () => {
    bgEndTurn.mockResolvedValue({ flow: "blocked", visibleText: "stopped: repeating itself" });
    const out = await portDispatchEndTurn(deps(), params("background"), runCtx());
    expect(out.terminalStatus).toBe("blocked");
  });

  it("a rejected self-managed write acknowledged with an empty done → terminalStatus blocked (Codex #1)", async () => {
    const out = await portDispatchEndTurn(deps("The write was blocked by safety review."), params("background"), runCtx());
    expect(bgEndTurn).not.toHaveBeenCalled();
    expect(out.finalText).toContain("blocked by safety review");
    expect(out.terminalStatus).toBe("blocked");
  });

  it("only an EXPLICIT readOnly:false makes a tool a writer for the rejection check (Codex 2026-09-17 #5)", async () => {
    const seen: Record<string, boolean> = {};
    const probe = ((isWriteCapable: (n: string) => boolean) => {
      for (const n of ["file_write", "file_read", "unknown_tool"]) seen[n] = isWriteCapable(n);
      return null;
    }) as unknown as string;
    const meta = new Map<string, { readOnly?: boolean }>([["file_write", { readOnly: false }], ["file_read", {}]]);
    bgEndTurn.mockResolvedValue({ flow: "done", visibleText: "ok", newState: state(), status: "completed" });
    await portDispatchEndTurn(deps(probe, meta), params("background"), runCtx());
    expect(seen).toEqual({ file_write: true, file_read: false, unknown_tool: false });
  });

  it("a failed settlement is still failed", async () => {
    bgEndTurn.mockResolvedValue({ flow: "done", visibleText: "could not", newState: state(), status: "failed" });
    const out = await portDispatchEndTurn(deps(), params("background"), runCtx());
    expect(out.terminalStatus).toBe("failed");
  });

  it("a clean completion carries no terminal status (guard: correct work is still completed)", async () => {
    bgEndTurn.mockResolvedValue({ flow: "done", visibleText: "Shipped.", newState: state(), status: "completed" });
    const out = await portDispatchEndTurn(deps(), params("background"), runCtx());
    expect(out.terminalStatus).toBeUndefined();
  });

  it("an interactive turn that stopped on a block keeps the spine's default (the person read the notice)", async () => {
    interactiveEndTurn.mockResolvedValue({ flow: "blocked", visibleText: "stopped" });
    const out = await portDispatchEndTurn(deps(), params("interactive"), runCtx());
    expect(out.terminalStatus).toBeUndefined();
    const rejected = await portDispatchEndTurn(deps("blocked write"), params("interactive"), runCtx());
    expect(rejected.terminalStatus).toBeUndefined();
  });
});
