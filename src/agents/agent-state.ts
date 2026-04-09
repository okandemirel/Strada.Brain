export enum AgentPhase {
  PLANNING = "planning",
  EXECUTING = "executing",
  REFLECTING = "reflecting",
  REPLANNING = "replanning",
  COMPLETE = "complete",
  FAILED = "failed",
}

export interface StepResult {
  readonly toolName: string;
  readonly success: boolean;
  readonly summary: string;
  readonly timestamp: number;
  readonly errorCategory?: import("./orchestrator-runtime-utils.js").StepErrorCategory;
}

export interface AgentState {
  readonly phase: AgentPhase;
  readonly taskDescription: string;
  readonly iteration: number;
  readonly plan: string | null;
  readonly stepResults: readonly StepResult[];
  readonly failedApproaches: readonly string[];
  readonly reflectionCount: number;
  readonly lastReflection: string | null;
  readonly consecutiveErrors: number;
  readonly learnedInsights: readonly string[];
  /** Number of times PAOR reflection override has forced CONTINUE over DONE. */
  readonly reflectionOverrideCount: number;
}

const VALID_TRANSITIONS: ReadonlyMap<AgentPhase, ReadonlySet<AgentPhase>> =
  new Map([
    [AgentPhase.PLANNING, new Set([AgentPhase.EXECUTING, AgentPhase.FAILED])],
    [
      AgentPhase.EXECUTING,
      new Set([AgentPhase.REFLECTING, AgentPhase.COMPLETE, AgentPhase.FAILED]),
    ],
    [
      AgentPhase.REFLECTING,
      new Set([
        AgentPhase.EXECUTING,
        AgentPhase.REPLANNING,
        AgentPhase.COMPLETE,
        AgentPhase.FAILED,
      ]),
    ],
    [
      AgentPhase.REPLANNING,
      new Set([AgentPhase.EXECUTING, AgentPhase.FAILED]),
    ],
    [AgentPhase.COMPLETE, new Set<AgentPhase>()],
    [AgentPhase.FAILED, new Set<AgentPhase>()],
  ]);

export function createInitialState(taskDescription: string): AgentState {
  return {
    phase: AgentPhase.PLANNING,
    taskDescription,
    iteration: 0,
    plan: null,
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
    reflectionOverrideCount: 0,
  };
}

export function canTransition(from: AgentPhase, to: AgentPhase): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed?.has(to) ?? false;
}

export function transitionPhase(state: AgentState, to: AgentPhase): AgentState {
  if (!canTransition(state.phase, to)) {
    throw new Error(
      `Invalid phase transition: ${state.phase} -> ${to}`,
    );
  }
  return { ...state, phase: to };
}
