/**
 * audited 2026-09-02: the Provider Health Awareness prompt section must describe a signal the
 * model can actually receive. It used to tell the model to watch for "[Provider Health Report]"
 * messages whose only producer had no callers since the v1 engine was deleted.
 */
import { describe, expect, it } from "vitest";
import { buildProviderHealthAwareness, prepareIteration, type PrepareIterationDeps, type PrepareIterationParams } from "./prepare-iteration.js";
import { AgentPhase, createInitialState, type AgentState } from "../../agents/agent-state.js";
import { ExecutionJournal } from "../../agents/autonomy/execution-journal.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import { TURN_CONTEXT_HEADER } from "../../agents/turn-context.js";
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
  const deps: PrepareIterationDeps = {
    getSupervisorRoutingContext: () => ({ providerManager: {} }) as unknown as SupervisorRoutingContext,
    buildWorkerToolDefinitions: (_task, phase) => [
      { name: "file_read", description: "Read a file", input_schema: { type: "object" } },
      ...(phase === AgentPhase.EXECUTING ? [{ name: "file_write", description: "Write a file", input_schema: { type: "object" } }] : []),
    ],
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

  it("keeps the system prompt across a phase change: only the tools and the turn context follow the phase", () => {
    const planning = prepareIteration(deps, params(createInitialState("write two files")));
    const acting = prepareIteration(deps, params(executing));

    expect(acting.activePrompt).toBe(planning.activePrompt);
    expect(planning.currentToolNames).toEqual(["file_read"]);
    expect(acting.currentToolNames).toEqual(["file_read", "file_write"]);
    expect(planning.turnContext).toContain("Current worker role: planner");
    expect(acting.turnContext).toContain("Current worker role: executor");
  });
});
