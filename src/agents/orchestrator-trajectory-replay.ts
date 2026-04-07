/**
 * Orchestrator Trajectory Replay — standalone function for building
 * trajectory replay context used during context construction.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 */

import type {
  TrajectoryPhaseReplay,
  TrajectoryReplayContext,
} from "../learning/index.js";
import type { TrajectoryReplayRetriever } from "./trajectory-replay-retriever.js";
import type { TaskExecutionStore } from "../memory/unified/task-execution-store.js";
// IdentityLinkResolver matches the interface expected by resolveIdentityKey
interface IdentityLinkResolver {
  resolveLinkedIdentity: (channelType: string, channelUserId: string) => string | null;
}
import type { IMemoryManager } from "../memory/memory.interface.js";
import type {
  ExecutionTrace,
  PhaseOutcome,
} from "../agent-core/routing/routing-types.js";
import { resolveIdentityKey } from "./orchestrator-text-utils.js";
import { isOk, isSome } from "../types/index.js";
import { buildProjectWorldMemorySection } from "./context/strada-knowledge.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrajectoryReplayDeps {
  readonly trajectoryReplayRetriever: TrajectoryReplayRetriever | null;
  readonly taskExecutionStore: TaskExecutionStore | undefined;
  readonly userProfileStore?: IdentityLinkResolver;
  readonly memoryManager?: IMemoryManager | null;
  readonly projectPath: string;
  readonly providerRouter: {
    getRecentExecutionTraces?: (limit: number, identityKey: string) => ExecutionTrace[];
    getRecentPhaseOutcomes?: (limit: number, identityKey: string) => PhaseOutcome[];
  } | undefined;
  resolveTaskRunId(chatId?: string, explicitTaskRunId?: string): string | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toTrajectoryPhaseReplay(event: ExecutionTrace | PhaseOutcome): TrajectoryPhaseReplay {
  return {
    phase: event.phase,
    role: event.role,
    provider: event.provider,
    model: event.model,
    source: event.source,
    status: "status" in event ? event.status : undefined,
    verifierDecision: "telemetry" in event ? event.telemetry?.verifierDecision : undefined,
    phaseVerdict: "telemetry" in event ? event.telemetry?.phaseVerdict : undefined,
    phaseVerdictScore: "telemetry" in event ? event.telemetry?.phaseVerdictScore : undefined,
    retryCount: "telemetry" in event ? event.telemetry?.retryCount : undefined,
    rollbackDepth: "telemetry" in event ? event.telemetry?.rollbackDepth : undefined,
    timestamp: event.timestamp,
  };
}

function mergeReplayOutcome(
  existing: TrajectoryPhaseReplay,
  outcome: PhaseOutcome,
): TrajectoryPhaseReplay {
  return {
    ...existing,
    status: outcome.status,
    verifierDecision: outcome.telemetry?.verifierDecision,
    phaseVerdict: outcome.telemetry?.phaseVerdict,
    phaseVerdictScore: outcome.telemetry?.phaseVerdictScore,
    retryCount: outcome.telemetry?.retryCount,
    rollbackDepth: outcome.telemetry?.rollbackDepth,
  };
}

async function buildProjectWorldMemoryLayer(
  memoryManager: IMemoryManager | null | undefined,
  projectPath: string,
): Promise<{
  content: string;
  contentHashes: string[];
  summary: string;
  fingerprint: string;
} | null> {
  if (!memoryManager) {
    return buildProjectWorldMemorySection({
      projectPath,
      analysis: null,
    });
  }

  try {
    const analysisResult = await memoryManager.getCachedAnalysis(projectPath);
    const analysis =
      isOk(analysisResult) && isSome(analysisResult.value) ? analysisResult.value.value : null;
    return buildProjectWorldMemorySection({
      projectPath,
      analysis,
    });
  } catch {
    return buildProjectWorldMemorySection({
      projectPath,
      analysis: null,
    });
  }
}

function buildTrajectoryPhaseReplayTelemetry(
  deps: TrajectoryReplayDeps,
  chatId: string,
  identityKey: string,
  sinceTimestamp?: number,
  taskRunId?: string,
): TrajectoryPhaseReplay[] {
  if (!deps.providerRouter) {
    return [];
  }

  const correlatedTaskRunId = deps.resolveTaskRunId(chatId, taskRunId);
  const traces = (deps.providerRouter.getRecentExecutionTraces?.(100, identityKey) ?? [])
    .filter((trace) => trace.chatId === chatId)
    .filter((trace) => (correlatedTaskRunId ? trace.taskRunId === correlatedTaskRunId : true))
    .filter(
      (trace) =>
        correlatedTaskRunId || sinceTimestamp === undefined || trace.timestamp >= sinceTimestamp,
    );
  const outcomes = (deps.providerRouter.getRecentPhaseOutcomes?.(100, identityKey) ?? [])
    .filter((outcome) => outcome.chatId === chatId)
    .filter((outcome) => (correlatedTaskRunId ? outcome.taskRunId === correlatedTaskRunId : true))
    .filter(
      (outcome) =>
        correlatedTaskRunId ||
        sinceTimestamp === undefined ||
        outcome.timestamp >= sinceTimestamp,
    );
  if (traces.length === 0 && outcomes.length === 0) {
    return [];
  }

  const keyed = new Map<string, TrajectoryPhaseReplay>();
  const makeKey = (event: ExecutionTrace | PhaseOutcome) =>
    [event.phase, event.role, event.provider, event.model ?? "", event.source].join(":");

  for (const trace of traces) {
    const key = makeKey(trace);
    const existing = keyed.get(key);
    if (existing && existing.timestamp > trace.timestamp) {
      continue;
    }
    keyed.set(key, toTrajectoryPhaseReplay(trace));
  }

  for (const outcome of outcomes) {
    const key = makeKey(outcome);
    const existing = keyed.get(key);
    if (!existing || outcome.timestamp >= existing.timestamp) {
      keyed.set(key, toTrajectoryPhaseReplay(outcome));
      continue;
    }
    keyed.set(key, mergeReplayOutcome(existing, outcome));
  }

  return [...keyed.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-12);
}

// ─── Main Function ────────────────────────────────────────────────────────────

export async function buildTrajectoryReplayContext(
  deps: TrajectoryReplayDeps,
  params: {
    chatId: string;
    userId?: string;
    conversationId?: string;
    channelType?: string;
    sinceTimestamp?: number;
    taskRunId?: string;
  },
): Promise<TrajectoryReplayContext | null> {
  const identityKey = resolveIdentityKey(
    params.chatId,
    params.userId,
    params.conversationId,
    deps.userProfileStore,
    params.channelType,
  );
  const taskExecutionMemory = deps.taskExecutionStore?.getMemory(identityKey) ?? null;
  const exactReplayMatch = params.taskRunId
    ? (deps.trajectoryReplayRetriever?.getReplayContextForTaskRun({
        taskRunId: params.taskRunId,
        chatId: params.chatId,
      }) ?? null)
    : null;
  const exactReplayContext = exactReplayMatch?.replayContext ?? null;
  const hasExactReplayMatch = exactReplayMatch?.found ?? false;
  const projectWorldLayer = await buildProjectWorldMemoryLayer(
    deps.memoryManager,
    deps.projectPath,
  );
  const phaseTelemetry = buildTrajectoryPhaseReplayTelemetry(
    deps,
    params.chatId,
    identityKey,
    params.sinceTimestamp,
    params.taskRunId,
  );

  const learnedInsightsSource = hasExactReplayMatch
    ? (exactReplayContext?.learnedInsights ?? [])
    : (exactReplayContext?.learnedInsights ?? taskExecutionMemory?.learnedInsights ?? []);
  const learnedInsights = learnedInsightsSource.slice(0, 4);
  const branchSummary = hasExactReplayMatch
    ? exactReplayContext?.branchSummary
    : (exactReplayContext?.branchSummary ?? taskExecutionMemory?.branchSummary);
  const verifierSummary = hasExactReplayMatch
    ? exactReplayContext?.verifierSummary
    : (exactReplayContext?.verifierSummary ?? taskExecutionMemory?.verifierSummary);
  if (
    !projectWorldLayer &&
    !exactReplayContext?.projectWorldFingerprint &&
    !branchSummary &&
    !verifierSummary &&
    learnedInsights.length === 0 &&
    phaseTelemetry.length === 0 &&
    !exactReplayContext?.phaseTelemetry?.length
  ) {
    return null;
  }

  return {
    projectWorldFingerprint:
      exactReplayContext?.projectWorldFingerprint ?? projectWorldLayer?.fingerprint,
    projectWorldSummary: exactReplayContext?.projectWorldSummary ?? projectWorldLayer?.summary,
    branchSummary,
    verifierSummary,
    learnedInsights,
    phaseTelemetry:
      phaseTelemetry.length > 0 ? phaseTelemetry : (exactReplayContext?.phaseTelemetry ?? []),
  };
}
