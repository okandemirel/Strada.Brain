import {
  ErrorRecoveryEngine,
  ExecutionJournal,
  TaskPlanner,
  SelfVerification,
  ControlLoopTracker,
} from "./autonomy/index.js";
import { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";

export interface AutonomyBundle {
  readonly errorRecovery: ErrorRecoveryEngine;
  readonly taskPlanner: TaskPlanner;
  readonly selfVerification: SelfVerification;
  readonly executionJournal: ExecutionJournal;
  readonly controlLoopTracker: ControlLoopTracker | null;
  readonly stradaConformance: StradaConformanceGuard;
}

export interface CreateAutonomyBundleParams {
  readonly prompt: string;
  readonly iterationBudget: number;
  readonly stradaDeps?: StradaDepsStatus;
  readonly projectWorldSummary?: string;
  readonly projectWorldFingerprint?: string;
  readonly includeControlLoopTracker?: boolean;
  readonly previousJournalSnapshot?: import("./autonomy/execution-journal.js").ExecutionJournalSnapshot;
}

export function createAutonomyBundle(params: CreateAutonomyBundleParams): AutonomyBundle {
  const errorRecovery = new ErrorRecoveryEngine();
  const taskPlanner = new TaskPlanner({ iterationBudget: params.iterationBudget });
  const selfVerification = new SelfVerification();
  const executionJournal = new ExecutionJournal(params.prompt);
  if (params.previousJournalSnapshot) {
    executionJournal.seedFromSnapshot(params.previousJournalSnapshot);
  }
  const controlLoopTracker = params.includeControlLoopTracker ? new ControlLoopTracker() : null;

  if (params.projectWorldSummary && params.projectWorldFingerprint) {
    executionJournal.attachProjectWorldContext({
      summary: params.projectWorldSummary,
      fingerprint: params.projectWorldFingerprint,
    });
  }

  const stradaConformance = new StradaConformanceGuard(params.stradaDeps);
  stradaConformance.trackPrompt(params.prompt);

  return { errorRecovery, taskPlanner, selfVerification, executionJournal, controlLoopTracker, stradaConformance };
}
