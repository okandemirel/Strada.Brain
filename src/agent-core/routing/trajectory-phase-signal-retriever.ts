import type { LearningStorage } from "../../learning/storage/learning-storage.js";
import type { Trajectory, TrajectoryPhaseReplay } from "../../learning/types.js";
import {
  buildTrajectoryReplayMatch,
  normalizeTrajectoryReplayText,
} from "../../learning/trajectory-replay-match.js";
import { scorePhaseVerdictFallback } from "./phase-verdict.js";
import type { ExecutionPhase } from "./routing-types.js";

export interface TrajectoryPhaseSignal {
  readonly provider: string;
  readonly phase: ExecutionPhase;
  readonly sampleSize: number;
  readonly sameWorldMatches: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly verdictSampleSize: number;
  readonly verdictScore: number;
  readonly latestTimestamp: number;
  readonly score: number;
}

interface ReplayPhaseCandidate {
  readonly phaseTelemetry: TrajectoryPhaseReplay;
  readonly trajectory: Trajectory;
  readonly weight: number;
  readonly sameWorld: boolean;
  readonly verdictScore?: number;
}

const NEUTRAL_SCORE = 0.5;
const PRIOR_WEIGHT = 2;
const VERDICT_BLEND_WEIGHT = 0.3;

export class TrajectoryPhaseSignalRetriever {
  private readonly maxTrajectories: number;

  constructor(
    private readonly storage: LearningStorage,
    options?: { maxTrajectories?: number },
  ) {
    this.maxTrajectories = options?.maxTrajectories ?? 160;
  }

  getSignalsForTask(params: {
    taskDescription: string;
    phase: ExecutionPhase;
    projectWorldFingerprint?: string;
  }): TrajectoryPhaseSignal[] {
    const normalizedTask = normalizeTrajectoryReplayText(params.taskDescription);
    if (!normalizedTask) {
      return [];
    }

    const trajectories = this.storage.getTrajectories({ limit: this.maxTrajectories });
    const verdictScores = phaseUsesTrajectoryVerdict(params.phase)
      ? this.storage.getLatestTrajectoryVerdictScores(
        trajectories.map((trajectory) => trajectory.id),
      )
      : new Map<string, { score: number; createdAt: number }>();
    const candidates = trajectories
      .flatMap((trajectory) => this.collectCandidates(
        trajectory,
        normalizedTask,
        params.phase,
        params.projectWorldFingerprint,
        verdictScores.get(trajectory.id)?.score,
      ))
      .sort((left, right) => right.weight - left.weight);

    if (candidates.length === 0) {
      return [];
    }

    const grouped = new Map<string, {
      provider: string;
      sampleSize: number;
      weightedTotal: number;
      weightTotal: number;
      sameWorldMatches: number;
      successCount: number;
      failureCount: number;
      verdictSampleSize: number;
      verdictWeightedTotal: number;
      verdictWeightTotal: number;
      latestTimestamp: number;
    }>();

    for (const candidate of candidates) {
      const provider = candidate.phaseTelemetry.provider.trim().toLowerCase();
      if (!provider) {
        continue;
      }

      const current = grouped.get(provider) ?? {
        provider,
        sampleSize: 0,
        weightedTotal: 0,
        weightTotal: 0,
        sameWorldMatches: 0,
        successCount: 0,
        failureCount: 0,
        verdictSampleSize: 0,
        verdictWeightedTotal: 0,
        verdictWeightTotal: 0,
        latestTimestamp: 0,
      };
      const contribution = scoreCandidate(candidate);
      current.sampleSize += 1;
      current.weightedTotal += contribution * candidate.weight;
      current.weightTotal += candidate.weight;
      if (candidate.sameWorld) {
        current.sameWorldMatches += 1;
      }
      if (isSuccessfulReplayPhase(candidate.phaseTelemetry)) {
        current.successCount += 1;
      } else if (isFailedReplayPhase(candidate.phaseTelemetry)) {
        current.failureCount += 1;
      }
      if (candidate.verdictScore !== undefined) {
        current.verdictSampleSize += 1;
        current.verdictWeightedTotal += clamp(candidate.verdictScore) * candidate.weight;
        current.verdictWeightTotal += candidate.weight;
      }
      current.latestTimestamp = Math.max(current.latestTimestamp, candidate.phaseTelemetry.timestamp, candidate.trajectory.createdAt);
      grouped.set(provider, current);
    }

    return [...grouped.values()]
      .map((entry): TrajectoryPhaseSignal => ({
        provider: entry.provider,
        phase: params.phase,
        sampleSize: entry.sampleSize,
        sameWorldMatches: entry.sameWorldMatches,
        successCount: entry.successCount,
        failureCount: entry.failureCount,
        verdictSampleSize: entry.verdictSampleSize,
        verdictScore: entry.verdictWeightTotal > 0
          ? clamp(entry.verdictWeightedTotal / entry.verdictWeightTotal)
          : NEUTRAL_SCORE,
        latestTimestamp: entry.latestTimestamp,
        score: clamp(
          (
            (entry.weightTotal > 0 ? entry.weightedTotal / entry.weightTotal : NEUTRAL_SCORE) +
            PRIOR_WEIGHT * NEUTRAL_SCORE
          ) / (PRIOR_WEIGHT + 1),
        ),
      }))
      .sort((left, right) => right.score - left.score || right.sameWorldMatches - left.sameWorldMatches || right.latestTimestamp - left.latestTimestamp);
  }

  getSignalForProvider(params: {
    provider: string;
    taskDescription: string;
    phase: ExecutionPhase;
    projectWorldFingerprint?: string;
  }): TrajectoryPhaseSignal | null {
    const normalizedProvider = params.provider.trim().toLowerCase();
    if (!normalizedProvider) {
      return null;
    }
    return this.getSignalsForTask(params).find((entry) => entry.provider === normalizedProvider) ?? null;
  }

  private collectCandidates(
    trajectory: Trajectory,
    normalizedTask: string,
    phase: ExecutionPhase,
    projectWorldFingerprint?: string,
    verdictScore?: number,
  ): ReplayPhaseCandidate[] {
    const replayContext = trajectory.outcome.replayContext;
    if (!replayContext?.phaseTelemetry?.length) {
      return [];
    }

    const match = buildTrajectoryReplayMatch(
      trajectory,
      normalizedTask,
      projectWorldFingerprint,
      { recencyWindowDays: 45 },
    );
    if (!match) {
      return [];
    }

    const weight =
      match.taskSimilarity * 0.55 +
      (match.sameWorld ? 0.25 : 0) +
      match.recencyScore * 0.15 +
      match.verifierBoost;

    return replayContext.phaseTelemetry
      .filter((entry) => entry.phase === phase)
      .map((phaseTelemetry) => ({
        phaseTelemetry,
        trajectory,
        weight,
        sameWorld: match.sameWorld,
        verdictScore,
      }));
  }
}

function scoreCandidate(candidate: ReplayPhaseCandidate): number {
  const statusScore = candidate.phaseTelemetry.phaseVerdictScore ?? scoreReplayStatus(candidate.phaseTelemetry);
  const verdictAdjustedScore = candidate.verdictScore === undefined
    ? statusScore
    : statusScore * (1 - VERDICT_BLEND_WEIGHT) + clamp(candidate.verdictScore) * VERDICT_BLEND_WEIGHT;
  const sameWorldBonus = candidate.sameWorld ? 0.05 : 0;
  return clamp(verdictAdjustedScore + sameWorldBonus);
}

function scoreReplayStatus(phaseTelemetry: TrajectoryPhaseReplay): number {
  return scorePhaseVerdictFallback(phaseTelemetry.status, phaseTelemetry.verifierDecision);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isSuccessfulReplayPhase(phaseTelemetry: TrajectoryPhaseReplay): boolean {
  if (phaseTelemetry.phaseVerdict === "clean" || phaseTelemetry.phaseVerdict === "retry") {
    return true;
  }
  return phaseTelemetry.status === "approved" || phaseTelemetry.status === "continued";
}

function isFailedReplayPhase(phaseTelemetry: TrajectoryPhaseReplay): boolean {
  if (phaseTelemetry.phaseVerdict === "failure") {
    return true;
  }
  return phaseTelemetry.status === "replanned"
    || phaseTelemetry.status === "blocked"
    || phaseTelemetry.status === "failed";
}

function phaseUsesTrajectoryVerdict(phase: ExecutionPhase): boolean {
  return phase === "synthesis"
    || phase === "completion-review"
    || phase === "visibility-review"
    || phase === "consensus-review"
    || phase === "shell-review";
}
