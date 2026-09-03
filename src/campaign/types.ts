/**
 * Campaign — the "GDD/idea in, finished game out" layer.
 *
 * A campaign is the persistent, restart-surviving envelope around a whole
 * game build. The goal system decomposes ONE task into a tree; a campaign is
 * the ladder of such tasks (milestones/sprints) walked in order, plus the two
 * moments a whole-game run needs that a single task never had:
 *
 *   1. Idea mode: no GDD yet — the first task WRITES the GDD, then the run
 *      stops at exactly one human gate (the approved design) before building.
 *   2. Sprint-to-sprint drive: when a milestone task lands, the next one is
 *      submitted automatically. Measured 2026-08-26 (PixelFlow): Sprint B→C
 *      advanced only because a person hand-carried a 562-char kick prompt
 *      into the CLI hours later. The campaign is that kick, in code.
 *
 * The campaign does NOT re-implement planning/execution/verification — each
 * milestone is submitted to the ordinary task pipeline (goal DAG, supervisor,
 * verifier gates) exactly as a hand-typed sprint prompt would be.
 */

import { z } from "zod";

// =============================================================================
// STATE
// =============================================================================

/**
 * drafting-gdd:      a task is in flight writing docs/<Game>_GDD.md (idea mode only)
 * awaiting-approval: the single human gate — GDD drafted, waiting for the chat's yes
 * planning:          building the milestone ladder from the GDD (LLM pass)
 * executing:         a milestone task is in flight
 * done / failed / cancelled: terminal
 */
export type CampaignState =
  | "drafting-gdd"
  | "awaiting-approval"
  | "planning"
  | "executing"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_CAMPAIGN_STATES: readonly CampaignState[] = [
  "drafting-gdd",
  "awaiting-approval",
  "planning",
  "executing",
];

export type MilestoneStatus = "pending" | "running" | "green" | "failed";

export interface CampaignMilestone {
  /** Stable id inside the campaign ("m1", "m2", ...). */
  id: string;
  /** Human label, e.g. "Sprint A — Foundations & Core Sim". */
  title: string;
  /**
   * The full self-contained sprint kick prompt submitted to the task pipeline
   * when this milestone starts — the same shape as the hand-carried sprint
   * prompts that drove PixelFlow (scope, verification demands, commit
   * discipline, delivery expectations).
   */
  prompt: string;
  status: MilestoneStatus;
  /** Last task submitted for this milestone (for event correlation/resume). */
  taskId?: string;
  /** One retry is automatic; the second failure fails the campaign. */
  attempts: number;
  /** Short result excerpt recorded when the milestone landed green. */
  resultExcerpt?: string;
  /** Commit hash + file count from the envelope commit that closed it. */
  commitNote?: string;
  /** The mechanical test verdict observed when it landed green, if any. */
  testVerdict?: string;
  /**
   * Whether that verdict came from the WHOLE suite rather than a filtered
   * run. A filtered green is not the suite passing: the delivered PixelFlow
   * build's filtered runs were green while its one unfiltered run reported
   * 6 of 173 failing (audited 2026-09-03).
   */
  testVerdictUnfiltered?: boolean;
  /** Tests the last observed run reported FAILING (bounded; see the verdict). */
  testFailures?: readonly string[];
  /** How many further failing names the run printed beyond those listed. */
  testFailuresOmitted?: number;
  /** One-shot flag: a reaped settlement already deferred once to the
   *  executor's pending keep-alive retry (see reconcileMilestoneAfterSettle). */
  reconcileDeferred?: boolean;
  /**
   * When the campaign first deferred to the executor's pending keep-alive
   * retry for the current settle cycle (epoch ms). Time-bounded deferral —
   * cleared when an outcome is finally judged. Replaces the one-shot
   * `reconcileDeferred` consumption (kept for row compat).
   */
  reconcileDeferredSince?: number;
  /** One-shot flag: completion was bounced once for missing capture frames
   *  (the visual-evidence gate); the second completion stands either way. */
  visualEvidenceBounced?: boolean;
  /**
   * What the capture scan found when the milestone went green, and whether
   * the gate could act on it — the gate only bounces when the sprint prompt
   * demanded a capture. Audited 2026-09-02: a gate that never ran rendered
   * identically to one that passed.
   *   observed                 — a fresh, meaningful captured frame existed
   *   none-gate-not-demanded   — no frame, and the prompt never demanded one (gate did not run)
   *   none-gate-spent          — no frame even after the one visual bounce
   */
  visualEvidence?: "observed" | "none-gate-not-demanded" | "none-gate-spent";
  /**
   * One-shot no-work bounce: a completion with a clean tree and no commits
   * since the sprint began is rejected once; the second stands either way.
   */
  noWorkBounced?: boolean;
  /** One-shot bounce: the FINAL milestone landed green with no observed test run. */
  deliveryVerificationBounced?: boolean;
  /**
   * How many times the delivery-verification gate has bounced this milestone.
   * One bounce was not enough: the second attempt also ran no tests and the
   * ladder delivered a suite that was never seen to pass (measured live
   * 2026-09-03 08:33). Bounded by the milestone's attempt budget.
   */
  deliveryVerificationBounces?: number;
  /** When this milestone's current run began (epoch ms) — the time-box clock. */
  startedAtMs?: number;
  /** How many times the time-box has forced a scope-narrowing escalation. */
  timeBoxEscalations?: number;
}

export interface Campaign {
  id: string;
  /** Origin conversation — approval gate and reports are delivered here. */
  chatId: string;
  channelType: string;
  userId: string;
  conversationId?: string;
  projectRoot: string;
  state: CampaignState;
  /** Raw idea text (idea mode). */
  ideaText?: string;
  /** Project-relative path to the GDD once known (drafted or supplied). */
  gddPath?: string;
  /** Supplied GDD content (attachment/paste mode), truncated for planning. */
  gddText?: string;
  /** Task id of the in-flight GDD draft (drafting-gdd state). */
  draftTaskId?: string;
  /** Number of GDD draft rounds (feedback loops at the approval gate). */
  draftAttempts: number;
  /**
   * When the draft path first deferred to the executor's pending keep-alive
   * retry for the current settle cycle (epoch ms) — the draft counterpart of
   * `CampaignMilestone.reconcileDeferredSince`. Time-bounded deferral;
   * cleared when an outcome is finally judged or a new draft is issued.
   */
  draftDeferredSince?: number;
  milestones: CampaignMilestone[];
  /** Index into milestones of the current/next work item. */
  currentMilestone: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  /**
   * When set on a `failed` campaign: the self-revival appointment (epoch ms).
   * Armed when the stop was a full provider outage; cleared on any revive.
   */
  autoReviveAt?: number;
  /**
   * True only once the delivery report has actually been handed to the
   * messenger without error. A `done` campaign whose flag is unset lost its
   * report to a crash or a messenger failure and is re-reported at boot —
   * done campaigns are not active, not revivable and not queryable, so
   * nothing else would ever notice (audited 2026-09-02).
   */
  deliveryReported?: boolean;
  /**
   * Set when the GDD-coverage audit did NOT run clean (skipped, budget spent,
   * or errored). Rendered in the delivery report so an unaudited delivery
   * cannot read like an audited one.
   */
  coverageAuditNote?: string;
}

// =============================================================================
// PLANNER OUTPUT (external data — Zod-validated)
// =============================================================================

export const milestonePlanSchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(40).max(8000),
});

export const milestoneLadderSchema = z.object({
  milestones: z.array(milestonePlanSchema).min(2).max(12),
});

export type MilestoneLadder = z.infer<typeof milestoneLadderSchema>;

// =============================================================================
// FACTORY
// =============================================================================

let campaignCounter = 0;

export function generateCampaignId(): string {
  campaignCounter += 1;
  return `campaign_${Date.now()}_${campaignCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
