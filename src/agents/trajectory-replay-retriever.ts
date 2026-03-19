import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { Trajectory } from "../learning/types.js";

export interface TrajectoryReplayInsightResult {
  readonly insights: string[];
  readonly matchedTrajectoryIds: string[];
}

interface ReplayCandidate {
  readonly trajectory: Trajectory;
  readonly score: number;
  readonly sameWorld: boolean;
}

export class TrajectoryReplayRetriever {
  private readonly maxTrajectories: number;

  constructor(
    private readonly storage: LearningStorage,
    options?: { maxTrajectories?: number },
  ) {
    this.maxTrajectories = options?.maxTrajectories ?? 120;
  }

  getInsightsForTask(params: {
    taskDescription: string;
    projectWorldFingerprint?: string;
    maxInsights?: number;
  }): TrajectoryReplayInsightResult {
    const normalizedTask = normalizeText(params.taskDescription);
    if (!normalizedTask) {
      return { insights: [], matchedTrajectoryIds: [] };
    }

    const trajectories = this.storage.getTrajectories({ limit: this.maxTrajectories });
    const candidates = trajectories
      .map((trajectory) => this.scoreTrajectory(trajectory, normalizedTask, params.projectWorldFingerprint))
      .filter((candidate): candidate is ReplayCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score);

    if (candidates.length === 0) {
      return { insights: [], matchedTrajectoryIds: [] };
    }

    const maxInsights = params.maxInsights ?? 2;
    const insights: string[] = [];
    const matchedTrajectoryIds: string[] = [];

    const bestSuccess = candidates.find((candidate) => candidate.trajectory.outcome.success);
    if (bestSuccess) {
      insights.push(formatSuccessInsight(bestSuccess));
      matchedTrajectoryIds.push(bestSuccess.trajectory.id);
    }

    const bestFailure = candidates.find((candidate) => !candidate.trajectory.outcome.success);
    if (bestFailure && insights.length < maxInsights) {
      insights.push(formatFailureInsight(bestFailure));
      matchedTrajectoryIds.push(bestFailure.trajectory.id);
    }

    for (const candidate of candidates) {
      if (insights.length >= maxInsights) {
        break;
      }
      if (matchedTrajectoryIds.includes(candidate.trajectory.id)) {
        continue;
      }
      insights.push(formatSuccessInsight(candidate));
      matchedTrajectoryIds.push(candidate.trajectory.id);
    }

    return { insights, matchedTrajectoryIds };
  }

  private scoreTrajectory(
    trajectory: Trajectory,
    normalizedTask: string,
    currentWorldFingerprint?: string,
  ): ReplayCandidate | null {
    const normalizedTrajectoryTask = normalizeText(trajectory.taskDescription);
    const taskSimilarity = tokenSimilarity(normalizedTask, normalizedTrajectoryTask);
    const trajectoryWorld = trajectory.outcome.replayContext?.projectWorldFingerprint?.trim();
    const sameWorld = Boolean(
      currentWorldFingerprint
      && trajectoryWorld
      && currentWorldFingerprint.trim() === trajectoryWorld,
    );

    if (taskSimilarity < 0.18 && !sameWorld) {
      return null;
    }

    const ageDays = Math.max(0, (Date.now() - trajectory.createdAt) / 86_400_000);
    const recencyScore = Math.max(0, 1 - ageDays / 30);
    const outcomeScore = trajectory.outcome.success
      ? trajectory.outcome.hadErrors
        ? 0.2
        : 0.35
      : -0.1;
    const verifierBoost = trajectory.outcome.replayContext?.verifierSummary ? 0.05 : 0;
    const score =
      taskSimilarity * 0.55
      + (sameWorld ? 0.25 : 0)
      + recencyScore * 0.1
      + outcomeScore
      + verifierBoost;

    return { trajectory, score, sameWorld };
  }
}

function formatSuccessInsight(candidate: ReplayCandidate): string {
  const { trajectory, sameWorld } = candidate;
  const replayContext = trajectory.outcome.replayContext;
  const scopeLabel = sameWorld ? "same project/world context" : "similar past task";
  const branch = replayContext?.branchSummary
    ? summarizeText(replayContext.branchSummary, 120)
    : summarizeText(trajectory.taskDescription, 96);
  const verifier = replayContext?.verifierSummary
    ? summarizeText(replayContext.verifierSummary, 120)
    : trajectory.outcome.hadErrors
      ? `${trajectory.outcome.errorCount} errors were resolved before completion`
      : "clean verifier outcome";
  const insight = replayContext?.learnedInsights?.[0]
    ? ` Insight: ${summarizeText(replayContext.learnedInsights[0], 110)}.`
    : "";
  return `Replay success (${scopeLabel}): ${branch}. ${trajectory.outcome.totalSteps} steps, ${verifier}.${insight}`;
}

function formatFailureInsight(candidate: ReplayCandidate): string {
  const { trajectory, sameWorld } = candidate;
  const replayContext = trajectory.outcome.replayContext;
  const scopeLabel = sameWorld ? "same project/world context" : "similar past task";
  const branch = replayContext?.branchSummary
    ? summarizeText(replayContext.branchSummary, 120)
    : summarizeText(trajectory.taskDescription, 96);
  const verifier = replayContext?.verifierSummary
    ? summarizeText(replayContext.verifierSummary, 120)
    : `${trajectory.outcome.errorCount} errors before failure`;
  return `Replay warning (${scopeLabel}): avoid repeating ${branch}. Last verifier memory: ${verifier}.`;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const denominator = Math.max(leftTokens.size, rightTokens.size, 1);
  return intersection / denominator;
}

function summarizeText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
