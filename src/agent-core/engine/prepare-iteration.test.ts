/**
 * audited 2026-09-02: the Provider Health Awareness prompt section must describe a signal the
 * model can actually receive. It used to tell the model to watch for "[Provider Health Report]"
 * messages whose only producer had no callers since the v1 engine was deleted.
 */
import { describe, expect, it, vi } from "vitest";
import { buildProviderHealthAwareness, prepareIteration, type PrepareIterationDeps, type PrepareIterationParams } from "./prepare-iteration.js";
import { AgentPhase, createInitialState, type AgentState } from "../../agents/agent-state.js";
import { ExecutionJournal } from "../../agents/autonomy/execution-journal.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import { TURN_CONTEXT_HEADER } from "../../agents/turn-context.js";
import { phaseWriteRefusal } from "./phase-write-access.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { SupervisorAssignment, SupervisorExecutionStrategy, SupervisorRoutingContext } from "../../agents/orchestrator-supervisor-routing.js";

describe("buildProviderHealthAwareness", () => {
  it("is absent while no failure has occurred", () => {
    expect(buildProviderHealthAwareness({ getTotalFailures: () => 0, getFailureRate: () => 0 })).toBeUndefined();
  });

  it("states the live count and rate, names the reflection-prompt signal, and never points at a message nothing injects", () => {
    const section = buildProviderHealthAwareness({ getTotalFailures: () => 2, getFailureRate: () => 0.5 });
    expect(section).toBeDefined();
    expect(section).toContain("## Provider Health Awareness");
    expect(section).toContain("2 failure(s)");
    expect(section).toContain("50%");
    expect(section).toContain("**PROVIDER HEALTH**");
    expect(section).not.toContain("[Provider Health Report]");
    // The adaptation directive is unconditional — not gated behind any conditional phrasing.
    expect(section).toContain("Adapt your approach");
  });
});

/**
 * The system prompt is the same bytes on consecutive calls, so the provider's prefix cache
 * reaches the history behind it. What a step rebuilds (plan, iteration, last reflection,
 * execution journal, role, provider health) goes into the turn context, which the call sends
 * after its last user turn (src/agents/turn-context.ts). Measured before this: the system prompt
 * changed length on 93–95% of consecutive calls in a session (compaction-replay over daemon logs).
 */
describe("prepareIteration: a byte-stable system prompt", () => {
  const SYSTEM = "You are the worker.\n\n## Project\nA tiny project.";
  const provider = { name: "worker", capabilities: {} } as unknown as IAIProvider;
  const assign = (role: SupervisorAssignment["role"]): SupervisorAssignment => ({
    role,
    providerName: "worker",
    modelId: "worker-model",
    provider,
    reason: "pinned by the test",
  });
  const strategy: SupervisorExecutionStrategy = {
    task: { type: "code-generation", complexity: "moderate", criticality: "medium" },
    planner: assign("planner"),
    executor: assign("executor"),
    reviewer: assign("reviewer"),
    synthesizer: assign("synthesizer"),
    usesMultipleProviders: false,
    providerPinned: true,
  };
  // A shell that still filtered by phase if it were handed one, as buildWorkerToolDefinitions did
  // until 2026-11-11: the list it returns follows the phase only if prepareIteration passes it.
  const buildWorkerToolDefinitions = vi.fn((...args: unknown[]) => [
    { name: "file_read", description: "Read a file", input_schema: { type: "object" } },
    ...(args[1] === undefined || args[1] === AgentPhase.EXECUTING
      ? [{ name: "file_write", description: "Write a file", input_schema: { type: "object" } }]
      : []),
  ]);
  const deps: PrepareIterationDeps = {
    getSupervisorRoutingContext: () => ({ providerManager: {} }) as unknown as SupervisorRoutingContext,
    buildWorkerToolDefinitions,
  };
  const journal = new ExecutionJournal("write two files");
  const health = new IterationHealthTracker();
  const params = (agentState: AgentState): PrepareIterationParams => ({
    prompt: "write two files",
    identityKey: "user-1",
    agentState,
    executionJournal: journal,
    systemPrompt: SYSTEM,
    fallbackProvider: provider,
    toolTurnAffinity: null,
    enableGoalDetection: false,
    fixedExecutionStrategy: strategy,
    iterationHealth: health,
  });
  const executing: AgentState = { ...createInitialState("write two files"), phase: AgentPhase.EXECUTING, plan: "1. write a\n2. write b", iteration: 1 };

  it("sends the same system prompt and tools on consecutive EXECUTING steps, and moves what changed into the turn context", () => {
    const first = prepareIteration(deps, params(executing));
    // Between the two steps: a tool batch, a reflection and a provider failure.
    journal.recordToolBatch({
      phase: AgentPhase.EXECUTING,
      toolCalls: [{ id: "c1", name: "file_write", input: { path: "a.txt" } }],
      toolResults: [{ toolCallId: "c1", content: "File written: a.txt", isError: false }],
    });
    health.recordFailure("worker");
    const second = prepareIteration(deps, params({ ...executing, iteration: 2, lastReflection: "Continue with b." }));

    expect(first.activePrompt).toBe(SYSTEM);
    expect(second.activePrompt).toBe(first.activePrompt);
    expect(JSON.stringify(second.currentToolDefinitions)).toBe(JSON.stringify(first.currentToolDefinitions));

    expect(first.turnContext.startsWith(TURN_CONTEXT_HEADER)).toBe(true);
    expect(first.turnContext).toContain("## Current Plan\n\n1. write a\n2. write b");
    expect(first.turnContext).toContain("Current iteration: 1");
    expect(first.turnContext).toContain("Current worker role: executor");
    expect(first.turnContext).not.toContain("## Provider Health Awareness");
    expect(second.turnContext).toContain("Current iteration: 2");
    expect(second.turnContext).toContain("### Last Reflection\n\nContinue with b.");
    expect(second.turnContext).toContain("Recent execution memory:\n- OK file_write: File written: a.txt");
    expect(second.turnContext).toContain("## Provider Health Awareness");
  });

  it("keeps the system prompt and the tool list across every phase change: only the turn context follows the phase", () => {
    // The tool schemas come before the history too. Hiding the write tools while planning,
    // replanning or reflecting changed the list on 35–46% of consecutive calls in the replayed
    // daemon logs, and every change missed the whole history in the provider's prefix cache.
    const phases = [AgentPhase.PLANNING, AgentPhase.EXECUTING, AgentPhase.REFLECTING, AgentPhase.REPLANNING];
    const prepared = phases.map((phase) =>
      prepareIteration(deps, params({ ...executing, phase })),
    );
    const [planning, acting, reflecting, replanning] = prepared as [
      (typeof prepared)[0], (typeof prepared)[0], (typeof prepared)[0], (typeof prepared)[0],
    ];

    for (const step of prepared) {
      expect(step.activePrompt).toBe(planning.activePrompt);
      expect(JSON.stringify(step.currentToolDefinitions)).toBe(JSON.stringify(acting.currentToolDefinitions));
    }
    expect(acting.currentToolNames).toEqual(["file_read", "file_write"]);
    // The shell is given the task alone: nothing it is handed names the phase or the role.
    for (const call of buildWorkerToolDefinitions.mock.calls) {
      expect(call).toEqual([strategy.task]);
    }
    expect(planning.turnContext).toContain("Current worker role: planner");
    expect(acting.turnContext).toContain("Current worker role: executor");
    expect(reflecting.turnContext).toContain("Current worker role: reviewer");
    expect(replanning.turnContext).toContain("Current worker role: planner");
  });

  it("says in the turn context of a phase that does not write that a write is refused, and nowhere else", () => {
    // The list no longer shows the phase, so the turn context says what the gate does
    // (phaseWriteRefusal, the result a write called in such a phase gets).
    const turnContextIn = (phase: AgentPhase): string => prepareIteration(deps, params({ ...executing, phase })).turnContext;
    for (const phase of [AgentPhase.PLANNING, AgentPhase.REPLANNING, AgentPhase.REFLECTING]) {
      const context = turnContextIn(phase);
      expect(context, phase).toContain("## Writes in this phase");
      expect(context, phase).toContain(`The agent is ${phase}.`);
      expect(context, phase).toContain(
        "a write tool called now does not run: it is answered with a refusal, and writes run in the executing phase.",
      );
      expect(phaseWriteRefusal(phase)).toContain("writes run in the executing phase");
    }
    expect(turnContextIn(AgentPhase.REFLECTING)).toContain("A tool call made in it is not run.");
    expect(turnContextIn(AgentPhase.EXECUTING)).not.toContain("## Writes in this phase");
  });
});
