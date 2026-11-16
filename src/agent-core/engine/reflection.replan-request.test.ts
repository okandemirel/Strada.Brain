/**
 * After a REPLAN the plan phase reads what the person asked, not the replan prompt.
 *
 * An interactive REPLAN pushes "Please create a new plan." as a user-role turn
 * (portDispatchReflection), and the REPLANNING plan phase then reads the
 * session's last user message (portHandlePlanPhase) for the goal hand-off, the
 * plan-review decision and proactive decomposition (port.ts
 * decomposeGoalsIfPlanning). That read returned the replan prompt. v1 read
 * the person's message once at setup (orchestrator.ts:5392 before 83270634)
 * and used it in both PLANNING and REPLANNING, so "show me the plan before you
 * change anything" re-presented a replanned plan for review. The prompt is now
 * pushed as a system turn (pushSystemTurn), which the read passes over.
 */

import { describe, it, expect, vi } from "vitest";
import { portDispatchReflection, portHandlePlanPhase, type ReflectionDeps } from "./reflection.js";
import { createAgentCorePort, type PortDeps } from "./port.js";
import type { AgentEngine } from "./agent-engine.js";
import type { EngineRunContext } from "./engine-deps.js";
import { AgentPhase, createInitialState, transitionPhase } from "../../agents/agent-state.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { SessionManager } from "../../agents/orchestrator-session-manager.js";

const SAID = "Show me the plan before you change anything in the invoice exporter";
const REPLAN_PROMPT = "Please create a new plan.";
const PLAN_DRAFT = "## Plan\n1. Read the exporter module\n2. Add the CSV option\n3. Run the tests";

function sessionManager(): SessionManager {
  return new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn() },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
}

function harness() {
  const sm = sessionManager();
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleUserMessage(session, SAID);
  const bundle = createAutonomyBundle({ prompt: SAID, iterationBudget: 20 });
  const runCtx = {
    session,
    requestText: SAID,
    chatId: "chat-1",
    identityKey: "id-1",
    userId: "user-1",
    toolExecMode: "interactive",
    executionJournal: bundle.executionJournal,
    selfVerification: bundle.selfVerification,
    stradaConformance: bundle.stradaConformance,
    executionStrategy: {},
    systemPrompt: "sys",
    lastAssignment: { providerName: "p", modelId: "m" },
    lastToolNames: [],
    emitProgress: vi.fn(),
  } as unknown as EngineRunContext;
  const requirePlanReview = vi.fn();
  const runProactiveGoalDecomposition = vi.fn(async (o: { agentState: unknown }) => o.agentState);
  const deps = {
    sessionManager: sm,
    buildInterventionDeps: vi.fn(),
    getClarificationContext: () => ({ toolMetadataByName: new Map() }),
    runReactiveGoalDecomposition: vi.fn(async () => {}),
    runProactiveGoalDecomposition,
    taskManager: () => null,
    dmPolicy: { isAutonomousActive: () => false },
    interactionPolicy: { requirePlanReview },
    recordPhaseOutcome: vi.fn(),
    buildStructuredProgressSignal: vi.fn(),
  } as unknown as ReflectionDeps;
  return { sm, session, runCtx, deps, requirePlanReview, runProactiveGoalDecomposition };
}

async function replan(h: ReturnType<typeof harness>, mode: "interactive" | "background" = "interactive") {
  const reflecting = transitionPhase(transitionPhase(createInitialState(SAID), AgentPhase.EXECUTING), AgentPhase.REFLECTING);
  const out = await portDispatchReflection(
    h.deps,
    { mode, agentState: reflecting, decision: "REPLAN", responseText: "The CSV option needs a new approach.", chatId: "chat-1" } as never,
    h.runCtx,
  );
  expect(out.agentState.phase).toBe(AgentPhase.REPLANNING);
  return out.agentState;
}

describe("after an interactive REPLAN the session's last user message is the person's", () => {
  it("the replan prompt is the last user-role turn, and the read passes over it", async () => {
    const h = harness();
    await replan(h);

    // What the model reads next: the replan prompt, as a user turn.
    expect(h.session.messages.at(-1)).toMatchObject({ role: "user", content: REPLAN_PROMPT });
    expect(h.sm.extractLastUserMessage(h.session)).toBe(SAID);
    expect(h.sm.extractLastUserContent(h.session)).toBe(SAID);
  });

  it("a background REPLAN pushes the same prompt, and the read passes over it too", async () => {
    const h = harness();
    await replan(h, "background");

    expect(h.session.messages.at(-1)).toMatchObject({ role: "user", content: REPLAN_PROMPT });
    expect(h.sm.extractLastUserMessage(h.session)).toBe(SAID);
  });

  it("'show me the plan first' re-presents the replanned plan for review, as v1 did", async () => {
    const h = harness();
    const replanning = await replan(h);

    const out = await portHandlePlanPhase(
      h.deps,
      { mode: "interactive", agentState: replanning, responseText: PLAN_DRAFT, chatId: "chat-1", toolCallCount: 0, providerName: "p", modelId: "m" } as never,
      h.runCtx,
    );

    expect(out.yield?.kind).toBe("plan_review");
    expect(h.requirePlanReview).toHaveBeenCalledTimes(1);
    expect(String(h.requirePlanReview.mock.calls[0]![2])).not.toContain(REPLAN_PROMPT);
  });

  it("proactive decomposition in REPLANNING decomposes the person's request (port.ts decomposeGoalsIfPlanning)", async () => {
    const h = harness();
    const replanning = await replan(h);
    const engine = {
      setupAgentCoreRun: vi.fn(async () => ({ runCtx: h.runCtx, setup: {} })),
      buildPolicySeed: () => ({}),
    } as unknown as AgentEngine;
    const portDeps = {
      sessionManager: h.sm,
      runProactiveGoalDecomposition: h.runProactiveGoalDecomposition,
      getTaskExecutionContext: () => undefined,
      monitorLifecycle: () => undefined,
      createGateway: () => ({}),
    } as unknown as PortDeps;
    const { port } = createAgentCorePort(engine, portDeps);
    await port.setupRun({ chatId: "chat-1" } as never);

    await port.decomposeGoalsIfPlanning({ agentState: replanning, responseText: PLAN_DRAFT, chatId: "chat-1" } as never);

    expect(h.runProactiveGoalDecomposition).toHaveBeenCalledTimes(1);
    expect(h.runProactiveGoalDecomposition.mock.calls[0]![0]).toMatchObject({ userMessage: SAID });
  });
});
