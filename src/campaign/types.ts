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
   * For a coverage-remediation sprint, the requirement it exists to close, in
   * full. The title truncates at 60 characters, and matching gaps by that
   * prefix merged different requirements and discarded them for good (Codex
   * 2026-09-11 J#13).
   */
  coverageGap?: string;
  /**
   * Which delivery gates failed on the last round, as flag names. The
   * delivery budget compares these rather than the sentences the gates
   * write, because prose carries measurements (Codex 2026-09-11 K#3-K#5).
   */
  deliveryFailureKinds?: string[];
  /**
   * The full self-contained sprint kick prompt submitted to the task pipeline
   * when this milestone starts — the same shape as the hand-carried sprint
   * prompts that drove PixelFlow (scope, verification demands, commit
   * discipline, delivery expectations).
   */
  prompt: string;
  status: MilestoneStatus;
  /** GDD section headings the planner assigned to this sprint (see milestonePlanSchema). */
  coveredSections?: string[];
  /** What the planner said this sprint leaves behind. */
  deliverables?: string[];
  /** Last task submitted for this milestone (for event correlation/resume). */
  taskId?: string;
  /**
   * EVERY task this milestone has owned, newest last. Retirement used to find
   * a campaign's abandoned lineages by matching the first 120 characters of a
   * task's prompt, so two unrelated missions sharing a chat and a generic
   * final-proof opening retired each other (Codex 2026-09-11 L#4). Ownership
   * is recorded, not inferred. Rides in milestones_json; no column needed.
   */
  taskIds?: string[];
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
  /** Where the verdict came from: the NUnit run record the tool wrote, or the tool's prose (2026-09-10). */
  testRunSource?: "nunit" | "prose";
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
   * The project's sprite art when a coverage-remediation sprint was first
   * submitted: how many sprite textures, and how many of them placeholder-grade
   * (see ArtInventory). Measured 2026-09-07: four remediation attempts, 0 art —
   * 410 of 429 sprites were flat procedural shapes before and after each one,
   * and nothing compared the two numbers.
   */
  placeholderArtAtStart?: { sprites: number; placeholders: number };
  /** One-shot flag: completion was bounced once because the placeholder count did not drop. */
  artBounced?: boolean;
  /**
   * Whether the PLANNER's own prompt demanded a captured frame — recorded when
   * the ladder is built, because the gate that reads it must not be armed by
   * text the system appends later.
   *
   * Audited 2026-09-04: the gate tested /captur/i against the live prompt, so
   * a directive this manager itself appends ("let a captured frame … be your
   * report") armed it on a sprint the planner never gated, and the final
   * sprint bounced for evidence nobody had asked it to produce. Undefined on
   * rows persisted before this field existed — those fall back to the scan.
   */
  visualGateArmed?: boolean;
  /** What the compiler said at the delivery gate; absent = never measured. */
  compileVerdict?: { ok: boolean; ran: boolean; errors?: number; detail?: string };
  /**
   * The player build the campaign itself ran from the project root at the
   * delivery gate (unity_build_player). A delivery is a runnable artifact;
   * `ran: false` is disclosed as NOT MEASURED, never treated as a pass.
   */
  buildVerdict?: PlayerBuildEvidence;
  /** The tool's own sentence when the Unity account link was dead during this sprint (see TaskTestVerdict). */
  assetSourcingBlind?: string;
  /** The channel was told once about it; later sprints do not repeat it. */
  assetSourcingBlindTold?: boolean;
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
  /** One-shot bounce: the sprint's commits were documentation only. */
  prosOnlyBounced?: boolean;
  /** One-shot bounce: the FINAL milestone landed green with no observed test run. */
  deliveryVerificationBounced?: boolean;
  /**
   * How many times the delivery-verification gate has bounced this milestone.
   * One bounce was not enough: the second attempt also ran no tests and the
   * ladder delivered a suite that was never seen to pass (measured live
   * 2026-09-03 08:33). Bounded by the milestone's attempt budget.
   */
  deliveryVerificationBounces?: number;
  /**
   * The final sprint's proofs still missing when its bounce budget ran out
   * (2026-09-10). Until then the campaign declared `done` with these as
   * caveats — "went green with NO observed test run" under "game build
   * complete". Now the campaign is NOT DELIVERED, names them here, and resumes
   * the final sprint by itself with a fresh budget.
   */
  deliveryProofsMissing?: string[];
  /**
   * How many times the scene-hygiene gate has bounced this milestone. The
   * delivered PixelFlow tree left 14 scenes enabled in Build Settings and the
   * user could not tell which one is the game (measured 2026-09-03). The gate
   * refuses ONLY the unopenable cases — no enabled scene at all, or no entry
   * scene that can be named — because deleting a user's scenes is not this
   * system's decision. Bounded by the milestone's attempt budget.
   */
  sceneHygieneBounces?: number;
  /**
   * Set when delivery was declared anyway, with the hygiene refusal still
   * standing (bounces exhausted). A waived gate must never read like a passed
   * one, so the delivery report carries this verbatim.
   */
  sceneHygieneUnresolved?: string;
  /**
   * What the delivery-only structural check measured on the SHIPPED scenes —
   * renderer counts, project vs built-in bindings, unbound art, geometry built
   * in code, and the GDD-vs-scene dimensionality disclosure. Rendered in the
   * delivery report so the reader sees the game that was actually built, not
   * the sprint titles that were ticked. Audited 2026-09-03.
   */
  structureFindings?: string[];
  /** True when the structural check refused delivery at least once. */
  structureRefused?: boolean;
  /** The rendered look-vs-GDD disclosure block for the delivery report. */
  visualConformance?: string;
  /** Bounces spent on the vision model saying the frame does not show the described game (max 1). */
  visualMismatchBounces?: number;
  /**
   * What unity_playthrough said about the game as delivered (read at the
   * delivery gate from Recordings/playthrough/playthrough-verdict.json; a
   * file older than the sprint is `stale`, not evidence). Absent = never read.
   */
  playthroughVerdict?: PlaythroughEvidence;
  /**
   * The play-through the campaign ran INSIDE the built player at the delivery
   * gate (unity_run_player, 2026-09-10): the same drive with real rendering,
   * the only frame rate that speaks for what a person sees. Absent = never run.
   */
  playerPlaythrough?: PlaythroughEvidence;
  /**
   * The GDD's own numbers (a frame-rate target, a load-time budget, a level
   * count, a session length) held against what was measured at delivery —
   * one line per claim: met, NOT met, or not measurable yet, never silent.
   */
  gddClaims?: string[];
  /** When this milestone's current run began (epoch ms) — the time-box clock. */
  startedAtMs?: number;
  /**
   * When the CURRENT attempt at this milestone was submitted (every submit,
   * bounces included). The proof readers measure freshness against this: a
   * verdict earned before a bounce describes the game before the sprint
   * changed it again (Codex 2026-09-11 B#4).
   */
  attemptStartedAtMs?: number;
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
  /** How the plan covers the GDD's measured section inventory (2026-09-10). */
  planCoverage?: { covered: number; total: number; uncovered: string[]; excluded: string[]; minMilestones: number; maxMilestones: number };
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
  /**
   * Consecutive self-revivals spent on proofs this machine cannot produce
   * (no Unity, no builder, an artifact it cannot execute). Past
   * MAX_UNMEASURABLE_REVIVES the campaign stops and asks a person instead of
   * retrying forever (Codex 2026-09-11 C#2).
   */
  unmeasurableRevives?: number;
  /**
   * Self-revivals spent on an ORDINARY implementation failure — a sprint that
   * ran out of attempts on a healthy chain. Without this the campaign ended
   * `failed` with no revival at all and waited for a person to type "kampanya
   * devam", which is not autonomy (Codex 2026-09-11 F#1).
   */
  implementationRevives?: number;
  /**
   * Coverage gaps the audit named and no round has scheduled yet. Persisted
   * because the round budget used to strip them: nine gaps, two rounds of
   * four, and the ninth was never scheduled — the next audit was skipped as
   * "round budget spent" and the campaign delivered `done` with a
   * requirement it had explicitly identified as missing (Codex 2026-09-11
   * F#9). A known gap is drained, never dropped.
   */
  pendingCoverageGaps?: string[];
  /**
   * Delivery rounds spent on the SAME missing proofs. The "resumes by itself
   * with a fresh budget" path had no durable counter at all: 100 completed
   * sprints produced 100 submissions and the campaign never stopped, once a
   * repeatable missing proof stopped counting as unmeasurable (Codex
   * 2026-09-11 H#1). Progress — a different set of missing proofs — starts the
   * budget again, so a campaign that is getting somewhere is never stopped by
   * it.
   */
  deliveryRevives?: number;
  /**
   * EVERY delivery round this campaign has run, whatever the proofs were.
   *
   * The per-signature counter above gives a newly-identified defect its own
   * patience, which is right — but two defects that alternate ("actions, no
   * frames", then "frames, no actions") each reset it, and twelve rounds ran
   * with the counter stuck at one (Codex 2026-09-11 O#5). This one never
   * resets, so the bouncing ends even when the identity keeps changing.
   */
  deliveryRoundsTotal?: number;
  /**
   * When a PERSON's stop was recorded, and which generation of this campaign
   * it belongs to.
   *
   * The stop used to be applied only when its queued handler ran, so a
   * completion ahead of it in the queue reached `done` first and the stop then
   * saw a finished campaign and returned — and a stop queued before a person
   * revived the campaign was replayed into the NEW generation, failing work
   * nobody had cancelled (Codex 2026-09-11 L#3). The stop is persisted the
   * moment it is seen; the generation says which campaign it was meant for.
   */
  stopRequestedAt?: number;
  stopGeneration?: number;
  /** The missing proofs the last delivery round ended with, to detect progress. */
  deliveryProofsSignature?: string;
  deliveryReported?: boolean;
  /**
   * The independent reviewer's verdict text for the last delivery report
   * (Codex / gpt-6-astra, read-only), or the reason it could not run.
   * Rendered verbatim in the report; never folded into the campaign's own verdict.
   */
  independentReview?: { ok: boolean; model: string; text: string; ms: number; error?: string };
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
  /**
   * The GDD section headings this sprint covers, as the document spells them
   * (2026-09-10). Until then a milestone was {title, prompt} only, so which
   * sections a plan covered could not be asked of anything but a later LLM.
   */
  coveredSections: z.array(z.string().min(1).max(160)).max(40).default([]),
  /** Concrete things this sprint leaves behind: scenes, prefabs, systems, screens, clips. */
  deliverables: z.array(z.string().min(1).max(200)).max(30).default([]),
});

export const milestoneLadderSchema = z.object({
  milestones: z.array(milestonePlanSchema).min(2).max(24),
  /** What the planner dropped because the GDD explicitly excludes it, with the GDD's reason. */
  excluded: z.array(z.string().min(1).max(200)).max(30).default([]),
});

export type MilestoneLadder = z.infer<typeof milestoneLadderSchema>;

/** A validated ladder plus what the measured GDD scope says about it. */
export interface PlannedLadder extends MilestoneLadder {
  /** GDD headings no milestone claims, after one re-plan asked for them. */
  readonly uncoveredSections: string[];
  /** Headings the GDD has (trivial apparatus removed). */
  readonly totalSections: number;
  readonly minMilestones: number;
  readonly maxMilestones: number;
}

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

/** The campaign's view of a unity_playthrough verdict (see playthrough-verdict.ts). */
export interface PlaythroughEvidence {
  /** A verdict for THIS sprint exists and was readable. */
  found: boolean;
  /** The file exists but predates the sprint. */
  stale?: boolean;
  unreadable?: boolean;
  ok?: boolean;
  reasons?: string[];
  scene?: string;
  session?: number;
  /** PlaythroughOutcome name the driver reported: Won, Lost, Ended (None while unfinished). */
  outcome?: string;
  /** IsSessionActive read after boot, before StartSession: does the game start play by itself? */
  autoStarted?: boolean;
  actions?: number;
  /** Why the test could not drive at all (no driver registered, no scene, no bootstrapper). */
  missing?: string;
  frames?: { count: number; flat: number; maxMotionShare: number };
  /**
   * Strada.Core.Play.ISessionCatalog.SessionCount when the game registers
   * one; absent when it does not (the level count is then not measurable).
   */
  sessionCount?: number;
  /** Every session the run played: index, outcome (None = never ended), actions. */
  /**
   * `index` and `actions` are OPTIONAL on purpose: a record that omitted them
   * used to be read as index 0 with 0 actions, which is a played level as far
   * as a counter is concerned (Codex 2026-09-11 E#7). Absent stays absent.
   */
  sessions?: Array<{ index?: number; outcome: string; actions?: number; seconds: number }>;
  /**
   * What was on screen at the end of play (2026-09-10): world renderers, the
   * sprite/mesh names they bind, engine primitives, audio. The file scan
   * cannot see what code instantiates; this can.
   */
  runtime?: RuntimeSceneDump;
  /**
   * Boot time and frame timing of the play-through. `medium` names the
   * conditions (the editor in play mode under -batchmode): boot time and
   * hitches transfer to the player, the average frame rate is a floor.
   */
  perf?: PlaythroughPerf;
  measuredAt?: string;
}

export interface RuntimeSceneDump {
  renderers: number;
  worldRenderers: number;
  spriteRenderers: number;
  meshRenderers: number;
  canvases: number;
  particleSystems: number;
  audioSources: number;
  audioPlaying: number;
  sprites: string[];
  meshes: string[];
  primitiveMeshes: number;
}

export interface PlayerBuildEvidence {
  /** The target the campaign ASKED for, from the GDD's platform (Codex 2026-09-11 B#11). */
  readonly requestedTarget?: string;
  /**
   * Platforms the document asked for and this build is not. Structured rather
   * than a sentence in `reasons`, because a FAILED build renders only its
   * first two reasons and the disclosure vanished exactly when the campaign
   * needed it (Codex 2026-09-11 J#21).
   */
  readonly unbuiltTargets?: readonly string[];
  /** The build tool ran to a verdict (ok or failed). false = could not run / not attempted. */
  ran: boolean;
  ok?: boolean;
  reasons?: string[];
  target?: string;
  /** Absolute path of the artifact on disk, when built. */
  artifactPath?: string;
  sizeBytes?: number;
  durationMs?: number;
  scenes?: number;
  /** Why it did not run, or the tool's first line. */
  detail?: string;
  measuredAt?: string;
}

export interface PlaythroughPerf {
  medium: string;
  bootSeconds?: number;
  playSeconds: number;
  playFrames: number;
  avgFps?: number;
  worstFrameMs?: number;
}
