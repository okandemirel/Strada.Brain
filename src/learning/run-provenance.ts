import { AsyncLocalStorage } from "node:async_hooks";

/**
 * WHICH RUN IS LEARNING, so that what it learns can be told from what an
 * earlier run learned.
 *
 * Measured 2026-10-14 on a live proof run: 10 instincts were learned and every
 * one of them recorded no origin at all — `origin_session_id` was null and no
 * tag named the campaign. The column had existed for months; nothing wrote it.
 * Without it "a lesson from sprint N changed sprint N+1" cannot be answered,
 * because the instinct a later sprint was shown cannot be traced to the sprint
 * that wrote it down.
 *
 * Ambient rather than threaded, for the same reason as the run's design
 * document (`run-design-doc.ts`): a task's supervisor nodes, delegates and
 * decomposed goals all reach the learning pipeline, and none of them is handed
 * the task.
 */
export interface RunProvenance {
  /** The task whose run is learning: the id an exposure records as its own. */
  readonly runId?: string;
  /** The campaign the run serves, when it serves one. */
  readonly campaignId?: string;
}

const current = new AsyncLocalStorage<RunProvenance | null>();

/**
 * Runs `fn` with `provenance` as the identity of every run it starts.
 *
 * `null` says the work belongs to no run of its own, so it does not inherit
 * the identity of whatever task happened to start it.
 */
export function withRunProvenance<T>(provenance: RunProvenance | null, fn: () => T): T {
  return current.run(provenance, fn);
}

/** The running task's identity, or null outside one. */
export function runProvenance(): RunProvenance | null {
  return current.getStore() ?? null;
}

/** How a campaign is written in an instinct's tags. */
export const CAMPAIGN_TAG_PREFIX = "campaign:";

/**
 * The tags an instinct learned under `provenance` carries, added to whatever
 * the caller asked for and never repeated. Only the campaign is a tag: the run
 * id is the origin field, and duplicating it as a tag would invite two answers
 * to one question.
 */
export function provenanceTags(
  existing: readonly string[],
  provenance: RunProvenance | null = runProvenance(),
): string[] {
  const campaignId = provenance?.campaignId;
  if (campaignId === undefined || campaignId === "") return [...existing];
  const tag = `${CAMPAIGN_TAG_PREFIX}${campaignId}`;
  return existing.includes(tag) ? [...existing] : [...existing, tag];
}
