import { describe, expect, it, vi } from "vitest";
import { AgentPhase, createInitialState, transitionPhase } from "./agent-state.js";
import {
  handleBackgroundLoopRecovery,
  resolveVerifierIntervention,
  type InterventionDeps,
} from "./orchestrator-intervention-pipeline.js";
import { ControlLoopTracker } from "./autonomy/control-loop-tracker.js";
import { ExecutionJournal } from "./autonomy/execution-journal.js";
import { SelfVerification } from "./autonomy/self-verification.js";

function makeStrategy(progressAssessmentResponse = '{"verdict":"progressing","confidence":"low"}') {
  const reviewerProvider = {
    chat: vi.fn(async () => ({
      text: progressAssessmentResponse,
      usage: undefined,
    })),
  };

  return {
    task: { type: "code_generation", criticality: "normal" },
    executor: { providerName: "executor", modelId: "test-model" },
    reviewer: {
      provider: reviewerProvider,
      providerName: "reviewer",
      modelId: "test-model",
    },
    synthesizer: { providerName: "synth", modelId: "test-model" },
    planReviewer: { providerName: "planner", modelId: "test-model" },
  } as const;
}

function makeDeps(executeToolCalls = vi.fn(async () => [])): InterventionDeps {
  return {
    getReviewerAssignment: vi.fn(),
    classifyTask: vi.fn(),
    buildSupervisorRolePrompt: vi.fn(),
    systemPrompt: "test",
    clarificationContext: {
      interactionConfig: {},
      toolMetadataByName: new Map([
        ["list_directory", { readOnly: true }],
        ["file_read", { readOnly: true }],
        ["search", { readOnly: true }],
      ]),
    },
    stripInternalDecisionMarkers: vi.fn((text: string | null | undefined) => text ?? ""),
    interactionPolicy: { requirePlanReview: vi.fn() },
    formatPlanReviewMessage: vi.fn((draft: string) => draft),
    recordExecutionTrace: vi.fn(),
    recordAuxiliaryUsage: vi.fn(),
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn(),
    recordRuntimeArtifactEvaluation: vi.fn(),
    getTaskRunId: vi.fn(),
    synthesizeUserFacingResponse: vi.fn(),
    runCompletionReviewStages: vi.fn(),
    runVisibilityReview: vi.fn(async () => ({ decision: { decision: "allow", reason: "safe to surface" } })),
    executeToolCalls,
    getLogRingBuffer: vi.fn(() => []),
    buildStructuredProgressSignal: vi.fn((_prompt, _title, signal) => signal),
  } as unknown as InterventionDeps;
}

function makeBaseParams(overrides: Partial<Parameters<typeof handleBackgroundLoopRecovery>[0]> = {}) {
  return {
    chatId: "chat-1",
    identityKey: "identity-1",
    prompt: "Fix the repeated analysis loop",
    title: "Fix repeated analysis loop",
    state: transitionPhase(createInitialState("Fix the repeated analysis loop"), AgentPhase.EXECUTING),
    strategy: makeStrategy(),
    tracker: new ControlLoopTracker(),
    executionJournal: new ExecutionJournal("Fix the repeated analysis loop"),
    kind: "clarification_internal_continue" as const,
    reason: "Clarification review kept the task internal.",
    gate: "Please continue internally.",
    iteration: 1,
    availableToolNames: ["delegate_analysis"],
    selfVerification: new SelfVerification(),
    usageHandler: undefined,
    onProgress: vi.fn(),
    session: { messages: [] } as any,
    workerCollector: undefined,
    workspaceLease: undefined,
    daemonMode: true,
    maxRecoveryEpisodes: 5,
    progressAssessmentEnabled: true,
    taskStartedAtMs: Date.now() - 5_000,
    ...overrides,
  };
}

describe("handleBackgroundLoopRecovery", () => {
  it("delegates immediately when progress assessment marks the loop as stuck", async () => {
    const executeToolCalls = vi.fn(async () => [
      {
        content: "Helper found the duplicate recovery path and recommended consolidating the editor entry point.",
        isError: false,
        metadata: {},
      },
    ]);
    const deps = makeDeps(executeToolCalls);
    const tracker = new ControlLoopTracker({
      staleAnalysisThreshold: 99,
      hardCapReplan: 99,
      hardCapBlock: 100,
    });
    tracker.incrementTextOnlyGate();

    const result = await handleBackgroundLoopRecovery(
      makeBaseParams({
        tracker,
        strategy: makeStrategy(
          '{"verdict":"stuck","confidence":"high","directive":"Inspect duplicate editor entry points before replanning"}',
        ),
      }),
      deps,
    );

    expect(result.action).toBe("replan");
    expect(executeToolCalls).toHaveBeenCalledOnce();
    expect(result.gate).toContain("Delegated diagnosis:");
    expect(result.gate).toContain("Helper found the duplicate recovery path");
  });

  it("delegates on stale-analysis safety-net triggers instead of only replanning locally", async () => {
    const executeToolCalls = vi.fn(async () => [
      {
        content: "Helper identified the missing tool execution path and returned a concrete next step.",
        isError: false,
        metadata: {},
      },
    ]);
    const deps = makeDeps(executeToolCalls);
    const tracker = new ControlLoopTracker({
      staleAnalysisThreshold: 2,
      hardCapReplan: 99,
      hardCapBlock: 100,
    });
    tracker.incrementTextOnlyGate();

    const result = await handleBackgroundLoopRecovery(
      makeBaseParams({
        tracker,
        progressAssessmentEnabled: false,
      }),
      deps,
    );

    expect(result.action).toBe("replan");
    expect(executeToolCalls).toHaveBeenCalledOnce();
    expect(result.gate).toContain("Delegated diagnosis:");
    expect(result.gate).toContain("missing tool execution path");
  });

  it("uses delegation on hard-cap replans when a helper tool is available", async () => {
    const executeToolCalls = vi.fn(async () => [
      {
        content: "Helper mapped the hard-cap stall to a concrete delegated recovery path.",
        isError: false,
        metadata: {},
      },
    ]);
    const deps = makeDeps(executeToolCalls);
    const tracker = new ControlLoopTracker({
      staleAnalysisThreshold: 99,
      hardCapReplan: 2,
      hardCapBlock: 6,
    });
    tracker.incrementTextOnlyGate();

    const result = await handleBackgroundLoopRecovery(
      makeBaseParams({
        tracker,
        progressAssessmentEnabled: false,
      }),
      deps,
    );

    expect(result.action).toBe("replan");
    expect(executeToolCalls).toHaveBeenCalledOnce();
    expect(result.gate).toContain("Delegated diagnosis:");
    expect(result.gate).toContain("hard-cap stall");
  });

  it("keeps stuck progress assessments internal until max recovery episodes are exhausted", async () => {
    const deps = makeDeps();
    const tracker = new ControlLoopTracker({
      staleAnalysisThreshold: 99,
      hardCapReplan: 99,
      hardCapBlock: 100,
      maxRecoveryEpisodes: 5,
    });
    tracker.markRecoveryAttempt("progress_assessment_stuck:clarification_internal_continue");
    tracker.incrementTextOnlyGate();

    const result = await handleBackgroundLoopRecovery(
      makeBaseParams({
        tracker,
        availableToolNames: [],
        strategy: makeStrategy(
          '{"verdict":"stuck","confidence":"high","directive":"Use a tool to create the file, read it, then delete it immediately."}',
        ),
      }),
      deps,
    );

    expect(result.action).toBe("replan");
    expect(result.gate).toContain("Required next action: Use a tool to create the file");
  });
});

describe("resolveVerifierIntervention", () => {
  it("uses visibility review to keep multilingual handoff drafts internal", async () => {
    const deps = makeDeps();
    const runVisibilityReview = vi.fn(async () => ({
      decision: {
        decision: "internal_continue" as const,
        reason: "The draft is a handoff that gives the next engineering step back to the user.",
        recommendedNextAction: "Continue the repository audit internally and inspect the duplicate editor paths directly.",
      },
    }));
    deps.runVisibilityReview = runVisibilityReview as never;

    const state = transitionPhase(createInitialState("Audit the duplicate editors"), AgentPhase.EXECUTING);
    state.stepResults.push({
      toolName: "list_directory",
      success: true,
      summary: "Listed Assets/Game/LevelEditor/Editor/Windows",
      timestamp: Date.now() - 200,
    });

    const result = await resolveVerifierIntervention({
      chatId: "chat-visibility-review",
      identityKey: "identity-1",
      executionMode: "background",
      prompt: "Projeyi audit et ve duplicate level editorleri bularak ilerle.",
      state,
      draft: "Yaklaşımım netleşti. İstersen bir sonraki adımda bunu plan olmaktan çıkarıp direkt repo üzerinde audit’e başlayayım: önce duplicate level editor’leri bulayım, sonra mevcut 100 level’ın ne kadar bozuk olduğunu ölçeyim.",
      selfVerification: new SelfVerification(),
      stradaConformance: { getPrompt: () => null } as any,
      strategy: {
        ...makeStrategy(),
        task: { type: "analysis", complexity: "moderate", criticality: "medium" },
      } as any,
      taskStartedAtMs: Date.now() - 1000,
      availableToolNames: ["list_directory", "file_read", "search"],
      usageHandler: undefined,
    }, deps);

    expect(runVisibilityReview).toHaveBeenCalledOnce();
    expect(result.kind).toBe("continue");
    expect(result.gate).toContain("[VISIBILITY REVIEW REQUIRED]");
  });
});
