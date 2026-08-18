import { getLogger } from "../utils/logger.js";
import { hasDotnetProjectFile } from "./dotnet-project-presence.js";
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
  /** Absolute project root — lets the conformance guard inspect a written
   *  module directory. Omitted, that check stays quiet. */
  readonly projectPath?: string;
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

/**
 * A diagnostic line that cannot be the reason something fails.
 *
 * getLogger() throws when no logger has been created, which is correct for code
 * that needs one and wrong for an observability line.
 */
function debugLog(message: string, meta: Record<string, unknown>): void {
  try {
    getLogger().debug(message, meta);
  } catch {
    // No logger in this context; the diagnostic is not worth an exception.
  }
}

export function createAutonomyBundle(params: CreateAutonomyBundleParams): AutonomyBundle {
  const errorRecovery = new ErrorRecoveryEngine();
  // dotnet_build only when there is something for it to build. In a Unity
  // project without a solution it is filtered out of the offered tools, so
  // naming it in the verify checkpoint asks for a tool the run does not have.
  const taskPlanner = new TaskPlanner({
    iterationBudget: params.iterationBudget,
    buildToolName:
      params.projectPath && hasDotnetProjectFile(params.projectPath)
        ? "dotnet_build"
        : undefined,
  });
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
    // Needed to inspect a written module directory on disk; without it the
    // incomplete-module check cannot run and simply stays quiet.
    projectPath: params.projectPath,
  });
  stradaConformance.trackPrompt(params.prompt);
  // One line per guard, so a run that produced no gate can be told apart from a
  // run whose guards never saw the writes: goal decomposition gives each worker
  // its own bundle, and the context that decides completion is not always the
  // context that did the work.
  debugLog("Conformance guard created", {
    projectPath: params.projectPath ?? "(none)",
    enabled: params.conformanceEnabled !== false,
  });

  return { errorRecovery, taskPlanner, selfVerification, executionJournal, controlLoopTracker, stradaConformance };
}
