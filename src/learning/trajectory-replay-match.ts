import type { Trajectory } from "./types.js";

export interface TrajectoryReplayMatch {
  readonly taskSimilarity: number;
  readonly sameWorld: boolean;
  readonly recencyScore: number;
  readonly verifierBoost: number;
}

export function normalizeTrajectoryReplayText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const denominator = Math.max(leftTokens.size, rightTokens.size, 1);
  return intersection / denominator;
}

export function buildTrajectoryReplayMatch(
  trajectory: Trajectory,
  normalizedTask: string,
  currentWorldFingerprint?: string,
  options?: {
    minimumTaskSimilarity?: number;
    recencyWindowDays?: number;
  },
): TrajectoryReplayMatch | null {
  const normalizedTrajectoryTask = normalizeTrajectoryReplayText(trajectory.taskDescription);
  const taskSimilarity = tokenSimilarity(normalizedTask, normalizedTrajectoryTask);
  const trajectoryWorld = trajectory.outcome.replayContext?.projectWorldFingerprint?.trim();
  const sameWorld = Boolean(
    currentWorldFingerprint
    && trajectoryWorld
    && currentWorldFingerprint.trim() === trajectoryWorld,
  );

  const minimumTaskSimilarity = options?.minimumTaskSimilarity ?? 0.18;
  if (taskSimilarity < minimumTaskSimilarity && !sameWorld) {
    return null;
  }

  const recencyWindowDays = options?.recencyWindowDays ?? 30;
  const ageDays = Math.max(0, (Date.now() - trajectory.createdAt) / 86_400_000);
  const recencyScore = Math.max(0, 1 - ageDays / recencyWindowDays);
  const verifierBoost = trajectory.outcome.replayContext?.verifierSummary ? 0.05 : 0;

  return {
    taskSimilarity,
    sameWorld,
    recencyScore,
    verifierBoost,
  };
}
