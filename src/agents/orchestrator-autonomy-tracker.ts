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
  readonly conformanceEnabled?: boolean;
  readonly conformanceFrameworkPathsOnly?: boolean;
  readonly loopFingerprintThreshold?: number;
  readonly loopFingerprintWindow?: number;
  readonly loopDensityThreshold?: number;
  readonly loopDensityWindow?: number;
  readonly loopMaxRecoveryEpisodes?: number;
  readonly loopStaleAnalysisThreshold?: number;
  readonly loopHardCapReplan?: number;
  readonly loopHardCapBlock?: number;
  readonly progressAssessmentEnabled?: boolean;
}

export function createAutonomyBundle(params: CreateAutonomyBundleParams): AutonomyBundle {
  const errorRecovery = new ErrorRecoveryEngine();
  const taskPlanner = new TaskPlanner({ iterationBudget: params.iterationBudget });
  const selfVerification = new SelfVerification();
  const executionJournal = new ExecutionJournal(params.prompt);
  if (params.previousJournalSnapshot) {
    executionJournal.seedFromSnapshot(params.previousJournalSnapshot);
  }
  const controlLoopTracker = params.includeControlLoopTracker
    ? new ControlLoopTracker({
        sameFingerprintThreshold: params.loopFingerprintThreshold,
        sameFingerprintWindow: params.loopFingerprintWindow,
        gateDensityThreshold: params.loopDensityThreshold,
        gateDensityWindow: params.loopDensityWindow,
        maxRecoveryEpisodes: params.loopMaxRecoveryEpisodes,
        staleAnalysisThreshold: params.loopStaleAnalysisThreshold,
        hardCapReplan: params.loopHardCapReplan,
        hardCapBlock: params.loopHardCapBlock,
      })
    : null;

  if (params.projectWorldSummary && params.projectWorldFingerprint) {
    executionJournal.attachProjectWorldContext({
      summary: params.projectWorldSummary,
      fingerprint: params.projectWorldFingerprint,
    });
  }

  const stradaConformance = new StradaConformanceGuard(params.stradaDeps, {
    enabled: params.conformanceEnabled,
    frameworkPathsOnly: params.conformanceFrameworkPathsOnly,
  });
  stradaConformance.trackPrompt(params.prompt);

  return { errorRecovery, taskPlanner, selfVerification, executionJournal, controlLoopTracker, stradaConformance };
}
