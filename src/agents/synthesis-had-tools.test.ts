/**
 * "Had tools" means the run used tools, not "fewer than 50 tool calls so far".
 *
 * audited 2026-09-02: both synthesis gates inferred tool use from
 * `stepResults.length >= iteration`. iteration only grows while stepResults
 * is capped at 50, so the test was true for exactly the first 50 tool calls
 * of a run and false for every turn after. A long run classified
 * simple-question then skipped synthesis and surfaced the raw draft — tool
 * summaries and all — verbatim.
 */

import { describe, it, expect, vi } from "vitest";
import { shouldSynthesize } from "./orchestrator-end-turn-handler.js";
import { resolveVisibleDraftDecision } from "./orchestrator-intervention-pipeline.js";
import { createInitialState, type AgentState, type StepResult } from "./agent-state.js";

function longRunState(toolCalls: number): AgentState {
  const steps: StepResult[] = Array.from({ length: Math.min(50, toolCalls) }, (_, i) => ({
    toolName: "file_read",
    success: true,
    summary: `read ${i}`,
    timestamp: 0,
  }));
  return { ...createInitialState("what is failing?"), iteration: toolCalls, stepResults: steps };
}

const SIMPLE = { type: "simple-question", complexity: "simple" } as any;
const CLEAN_DRAFT = "STEP 63/63 file_read Assets/Modules/Board/Board.cs -> ok. The board module is failing on input.";

describe("shouldSynthesize on a run that used tools", () => {
  it("synthesizes after the 50-step window is full, exactly as it did before", () => {
    expect(shouldSynthesize(CLEAN_DRAFT, longRunState(50), SIMPLE), "50 calls").toBe(true);
    expect(shouldSynthesize(CLEAN_DRAFT, longRunState(51), SIMPLE), "51 calls").toBe(true);
    expect(shouldSynthesize(CLEAN_DRAFT, longRunState(63), SIMPLE), "63 calls").toBe(true);
  });

  it("still bypasses synthesis for a clean direct answer with no tool use", () => {
    expect(shouldSynthesize("The board module is failing on input.", longRunState(0), SIMPLE)).toBe(false);
  });
});

describe("the interactive decision's inline copy", () => {
  const deps = () => ({
    stripInternalDecisionMarkers: (t: string) => t ?? "",
    interactionPolicy: { requirePlanReview: vi.fn() },
    formatPlanReviewMessage: (d: string) => d,
    clarificationContext: { interactionConfig: {}, toolMetadataByName: {} },
    synthesizeUserFacingResponse: vi.fn(async (p: { draft: string }) => `synthesized: ${p.draft}`),
  }) as any;

  const decide = (state: AgentState, d: ReturnType<typeof deps>) =>
    resolveVisibleDraftDecision({
      chatId: "c",
      identityKey: "u",
      prompt: "what is failing?",
      draft: CLEAN_DRAFT,
      agentState: state,
      strategy: { task: SIMPLE } as any,
      systemPrompt: "s",
      selfVerification: { getState: () => ({ touchedFiles: [], hasCompilableChanges: false }) } as any,
      taskStartedAtMs: Date.now(),
      availableToolNames: [],
    }, d);

  it("synthesizes a tool-using run's draft after 50 tool calls too", async () => {
    const d = deps();
    await decide(longRunState(63), d);
    expect(d.synthesizeUserFacingResponse, "raw draft surfaced without synthesis").toHaveBeenCalledTimes(1);
  });
});
