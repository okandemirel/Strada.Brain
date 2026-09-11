/**
 * Campaign Manager — the state machine and driver.
 *
 * Owns the campaign lifecycle: idea → GDD → (one approval gate) → milestone
 * ladder → sprint after sprint → delivery. Execution itself is delegated to
 * the ordinary task pipeline (`TaskManager.submit`); the manager listens to
 * task lifecycle events and walks the ladder. State is persisted after every
 * transition, so a crash mid-sprint resumes instead of restarting the game.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";
import { allProvidersCoolingDownMs, describeProviderOutage, msSinceNewestProviderFailure } from "../agents/providers/provider-outage.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES, TaskStatus } from "../tasks/types.js";
import { stripRetryMachinery } from "../tasks/auto-resume.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { GDD_AUDIT_FULL_CHARS } from "./campaign-planner.js";
import type { CampaignStorage } from "./campaign-storage.js";
import { detectCampaignIntent } from "./campaign-intake.js";
import { assessSceneHygiene, renderSceneHygiene } from "./scene-hygiene.js";
import { readPlaythroughVerdict, describePlaythrough, playthroughDirective, PLAYER_PLAYTHROUGH_VERDICT_REL } from "./playthrough-verdict.js";
import { gddPlatform } from "./gdd-platform.js";
import { readPlaymodeRun } from "./playmode-run.js";
import { assessNumericClaims, claimsRefusal, describeClaims, extractNumericClaims } from "./gdd-claims.js";
import { deliveryReviewPrompt, renderSecondOpinion } from "../agents/review/codex-second-opinion.js";
import {
  artDirectionText,
  extractLookDescription,
  judgeVisualConformance,
  renderVisualConformance,
  selectGameplayFrame,
} from "./visual-conformance.js";
import { extractCoreLoop, readUnityVersion, renderHowToRun } from "./how-to-run.js";
import { isTerminalFailureReport } from "../agents/autonomy/verifier-pipeline.js";
import { assessBuiltAsSpecified, asksForFlatArt, PLACEHOLDER_GRADE_RULE } from "../agents/autonomy/built-as-specified.js";
import { assessSpecScope } from "../agents/autonomy/spec-scope.js";
import { describeDimensionality } from "../agents/autonomy/gdd-dimensionality.js";
import { describeMedia } from "../agents/autonomy/gdd-media.js";
import type { Campaign, CampaignMilestone,
  PlayerBuildEvidence,
  PlaythroughEvidence,
} from "./types.js";
import { buildCampaignStatus, type CampaignStatusSnapshot } from "./campaign-status.js";
import { generateCampaignId } from "./types.js";

/** The channel-agnostic way back to the conversation (approval gate, reports). */
export type CampaignMessenger = (chatId: string, markdown: string) => Promise<void>;

export interface CampaignContext {
  chatId: string;
  channelType: string;
  userId: string;
  conversationId?: string;
}

/** What a compile check answers; `ran: false` means nothing was measured. */
export interface CompileVerdict {
  /** True only when a compile actually ran AND reported no errors. */
  readonly ok: boolean;
  /** False when no verifier was available — a skip, never a pass. */
  readonly ran: boolean;
  /** Errors counted, when the verifier gave a number. */
  readonly errors?: number;
  /** The verifier's own sentence, for the report. */
  readonly detail?: string;
}

export interface CampaignManagerOptions {
  storage: CampaignStorage;
  planner: CampaignPlanner;
  /**
   * How long a self-revived implementation failure waits before its next
   * round. Injected only so a test can drive the whole bounded loop instead
   * of asserting the first arming and trusting the rest (Codex 2026-09-11 F#1).
   */
  implementationReviveDelayMs?: number;
  /**
   * A provider that claims vision on its OWN capabilities (never a fallback
   * chain — see ProviderManager.getVisionProvider). Absent means the look
   * check is reported as not checked, never as passed.
   */
  visionProvider?: { provider: import("../agents/providers/provider.interface.js").IAIProvider; name: string } | null;
  taskManager: TaskManager;
  messenger: CampaignMessenger;
  projectRoot: string;
  /**
   * Does the project compile RIGHT NOW? Injected because the campaign has no
   * tool registry of its own; bootstrap wires the same unity_verify_change the
   * real-tree guardian uses.
   *
   * Measured live 2026-09-04 21:37: Sprint 7 was committed green (1296 files,
   * f674e8d) and the campaign delivered, while the tree carried 37 compile
   * errors — found seconds later by the guardian, not by any gate. Every other
   * gate reads what an agent REPORTED; nothing asked the compiler.
   *
   * Absent (or `ran: false`) means the check is DISCLOSED as not run, never
   * treated as a pass.
   */
  verifyCompile?: (projectRoot: string) => Promise<CompileVerdict>;
  /**
   * Build the player from the project root and measure the artifact. The
   * delivery gate runs it ONCE per final-sprint evaluation, only after the
   * other proofs stand (a build is minutes; a tree that fails the suite
   * does not need one yet). See stage-runtime for the tool-backed default.
   */
  buildPlayer?: (projectRoot: string, target?: string) => Promise<PlayerBuildEvidence>;
  /** Pause before a NOT DELIVERED campaign resumes its final sprint by itself (default 15 min). */
  deliveryResumeDelayMs?: number;
  /**
   * Play the game inside the artifact the campaign just built (unity_run_player,
   * 2026-09-10). The verdict is read back from the project afterwards; the
   * frame rate it measures is the one a design document's target means.
   */
  runPlayer?: (projectRoot: string, artifactPath: string) => Promise<void>;
  /**
   * Hand a file to the origin chat (2026-09-10): the newest captured frame of
   * the running game travels with every delivery report, so a person sees the
   * game the sentences describe. Absent = the channel cannot carry files.
   */
  attach?: (chatId: string, attachment: import("../channels/channel-messages.interface.js").Attachment) => Promise<void>;
  /**
   * The independent second opinion asked before every delivery report
   * (user's ask, 2026-09-07: "çifte teyit"). Production wires the Codex CLI
   * runner (gpt-6-astra at high effort, read-only, against the project) at
   * bootstrap; absent, the report says the review did not run.
   */
  independentReviewer?: ((params: { projectRoot: string; prompt: string }) => Promise<import("../agents/review/codex-second-opinion.js").SecondOpinion>) | null;
  /** Auto-retry budget per milestone before the campaign fails loudly. */
  maxMilestoneAttempts?: number;
  /** GDD revision rounds at the approval gate before cancelling. */
  maxDraftAttempts?: number;
  /** Grace before reacting to a bad settlement (tests shrink it). */
  retryAdoptionGraceMs?: number;
  /** Delay before acting on a COMPLETED settle (lets the lease write-back land). */
  completedSettleDelayMs?: number;
  /**
   * How long one milestone may run before the campaign forces a
   * scope-narrowing escalation (default 6h). Bounces and deferrals do not
   * burn attempts by design, so without this a sprint can spin forever —
   * measured 2026-08-31: m6 ran 22h at attempts=1.
   */
  milestoneTimeBoxMs?: number;
  /**
   * GDD→style.json derivation, run at plan time (post-approval). Optional:
   * without it the campaign still plans, tools just fall back to stock
   * style defaults.
   */
  styleAnalysis?: import("../agents/style/style-analysis.js").StyleAnalysis;
}

const APPROVE_RE = /^(evet|onay|onaylıyorum|yes|ok|okay|approve[ds]?|lgtm|devam|go ahead|go)[.!\s]*$/i;

/** "kampanya devam" / "campaign resume" — revive the newest failed/cancelled campaign on this chat. */
const REVIVE_RE = /^(kampanya(yı)?\s+(devam( et(tir)?)?|sürdür)|campaign\s+(resume|retry|continue)|resume\s+campaign)\b/i;

/**
 * How long a settled-badly milestone waits before the campaign reacts. The
 * executor's own keep-alive handles transient failures by blocking the task
 * and scheduling a retry under a NEW task id ~30s later; reacting to the
 * block instantly made the campaign double-submit the same sprint and burn
 * its attempt budget on failures that were never real. After this window the
 * lineage is re-read: a newer active task is adopted, a newer terminal one is
 * judged on its own outcome.
 */
const RETRY_ADOPTION_GRACE_MS = 90_000;

const GDD_DRAFT_PROMPT = (idea: string, revisionNote?: string) =>
  `You are writing the game design document for a game that will then be built autonomously by this same system.

GAME IDEA:
${idea}

${revisionNote ? `REVISION REQUEST FROM THE DESIGNER (address it fully):\n${revisionNote}\n` : ""}
Write a complete, buildable GDD and save it as a markdown file under docs/ in this project (e.g. docs/<GameName>_GDD.md). The document is the ONLY instruction the build will receive, so it must be concrete and exhaustive:
- Pillars and fantasy, core loop, win/lose rules
- Mechanics and game elements as an explicit schedule/table (each element: name, behaviour, rules) — the build reads this table literally
- Level/progression structure and what happens between levels
- Art/presentation direction concrete enough to build placeholder visuals from
- Constraints: built WITH Strada.Core modules, verified by headless compile + PlayMode tests + captured frames

Do not ask questions — make strong, coherent choices and write them down. End your result with the project-relative path of the file you wrote.`;

/**
 * Did the provider layer stop this run, rather than the sprint failing?
 *
 * TWO signals, deliberately weighted differently:
 *
 *  - `blocked:provider_unavailable` is the EXECUTOR's own classification, so
 *    it stands on its own. Measured live 2026-09-04 19:36: mcov1 settled with
 *    exactly that marker while the zen endpoint answered 503 in bursts. The
 *    registry's five-minute overload cooldown had lapsed between the failure
 *    and the settle, so `coolingMs` read 0, the exemption did not fire, and
 *    the sprint was FAILED after "2 attempts" it had spent on an endpoint that
 *    never answered.
 *
 *  - Free text merely MENTIONING a provider still needs the registry to agree.
 *    Arming on wording alone once made a "quota" message replan every two
 *    minutes against a chain that read available (review of 6d520d19), and
 *    planning has no attempt budget to stop it.
 */
export function isOutageCausedSettle(
  output: string,
  coolingMs: number,
  msSinceProviderFailure: number = Number.POSITIVE_INFINITY,
): boolean {
  if (typeof output !== "string" || output.length === 0) return false;
  if (/blocked:provider_unavailable/i.test(output)) return true;
  // The provider chain's own verdict — every member cooling, probing or
  // failed — stands like the executor's marker. Measured 2026-09-08 15:18:
  // a revived sprint settled on "All providers failed or unavailable. A
  // recovery probe was already in flight…", the probe then succeeded
  // (coolingMs 0, no failure on record), and attempt 2 was charged for it.
  if (/All providers failed or unavailable/i.test(output)) return true;
  // The executor's inactivity stop ("stalled without making progress" /
  // "made no progress for Nms") is an outage when a chain member recorded a
  // failure recently — measured 2026-09-08 06:58: two 600 s provider-stalls
  // and two first-response aborts preceded the stop, a 40-token probe passed
  // seconds later, coolingMs read 0, attempt 1 → 2 for a queue never passed.
  if (
    (/stalled without making progress|made no progress for \d+ms/i.test(output) || TURKISH_STALL_RE.test(output)) &&
    msSinceProviderFailure <= RECENT_PROVIDER_FAILURE_MS
  ) {
    return true;
  }
  return /provider|cooldown|quota|rate.?limit/i.test(output) && coolingMs > 0;
}

/** A provider failure this recent explains an inactivity stop. */
export const RECENT_PROVIDER_FAILURE_MS = 30 * 60_000;

/** The Turkish executor's own inactivity stop (background-executor.ts). */
const TURKISH_STALL_RE = /Görev ilerleme kaydetmeden takıldı/i;

/** A player run that says THIS MACHINE cannot execute the artifact. */
export const UNRUNNABLE_HERE_RE =
  // "no player runner is configured" is NOT here: a runner this deployment
  // never set up is our own gap, and treating it as host incapability waived
  // playing the game entirely — delivery reached `done` with an artifact
  // nobody had run (Codex 2026-09-11 F#12). It stays in UNMEASURABLE_PROOF_RE
  // below, so the campaign revives twice and then asks a person, which is the
  // honest end for a missing tool.
  /\b(?:exec format error|not supported on this (?:platform|host)|unsupported (?:artifact|platform|target|host)|requires (?:a|an) (?:device|emulator|simulator)|cannot be executed on this (?:platform|host|machine))\b/i;
/** Missing proofs that describe absent TOOLING rather than a broken game. */
/**
 * Missing proofs whose reason is absent TOOLING. Matched against the campaign's
 * OWN generated wording, not against a game's error text: "IPlaythroughDriver
 * is not registered" is implementation work.
 *
 * "no test run was observed" is NOT here (it was, from D#4). It describes an
 * OMISSION — a worker that finished without running the suite — not a machine
 * that cannot run it, and three such rounds escalated to a person as an
 * infrastructure verdict about tooling that was present and working the whole
 * time (Codex 2026-09-11 F#5). A missing run is ordinary missing work: the
 * delivery gate bounces it with an explicit directive, and an exhausted
 * milestone self-revives with a changed approach. Absent TEST tooling still
 * names itself ("no test verifier is configured") and still counts.
 */
export const UNMEASURABLE_PROOF_RE =
  /(?:the compile check did not run|the player build did not run|no compile verifier is configured|no player builder is configured|no player runner is configured|unity_build_player is not registered|no test verifier is configured|the built player was never played to a verdict)/i;
/**
 * Does this round's shortfall include a proof absent TOOLING explains? ANY
 * such proof counts: requiring all of them meant one game-shaped proof beside
 * it reset the counter and the revive loop ran forever (Codex 2026-09-11 D#3).
 */
export function hasUnmeasurableProof(missingProofs: readonly string[]): boolean {
  return missingProofs.some((m) => UNMEASURABLE_PROOF_RE.test(m));
}

/** Self-revivals spent on a proof this machine cannot produce before asking a person. */
const MAX_UNMEASURABLE_REVIVES = 2;
/**
 * Self-revivals spent on an ORDINARY implementation failure: a sprint that ran
 * out of attempts with healthy providers and a real blocker ("Compile error
 * CS0246: missing type PlayerController"). Two, with the approach changed each
 * time. Before this the campaign ended `failed` with no revival and waited for
 * a person to type "kampanya devam" — the one thing an autonomous run cannot
 * do for itself (Codex 2026-09-11 F#1).
 */
const MAX_IMPLEMENTATION_REVIVES = 2;
/**
 * Delivery rounds spent on the SAME missing proofs before the campaign stops
 * and asks a person. More than the implementation budget, because a delivery
 * round is the whole game being measured rather than one sprint's work, and
 * bounded because repeating a round that changes nothing is how a daemon
 * spends a month without shipping (Codex 2026-09-11 H#1).
 */
const MAX_DELIVERY_REVIVES = 3;
/**
 * WHICH GATES failed, from the gates' own outcomes.
 *
 * The delivery budget is charged per distinct failure, so the identity of a
 * failure may not be read out of the sentences the gates write: a frame count
 * inside a sentence, a word like "driver" appearing in an explanation, or a
 * truncation at 220 characters all changed the identity while the game stayed
 * exactly as broken (Codex 2026-09-11 I#1, K#3, K#4, K#5). Flags cannot be
 * paraphrased. Sorted, so the set is the identity.
 */
export function deliveryFailureKinds(flags: {
  testsNotRun: boolean;
  testsFiltered: boolean;
  compileBroken: boolean;
  compileNotRun: boolean;
  playthroughMissing: boolean;
  playthroughStale: boolean;
  playthroughRefused: boolean;
  buildBroken: boolean;
  buildNotRun: boolean;
  playerMissing: boolean;
  playerBroken: boolean;
  claimsBroken: boolean;
  structureRefused: boolean;
  queuedGaps: boolean;
}): string[] {
  return Object.entries(flags)
    .filter(([, on]) => on === true)
    .map(([kind]) => kind)
    .sort();
}

/**
 * WHICH PROOFS are missing, as kinds rather than as sentences.
 *
 * The delivery budget is charged per distinct failure, so the identity of a
 * failure may not contain a measurement: "0 frames" and "1 frame" are the same
 * missing proof, and treating them as progress let a campaign revive for ever
 * (Codex 2026-09-11 I#1). Exported for its tests.
 */
export function proofSignature(
  missingProofs: readonly string[],
  extra: { structureRefused: boolean; compileBroken: boolean },
): string {
  const kinds = new Set<string>();
  for (const proof of missingProofs) {
    const text = proof.toLowerCase();
    if (text.includes("no test run") || text.includes("test verifier")) kinds.add("tests-not-run");
    else if (text.includes("filtered")) kinds.add("tests-filtered");
    else if (text.includes("does not compile")) kinds.add("compile-broken");
    else if (text.includes("compile check did not run")) kinds.add("compile-not-run");
    else if (text.includes("player build failed")) kinds.add("build-failed");
    else if (text.includes("player build did not run")) kinds.add("build-not-run");
    // THE PLAYER's own play, before the editor's: "inside the built player"
    // is the player gate whatever words follow, and "the built player was
    // never played" is its missing half. Matching "never played" first put
    // the EDITOR's missing play-through under the player's name, so the same
    // failure took two identities depending on whether a stale verdict
    // happened to exist (Codex 2026-09-11 J#10).
    else if (text.includes("inside the built player")) kinds.add(`player-broken:${playthroughFailureTag(text)}`);
    else if (text.includes("built player was never played")) kinds.add("player-not-played");
    else if (text.includes("play-through") || text.includes("playthrough")) {
      // …and WHICH WAY the play-through failed is part of its identity: a game
      // that cannot start a session and one that cannot reach an ending are
      // different problems, and collapsing them spent a delivery round on
      // progress (Codex 2026-09-11 J#9).
      kinds.add(`playthrough:${playthroughFailureTag(text)}`);
    }
    else if (text.includes("gdd could not be read")) kinds.add("gdd-unreadable");
    else if (text.includes("fps") || text.includes("level count") || text.includes("claim")) kinds.add("gdd-claims");
    // A proof whose wording this list does not know is identified by its
    // first few words rather than by its numbers.
    else kinds.add(text.replace(/[0-9]+/g, "#").split(/[:(]/)[0]!.trim().slice(0, 40));
  }
  // …and the two refusals that never travelled in missingProofs (I#2).
  if (extra.structureRefused) kinds.add("structure-refused");
  if (extra.compileBroken) kinds.add("compile-broken");
  return [...kinds].sort().join(" | ").slice(0, 400) || "none-named";
}

/**
 * The id THIS ATTEMPT issues for the runs it asks for.
 *
 * A worker writes the records the gates read, so freshness is the only thing
 * those records prove today: a run id the campaign issues and the tool echoes
 * is what binds a record to the attempt that asked for it (the open half of
 * Codex 2026-09-11 F#10 / I#11). Derived, so it needs no column: the same
 * attempt always computes the same id, and a new attempt a different one.
 */
export function attemptRunId(milestone: { id: string; attemptStartedAtMs?: number; startedAtMs?: number; attempts?: number }): string {
  const started = milestone.attemptStartedAtMs ?? milestone.startedAtMs ?? 0;
  return `${milestone.id}-${milestone.attempts ?? 0}-${started}`;
}

/**
 * The requirement a coverage sprint exists to close.
 *
 * `coverageGap` is the record; a milestone persisted before that field existed
 * has the requirement in its own prompt ("- <requirement>"), and its truncated
 * TITLE is the last resort (Codex 2026-09-11 K#2).
 */
function coverageGapOf(m: { title: string; prompt?: string; coverageGap?: string }): string {
  if (m.coverageGap) return m.coverageGap;
  const fromPrompt = /\n- (.+)\n/.exec(m.prompt ?? "")?.[1];
  return fromPrompt ?? m.title.replace(/^Coverage completion \d+\.\d+ — /, "");
}

/** A coverage requirement's identity: its own text, normalized — never a prefix. */
export function gapKey(gap: string): string {
  return gap.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The requirements that still need a sprint: each named once, and none that a
 * sprint already covers.
 *
 * A sprint that FAILED covers nothing — counting it as covered made a required
 * feature disappear from further repair the moment one attempt had been made —
 * and identity is the requirement's whole text, because matching on the title's
 * 60-character prefix merged different requirements (Codex 2026-09-11 J#12, J#13).
 */
export function unscheduledGaps(
  candidates: readonly string[],
  milestones: ReadonlyArray<{ id: string; title: string; prompt?: string; status?: string; coverageGap?: string }>,
  opts: { reopenCompleted?: boolean } = {},
): string[] {
  // A FRESH AUDIT outranks a finished sprint: the audit has just looked at
  // the tree and said the feature is missing, and suppressing that because a
  // sprint once ran for it delivered the game without it (Codex 2026-09-11
  // K#1). Only work still OUTSTANDING suppresses a duplicate. A queue drain
  // passes nothing and keeps the stricter rule, because its entries were
  // named by an audit that has already been reconciled.
  const suppresses = (status?: string): boolean =>
    opts.reopenCompleted === true ? status === "pending" || status === "running" : status !== "failed";
  const covered = new Set(
    milestones
      .filter((m) => m.id.startsWith("mcov") && suppresses(m.status))
      .map((m) => gapKey(coverageGapOf(m))),
  );
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = gapKey(item);
    if (key === "" || seen.has(key) || covered.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * HOW a play-through failed, as a word rather than a sentence: the identity a
 * delivery budget can compare across rounds without reading its measurements
 * (Codex 2026-09-11 J#9).
 */
function playthroughFailureTag(text: string): string {
  if (text.includes("refused") || text.includes("never started") || text.includes("did not start")) return "not-started";
  if (text.includes("took no action") || text.includes("no action")) return "no-actions";
  if (text.includes("no frame") || text.includes("captured 0")) return "no-frames";
  if (text.includes("never ended") || text.includes("no outcome") || text.includes("reached no outcome")) return "no-outcome";
  if (text.includes("not registered") || text.includes("driver")) return "no-driver";
  if (text.includes("no verdict") || text.includes("left no")) return "no-verdict";
  return "other";
}

/** The revival tail, kept to exactly one copy however many revivals happen. */
const REVIVE_TAIL_RE = /\n\nA ROUND OF ATTEMPTS ENDED[\s\S]*?keep whatever already works\./g;
/** How long before a self-revived implementation failure tries again. */
const IMPLEMENTATION_REVIVE_DELAY_MS = 5 * 60_000;

export class CampaignManager {
  private readonly storage: CampaignStorage;
  private readonly planner: CampaignPlanner;
  private readonly visionProvider: { provider: import("../agents/providers/provider.interface.js").IAIProvider; name: string } | null;
  private readonly taskManager: TaskManager;
  private readonly messenger: CampaignMessenger;
  private readonly projectRoot: string;
  private readonly verifyCompile?: (projectRoot: string) => Promise<CompileVerdict>;
  private readonly buildPlayer?: (projectRoot: string, target?: string) => Promise<PlayerBuildEvidence>;
  private readonly deliveryResumeDelayMs: number;
  private readonly implementationReviveDelayMs: number;
  private readonly runPlayer?: (projectRoot: string, artifactPath: string) => Promise<void>;
  private readonly attach?: (chatId: string, attachment: import("../channels/channel-messages.interface.js").Attachment) => Promise<void>;
  private readonly independentReviewer: CampaignManagerOptions["independentReviewer"];
  private readonly maxMilestoneAttempts: number;
  private readonly maxDraftAttempts: number;
  private readonly retryAdoptionGraceMs: number;
  private readonly completedSettleDelayMs: number;
  private readonly milestoneTimeBoxMs: number;
  private readonly styleAnalysis?: import("../agents/style/style-analysis.js").StyleAnalysis;
  private eventsAttached = false;

  constructor(options: CampaignManagerOptions) {
    this.storage = options.storage;
    this.planner = options.planner;
    this.visionProvider = options.visionProvider ?? null;
    this.taskManager = options.taskManager;
    this.messenger = options.messenger;
    this.projectRoot = options.projectRoot;
    this.verifyCompile = options.verifyCompile;
    this.buildPlayer = options.buildPlayer;
    this.deliveryResumeDelayMs = options.deliveryResumeDelayMs ?? 15 * 60_000;
    this.implementationReviveDelayMs = options.implementationReviveDelayMs ?? IMPLEMENTATION_REVIVE_DELAY_MS;
    this.runPlayer = options.runPlayer;
    this.attach = options.attach;
    this.independentReviewer = options.independentReviewer;
    this.maxMilestoneAttempts = options.maxMilestoneAttempts ?? 2;
    this.maxDraftAttempts = options.maxDraftAttempts ?? 3;
    this.retryAdoptionGraceMs = options.retryAdoptionGraceMs ?? RETRY_ADOPTION_GRACE_MS;
    this.completedSettleDelayMs = options.completedSettleDelayMs ?? 5_000;
    this.milestoneTimeBoxMs = options.milestoneTimeBoxMs ?? 6 * 60 * 60_000;
    this.styleAnalysis = options.styleAnalysis;
  }

  /** Subscribe to task lifecycle events. Idempotent. */
  attachEvents(): void {
    if (this.eventsAttached) return;
    this.eventsAttached = true;
    this.taskManager.on("task:completed", (taskId: string, result: string) => {
      void this.handleTaskSettled(taskId, TaskStatus.completed, result);
    });
    this.taskManager.on("task:failed", (taskId: string, error: string) => {
      void this.handleTaskSettled(taskId, TaskStatus.failed, error);
    });
    this.taskManager.on("task:blocked", (taskId: string, reason: string) => {
      void this.handleTaskSettled(taskId, TaskStatus.blocked, reason);
    });
    this.taskManager.on("task:cancelled", (taskId: string) => {
      void this.handleTaskSettled(taskId, TaskStatus.cancelled, "cancelled");
    });
  }

  /** Idea mode: draft the GDD first, then stop at the single approval gate. */
  startFromIdea(ctx: CampaignContext, ideaText: string): Campaign {
    const campaign = this.newCampaign(ctx, { ideaText });
    this.submitDraft(campaign);
    return campaign;
  }

  /**
   * GDD mode: the design document already exists (supplied or already in
   * docs/), so per the product decision there is NO approval gate — plan the
   * ladder and start building immediately.
   */
  startFromGdd(ctx: CampaignContext, gddText: string, gddPath?: string): Campaign {
    const campaign = this.newCampaign(ctx, { gddText, gddPath });
    void this.planAndLaunch(campaign.id);
    return campaign;
  }

  /** GDD-from-docs mode: build from the newest GDD already in the repo. */
  startFromGddFromDocs(ctx: CampaignContext): Campaign | undefined {
    const gddPath = this.findNewestGddPath();
    if (!gddPath) return undefined;
    const gddText = readGddFile(this.projectRoot, gddPath);
    if (!gddText) return undefined;
    return this.startFromGdd(ctx, gddText, gddPath);
  }

  /**
   * Router entry point: approval-gate replies first, then new-campaign
   * intent. Returns true when the message was consumed by the campaign layer.
   */
  async tryHandleIncoming(msg: IncomingMessage): Promise<boolean> {
    if (await this.tryHandleApproval(msg.chatId, msg.text)) return true;
    if (await this.tryHandleRevive(msg.chatId, msg.text)) return true;

    const intent = detectCampaignIntent(msg);
    if (!intent) return false;
    if (this.storage.hasActiveForChat(msg.chatId)) return false; // one build per chat
    if (this.storage.hasActiveForProject(this.projectRoot)) {
      // Another chat is already building this project — a second concurrent
      // ladder against the same repo is never what anyone wants.
      await this.tell(
        { chatId: msg.chatId },
        "A campaign is already building this project from another conversation — not starting a second one against the same repo.",
      );
      return true;
    }

    const ctx: CampaignContext = {
      chatId: msg.chatId,
      channelType: msg.channelType,
      userId: msg.userId,
      conversationId: msg.conversationId,
    };

    switch (intent.kind) {
      case "idea": {
        const campaign = this.startFromIdea(ctx, intent.ideaText);
        await this.tell(
          campaign,
          "Game idea received — drafting the GDD first. I'll show it to you once for approval, then the build runs to delivery on its own.",
        );
        return true;
      }
      case "gdd-attachment": {
        // Persist the supplied design into the repo FIRST so planning and
        // every sprint prompt reference a durable, committable path.
        const gddPath = this.persistSuppliedGdd(intent.gddText, intent.sourceName);
        const campaign = this.startFromGdd(ctx, intent.gddText, gddPath);
        await this.tell(campaign, `GDD received (${intent.sourceName}) — planning the milestone ladder, then the build starts.`);
        return true;
      }
      case "gdd-from-docs": {
        const campaign = this.startFromGddFromDocs(ctx);
        if (!campaign) {
          await this.tell(
            { chatId: msg.chatId },
            "No GDD found under docs/ — share the document or write the idea, and I'll take it from there.",
          );
          return true;
        }
        await this.tell(campaign, `Building from \`${campaign.gddPath}\` — planning the milestone ladder, then the build starts.`);
        return true;
      }
    }
  }

  /** The approval gate. Returns true when the message was consumed by it. */
  async tryHandleApproval(chatId: string, text: string): Promise<boolean> {
    const campaign = this.storage.findAwaitingApproval(chatId);
    if (!campaign) return false;

    const trimmed = text.trim();
    if (APPROVE_RE.test(trimmed)) {
      // Claim the gate BEFORE yielding: the channel round-trip below is a real
      // await, and the router has no per-chat serialization, so a double-tap
      // or a redelivered "evet" found the campaign still awaiting-approval
      // and planned the ladder twice — two billable passes, a clobbered
      // ladder, two sprint-1 tasks (audited 2026-09-02).
      campaign.state = "planning";
      this.persist(campaign);
      await this.tell(
        campaign,
        "GDD approved — planning the milestone ladder, then the build starts. First stop after this is the delivery report.",
      );
      void this.planAndLaunch(campaign.id);
      return true;
    }

    campaign.draftAttempts += 1;
    if (campaign.draftAttempts > this.maxDraftAttempts) {
      campaign.state = "cancelled";
      campaign.lastError = "approval gate exceeded revision budget";
      this.persist(campaign);
      await this.tell(
        campaign,
        `Campaign cancelled after ${this.maxDraftAttempts} GDD revision rounds. Start a new campaign when the direction is clearer.`,
      );
      return true;
    }

    await this.tell(
      campaign,
      `Revision noted (round ${campaign.draftAttempts}/${this.maxDraftAttempts}) — rewriting the GDD.`,
    );
    this.submitDraft(campaign, trimmed);
    return true;
  }

  /**
   * "kampanya devam" — revive the newest failed/cancelled campaign on this
   * chat. A campaign used to be unrevivable the moment it went `failed`
   * (absent from listActive, no command, no code path); two graceful restarts
   * were enough to get there. Revival resets the current milestone's attempt
   * budget and resubmits it — everything already green stays green.
   */
  async tryHandleRevive(chatId: string, text: string): Promise<boolean> {
    if (!REVIVE_RE.test(text.trim())) return false;
    const campaign = this.storage.findLatestRevivable(chatId);
    if (!campaign) return false;
    if (this.storage.hasActiveForChat(chatId) || this.storage.hasActiveForProject(this.projectRoot)) {
      await this.tell({ chatId }, "A campaign is already active for this project — the failed one stays parked.");
      return true;
    }

    const milestone = campaign.milestones[campaign.currentMilestone];
    if (!milestone) {
      campaign.lastError = undefined;
      campaign.autoReviveAt = undefined;
      if (this.isIdeaModeBeforeGdd(campaign)) {
        // Idea mode, no GDD yet: the draft is the work, not the ladder.
        this.persist(campaign);
        await this.tell(campaign, "Reviving the campaign — rewriting the GDD from your idea.");
        this.submitDraft(campaign);
        return true;
      }
      // Failed before/during planning — replan from the GDD.
      campaign.state = "planning";
      this.persist(campaign);
      await this.tell(campaign, "Reviving the campaign — replanning the milestone ladder from the GDD.");
      void this.planAndLaunch(campaign.id);
      return true;
    }

    await this.reviveAtCurrentMilestone(campaign, milestone);
    return true;
  }

  /**
   * Stop every live run this campaign still owns. A terminal campaign must
   * not keep writing to the project: measured live 2026-09-03 09:19, minutes
   * after delivery the executor's boot keep-alive revived a blocked task from
   * a pre-delivery lineage and resubmitted the sprint against a game that had
   * already been delivered.
   */
  /** Cancel the root of a task's retry/replan lineage, so every future
   *  descendant inherits a cancelled ancestor (audited 2026-09-03). */
  private cancelLineageRootOf(taskId: string, opts?: { reason: "superseded" }): void {
    try {
      const manager = this.taskManager as unknown as {
        findLineageRootId?: (id: string) => string | null;
        getStatus?: (id: string) => { id: string; status?: string; parentId?: string } | null;
        cancel?: (id: string, opts?: { reason: "superseded" }) => void;
      };
      let rootId = manager.findLineageRootId?.(taskId) ?? null;
      if (!rootId) {
        let current = manager.getStatus?.(taskId) ?? null;
        for (let depth = 0; current?.parentId && depth < 50; depth++) {
          const parent = manager.getStatus?.(current.parentId) ?? null;
          if (!parent) break;
          current = parent;
        }
        rootId = current?.id ?? null;
      }
      if (!rootId || rootId === taskId) return;
      const root = manager.getStatus?.(rootId);
      if (root && root.status !== "completed" && root.status !== "cancelled") {
        // The ROOT is what every future descendant inherits, so a recoverable
        // retirement must stamp it "superseded" too (Codex 2026-09-11 F#6).
        manager.cancel?.(rootId, opts);
      }
    } catch { /* unreadable lineage */ }
  }

  /**
   * Retire the campaign's live lineages.
   *
   * `recoverable` marks a retirement the campaign can come back from — a
   * stop short of delivery, a superseding sprint, a failed campaign someone
   * may revive. Those cancels are stamped "superseded", which the executor
   * reads as history rather than as a stop order; a HARD cancel poisons every
   * future descendant, so the revived mission's own keep-alive and goal
   * auto-resume abandoned its recovery (Codex 2026-09-11 F#6). A DELIVERED
   * campaign is not recoverable and keeps the hard cancel.
   */
  private cancelLiveLineages(campaign: Campaign, reason: string, opts: { recoverable?: boolean } = {}): void {
    const cancelOpts = opts.recoverable === true ? ({ reason: "superseded" } as const) : undefined;
    // Identity by MISSION, not by pointer. A milestone that was resubmitted
    // points at its newest task, so walking taskId alone misses every lineage
    // the campaign abandoned along the way — and those are exactly the ones
    // the executor's boot re-arm resurrects (measured live 2026-09-03: two
    // distinct orphan roots, task_3f52a987 and task_ea50a818, still reviving
    // after delivery). Match a task to a milestone by the prompt it was
    // submitted with.
    const promptKeys = new Set(
      // A real sprint prompt is thousands of chars; 24 is enough to be
      // specific while still matching short fixtures, and the match is an
      // exact substring, not a similarity score.
      campaign.milestones.map((m) => m.prompt.slice(0, 120)).filter((k) => k.length > 24),
    );
    try {
      const onChat = this.taskManager.listTasks(campaign.chatId, 50) as unknown as Array<{
        id: string;
        status: string;
        prompt?: string;
      }>;
      for (const task of onChat) {
        if (task.status === "completed" || task.status === "cancelled") continue;
        const prompt = task.prompt ?? "";
        let owned = false;
        for (const key of promptKeys) {
          if (prompt.includes(key)) { owned = true; break; }
        }
        if (!owned) continue;
        try {
          // Cancel the lineage's ROOT as well as this task. Cancelling only
          // the live end retires nothing: the next continuation mints a fresh
          // child whose ancestry holds no cancel, and the chain walks around
          // the guard (measured live 2026-09-03 11:04, a seventh
          // resurrection). Every future descendant inherits the root.
          this.cancelLineageRootOf(task.id, cancelOpts);
          this.taskManager.cancel(task.id as TaskId, cancelOpts);
          getLoggerSafe().info("Cancelled an abandoned mission of a terminal campaign", {
            id: campaign.id,
            taskId: task.id,
            status: task.status,
            reason,
          });
        } catch { /* already settled */ }
      }
    } catch { /* listing unavailable — the lineage walk below still runs */ }
    for (const milestone of campaign.milestones) {
      if (!milestone.taskId) continue;
      // EVERY live task of the lineage, not only its newest tip and not only
      // the newest 50 of the chat: an older blocked descendant survived both
      // and the executor could resume it against a shipped game (Codex
      // 2026-09-11 I#7).
      try {
        const live = (this.taskManager as unknown as {
          listLiveInLineage?: (id: TaskId) => Array<{ id: string }>;
        }).listLiveInLineage?.(milestone.taskId as TaskId) ?? [];
        for (const task of live) {
          try { this.taskManager.cancel(task.id as TaskId, cancelOpts); } catch { /* already settled */ }
        }
        if (live.length > 0) {
          getLoggerSafe().info("Retired every live task of a milestone's lineage", {
            id: campaign.id,
            milestone: milestone.id,
            retired: live.length,
            recoverable: opts.recoverable === true,
          });
        }
      } catch { /* the tip walk below still runs */ }
      let tipId: string | undefined;
      try {
        tipId = this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)?.id;
      } catch { continue; }
      if (!tipId) continue;
      try {
        this.taskManager.cancel(tipId as TaskId, cancelOpts);
        getLoggerSafe().info("Cancelled a live lineage of a terminal campaign", {
          id: campaign.id,
          milestone: milestone.id,
          taskId: tipId,
          reason,
        });
      } catch { /* already settled */ }
    }
  }

  /**
   * Give an exhausted milestone another round with a CHANGED APPROACH, up to
   * MAX_IMPLEMENTATION_REVIVES times. Returns true when a revival was armed.
   *
   * Every path that gives up on a milestone comes through here — the ordinary
   * failure path and the time-box exhaustion, which had its own `failed` with
   * no appointment at all (Codex 2026-09-11 F#1, H#6).
   */
  private async selfReviveImplementation(
    campaign: Campaign,
    milestone: CampaignMilestone,
    status: string,
    cause: string,
  ): Promise<boolean> {
    const revives = (campaign.implementationRevives ?? 0) + 1;
    if (revives > MAX_IMPLEMENTATION_REVIVES) return false;
    campaign.implementationRevives = revives;
    milestone.status = "pending";
    milestone.attempts = 0;
    // EXACTLY ONE such tail survives — stacking one per revival is the defect
    // the attempt tail already had to fix once.
    milestone.prompt = milestone.prompt.replace(REVIVE_TAIL_RE, "");
    milestone.prompt +=
      `\n\nA ROUND OF ATTEMPTS ENDED ${status} on: ${stripRetryMachinery(cause).slice(0, 300)}. ` +
      "Do NOT repeat that approach — take a different route to the same requirement (a smaller step, a different order, " +
      "or a different implementation), and keep whatever already works.";
    // The state stays `failed` until the revival timer fires: that is what
    // scheduleAutoRevive and the boot sweep look for, so an implementation
    // revival travels the same path the outage pause already uses, and
    // reviveAtCurrentMilestone restores the attempt budget.
    campaign.state = "failed";
    const reviveDelayMs = this.implementationReviveDelayMs;
    campaign.autoReviveAt = Date.now() + reviveDelayMs;
    this.persist(campaign);
    this.scheduleAutoRevive(campaign.id, reviveDelayMs, campaign.autoReviveAt);
    getLoggerSafe().warn("Campaign self-reviving an implementation failure with a changed approach", {
      id: campaign.id,
      milestone: milestone.id,
      revives,
      cause: cause.slice(0, 200),
    });
    await this.tell(
      campaign,
      `🔁 **${milestone.title}** ran out of attempts (${status}). Cause: ${campaign.lastError ?? cause}\n` +
        `Retrying with a changed approach in ${Math.max(1, Math.round(reviveDelayMs / 60_000))} min ` +
        `(self-revival ${revives} of ${MAX_IMPLEMENTATION_REVIVES}).`,
    );
    return true;
  }

  /**
   * Was this lineage stopped BY A PERSON (or by anything other than the
   * campaign's own supersession)? Walks the lineage the same way the
   * executor's guard does, and treats an unreadable lineage as not cancelled
   * so a storage hiccup cannot strand a campaign.
   */
  private lineageWasCancelledOnPurpose(taskId: string): boolean {
    try {
      const manager = this.taskManager as unknown as {
        findLatestLineageTask?: (id: string) => { id: string } | null;
        getStatus?: (id: string) => { id: string; status?: string; cancelReason?: string; parentId?: string } | null;
      };
      // FROM THE TIP AND FROM THE MILESTONE'S OWN TASK, upward, visiting every
      // node including the last. Walking only upward from the milestone missed
      // a cancelled node BETWEEN it and the tip, and the depth guard used to
      // exit before checking the node it had just loaded (Codex 2026-09-11 J#6).
      const seen = new Set<string>();
      // The MILESTONE'S OWN TASK is examined first: pushing it and then the
      // tip meant a 200-deep chain walked back from the tip, exhausted the
      // visit budget and never looked at the task it was asked about (Codex
      // 2026-09-11 K#7).
      const tipId = manager.findLatestLineageTask?.(taskId)?.id;
      const pending: string[] = tipId && tipId !== taskId ? [tipId, taskId] : [taskId];
      while (pending.length > 0 && seen.size < 1000) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const row = manager.getStatus?.(id) ?? null;
        if (!row) continue;
        if (row.status === "cancelled" && row.cancelReason === "user") return true;
        if (row.parentId) pending.push(row.parentId);
      }
    } catch { /* unreadable lineage is not a stop order */ }
    return false;
  }

  /** Reset the current milestone's budget and resubmit it (revive core). */
  private async reviveAtCurrentMilestone(campaign: Campaign, milestone: CampaignMilestone): Promise<void> {
    // Stop whatever is still alive on the old lineage first. The executor's
    // boot re-arm revives blocked missions on its own; without this the
    // revived sprint and the re-armed old lineage ran the same prompt against
    // the same repo in parallel (measured 2026-09-02 19:23).
    const tipId = milestone.taskId
      ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)?.id
      : undefined;
    if (tipId) {
      try { this.taskManager.cancel(tipId as TaskId, { reason: "superseded" }); } catch { /* already settled */ }
    }
    milestone.attempts = 0;
    milestone.status = "pending";
    // Fresh budget = fresh gates: a revived campaign must be able to bounce
    // on missing evidence again, or revival quietly weakens the acceptance
    // bar for the rest of the run.
    milestone.visualEvidenceBounced = false;
    milestone.noWorkBounced = false;
    // The delivery-verification gate is the same one-bounce shape; leaving it
    // spent meant a revived final sprint could never be bounced for a missing
    // test run again (audited 2026-09-02: the gate landed after this block).
    milestone.deliveryVerificationBounced = false;
    // The art and prose one-shots are gates too (review 2026-09-07): left
    // spent, a revived remediation sprint could go green on 410/429
    // placeholders and documentation-only commits without a bounce. The
    // structural flag follows the next measurement, and a stale time-box
    // directive must not survive a reset of the time box itself.
    milestone.artBounced = false;
    milestone.prosOnlyBounced = false;
    milestone.structureRefused = false;
    milestone.prompt = stripTimeBoxDirectives(milestone.prompt);
    // …and the COUNTERS the gates actually read. Measured live 2026-09-04
    // 16:18: the boolean above was reset on revival while
    // deliveryVerificationBounces stayed at 2 of 2, so `deliveryBouncesSpent <
    // maxMilestoneAttempts` was false and the delivery gate could not fire.
    // Sprint 7 shipped green on "PlayMode verification passed: 184 of 185
    // tests ran clean" — a verdict carrying NO unfiltered flag, recorded
    // minutes after an unfiltered run had reported 32 of 185 failing. The
    // reset above was written when the gate was a boolean; the counter that
    // replaced it was never added here, so "fresh budget = fresh gates" had
    // quietly stopped being true.
    milestone.deliveryVerificationBounces = 0;
    milestone.sceneHygieneBounces = 0;
    milestone.deliveryProofsMissing = undefined;
    milestone.startedAtMs = undefined;
    milestone.attemptStartedAtMs = undefined;
    milestone.timeBoxEscalations = 0;
    campaign.state = "executing";
    campaign.lastError = undefined;
    campaign.autoReviveAt = undefined;
    this.persist(campaign);
    await this.tell(
      campaign,
      `Reviving the campaign at **${milestone.title}** (sprint ${campaign.currentMilestone + 1}/${campaign.milestones.length}) with a fresh attempt budget.`,
    );
    this.submitCurrentMilestone(campaign);
  }

  /**
   * A campaign stopped by a full provider outage revives itself when the
   * chain recovers. Before this, "failed on quota" meant failed until a
   * person typed "kampanya devam" — measured twice on 2026-08-29 (00:58 and
   * 12:27 quota walls), each costing hours of an operator's attention for
   * what is a scheduled, known-duration wait.
   */
  /**
   * The Cause line of an outage pause.
   *
   * The OUTAGE is the cause. What the run happened to be saying when the wall
   * arrived is context, and labelling it "Cause:" made a parked campaign read
   * as a failed one — measured live 2026-09-04:
   *
   *   ⏸️ Campaign paused by a provider outage at Sprint 7.
   *   Cause: Sprint 7 blocked after 2 attempts: Completed: 1. **Varsayım**: …
   *
   * The sprint had not failed and its attempts had not been spent on work:
   * one account's monthly quota was out for 17 days and the other's for ~4h,
   * and no line said so. When the outage cannot be described (an unreadable
   * registry), the original detail stands rather than an empty accusation.
   */
  private outageCause(detail: string): string {
    const outage = describeProviderOutage();
    if (outage.length === 0) return detail;
    const trimmed = detail.trim();
    return trimmed.length > 0 ? `${outage}.\nWhat the run was doing when it hit: ${trimmed}` : outage;
  }

  /**
   * Re-submit the campaign's current milestone on the next tick.
   *
   * The hop exists so the caller's own settle finishes first. It must survive
   * the process outliving it: audited 2026-09-04, this was a bare
   * `setTimeout(…, 0)` with no unref, no guard and no catch, so a storage
   * closed between the schedule and the fire raised an uncaught "The database
   * connection is not open" — seen as two unhandled errors beside 565 passing
   * campaign tests, which vitest warns can mask false positives.
   */
  private resubmitSoon(campaignId: string): void {
    const timer = setTimeout(() => {
      try {
        if (!this.storage.isOpen()) return;
        const fresh = this.storage.get(campaignId);
        if (!fresh || fresh.state !== "executing") return;
        this.submitCurrentMilestone(fresh);
      } catch (err) {
        getLoggerSafe().warn("Deferred milestone resubmit failed", {
          id: campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 0);
    timer.unref?.();
  }

  private scheduleAutoRevive(campaignId: string, delayMs: number, expectedAt?: number): void {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const fresh = this.storage.get(campaignId);
          if (!fresh || fresh.state !== "failed" || !fresh.autoReviveAt) return;
          // A CANCELLED LINEAGE OUTRANKS THE APPOINTMENT. Cancelling the
          // parked sprint during the pause left the appointment standing —
          // settlement correlation only scans ACTIVE campaigns — and the
          // timer then submitted a child of the task someone had just
          // stopped (Codex 2026-09-11 H#2).
          const parked = fresh.milestones[fresh.currentMilestone];
          // …including a campaign that has no ladder yet: its DRAFT task is
          // the work, and a cancelled draft used to be redrafted (J#8).
          const parkedTaskId = parked?.taskId ?? fresh.draftTaskId;
          if (parkedTaskId && this.lineageWasCancelledOnPurpose(parkedTaskId)) {
            fresh.autoReviveAt = undefined;
            fresh.lastError = `NOT DELIVERED — ${parked?.title ?? "the GDD draft"} was cancelled while its retry was pending`;
            this.persist(fresh);
            getLoggerSafe().info("Campaign self-revival abandoned — its lineage was cancelled on purpose", {
              id: campaignId,
              milestone: parked?.id ?? "draft",
            });
            return;
          }
          // …and the appointment must be THE one this timer was armed for. An
          // older timer used to fire a NEWER appointment early, shortening a
          // backoff someone else had just set (Codex 2026-09-11 H#3). A call
          // with no expectation — "revive now", the boot sweep — still fires.
          if (expectedAt !== undefined && fresh.autoReviveAt !== expectedAt) {
            getLoggerSafe().info("Campaign self-revival timer is stale — a newer appointment stands", {
              id: campaignId,
              armedFor: new Date(expectedAt).toISOString(),
              nowDue: new Date(fresh.autoReviveAt).toISOString(),
            });
            return;
          }
          const stillCooling = allProvidersCoolingDownMs();
          if (stillCooling > 0) {
            // Horizon moved (another quota hit while parked) — follow it.
            fresh.autoReviveAt = Date.now() + stillCooling + 60_000;
            this.persist(fresh);
            this.scheduleAutoRevive(campaignId, stillCooling + 60_000, fresh.autoReviveAt);
            return;
          }
          if (
            this.storage.hasActiveForChat(fresh.chatId) ||
            this.storage.hasActiveForProject(this.projectRoot)
          ) {
            // SOMEONE ELSE HOLDS THE PROJECT — and this appointment is not
            // cancelled by that, it is postponed. Returning left the row with
            // an autoReviveAt nobody would ever fire again: the campaign
            // needed another boot to move (Codex 2026-09-11 J#5).
            const retryInMs = 5 * 60_000;
            fresh.autoReviveAt = Date.now() + retryInMs;
            this.persist(fresh);
            this.scheduleAutoRevive(campaignId, retryInMs, fresh.autoReviveAt);
            getLoggerSafe().info("Campaign self-revival deferred — the project is busy, appointment re-armed", {
              id: campaignId,
              retryInMs,
            });
            return;
          }
          const milestone = fresh.milestones[fresh.currentMilestone];
          if (!milestone) {
            fresh.lastError = undefined;
            fresh.autoReviveAt = undefined;
            if (this.isIdeaModeBeforeGdd(fresh)) {
              // Parked while drafting (idea mode): re-issue the DRAFT. Planning
              // here would adopt an unrelated docs GDD (audited 2026-09-02).
              this.persist(fresh);
              getLoggerSafe().info("Campaign self-revival — redrafting the GDD from the idea", {
                id: fresh.id,
              });
              await this.tell(fresh, "Provider chain recovered — rewriting the GDD from your idea.");
              this.submitDraft(fresh);
              return;
            }
            // Failed before the ladder existed (planning outage): replan from
            // the GDD, as tryHandleRevive does. Returning here silently was
            // how an armed pre-ladder revival no-oped (audited 2026-09-02).
            fresh.state = "planning";
            this.persist(fresh);
            getLoggerSafe().info("Campaign self-revival — provider chain recovered, replanning the ladder", {
              id: fresh.id,
            });
            await this.tell(fresh, "Provider chain recovered — replanning the milestone ladder from the GDD.");
            void this.planAndLaunch(fresh.id);
            return;
          }
          getLoggerSafe().info("Campaign self-revival — provider chain recovered", {
            id: fresh.id,
            milestone: milestone.id,
          });
          await this.reviveAtCurrentMilestone(fresh, milestone);
        } catch (err) {
          getLoggerSafe().warn("Campaign self-revival failed", {
            id: campaignId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, delayMs);
    timer.unref?.();
  }

  /** Boot: re-attach campaigns that were active when the process stopped. */
  async resumeActive(): Promise<void> {
    for (const campaign of this.storage.listActive()) {
      try {
        await this.resumeOne(campaign);
      } catch (err) {
        getLoggerSafe().warn("Campaign resume failed", {
          id: campaign.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // A finished campaign must stop writing to the project. Cancelling on the
    // transition to "done" is not enough: the campaign is already terminal on
    // the next boot, nothing resumes it, and the executor's keep-alive re-arm
    // revives its blocked tasks every restart — measured live 2026-09-03
    // 09:19 and again 09:37, both minutes after delivery, both resubmitting a
    // sprint against a game that had already shipped.
    for (const campaign of this.storage.listRecentTerminal()) {
      // A FAILED campaign can be revived (by its own budget or by a person);
      // a delivered one cannot (Codex 2026-09-11 F#6).
      this.cancelLiveLineages(campaign, `campaign already ${campaign.state}`, { recoverable: campaign.state === "failed" });
    }
    // A delivered game whose report never reached the chat is announced now.
    // The report is rebuilt from the persisted evidence (the same builder the
    // live path uses), and the flag is set only when it actually lands, so a
    // still-broken messenger leaves it queued for the next boot instead of
    // marking a report that nobody received (audited 2026-09-02).
    for (const campaign of this.storage.listUnreportedDeliveries()) {
      getLoggerSafe().warn("Delivery report was never sent — re-sending after restart", {
        id: campaign.id,
        deliveredAt: campaign.updatedAt,
      });
      // A re-send carries the SAME opinion the report was built with; a second
      // reviewer run is a second bill and a possibly different verdict.
      if (campaign.independentReview?.ok !== true) await this.gatherIndependentReview(campaign);
      if (await this.tell(campaign, this.buildDeliveryReport(campaign))) {
        campaign.deliveryReported = true;
        this.persist(campaign);
      }
    }
    // Self-revival appointments are setTimeout-backed and die with the
    // process — re-arm them from the persisted timestamps (overdue ones fire
    // on a short delay so boot recovery settles first).
    for (const campaign of this.storage.listAwaitingAutoRevive()) {
      // The persisted appointment can be stale: measured 2026-09-08 03:12, it
      // read Sep 11 (the next member's horizon, see provider-outage.ts) while
      // the registry said a member was probe-worthy now. The registry's
      // horizon wins when it is sooner; an overdue or moot appointment fires
      // on a short delay so boot recovery settles first.
      const stored = (campaign.autoReviveAt ?? 0) - Date.now();
      const registry = allProvidersCoolingDownMs();
      const horizon = registry > 0 ? Math.min(stored, registry + 60_000) : Math.min(stored, 0);
      const dueInMs = Math.max(horizon, 120_000);
      getLoggerSafe().info("Re-arming campaign self-revival after restart", {
        id: campaign.id,
        dueInMs,
        storedInMs: stored,
        registryInMs: registry,
      });
      this.scheduleAutoRevive(campaign.id, dueInMs, campaign.autoReviveAt);
    }
  }

  private async resumeOne(campaign: Campaign): Promise<void> {
    switch (campaign.state) {
      case "drafting-gdd":
      case "executing": {
        const rootTaskId =
          campaign.state === "drafting-gdd"
            ? campaign.draftTaskId
            : campaign.milestones[campaign.currentMilestone]?.taskId;
        // Follow the retry lineage, not the single id the campaign last saw:
        // retries/resumes mint new task ids with parentId pointing back.
        const task = rootTaskId
          ? this.taskManager.findLatestLineageTask(rootTaskId as TaskId)
          : null;

        if (task && task.status === TaskStatus.paused) {
          // Startup recovery marks interrupted user-origin tasks `paused` —
          // an ACTIVE status nothing would ever resume. Bailing here as
          // "still in flight" wedged the campaign forever; resume it instead.
          //
          // A SPRINT is resubmitted, not replayed. Measured 2026-09-08 04:18:
          // the replay quoted the lineage root's prompt — 29 sprints old, no
          // delivery gate, a stale measurement — while the milestone held the
          // current one. The milestone prompt is the sprint's contract; the
          // resubmission cancels the paused tip and charges no attempt.
          if (campaign.state === "executing") {
            getLoggerSafe().info("Campaign resubmitting the milestone instead of replaying a paused sprint", {
              id: campaign.id,
              milestone: campaign.milestones[campaign.currentMilestone]?.id,
              pausedTask: task.id,
            });
            this.submitCurrentMilestone(campaign, { countAttempt: false });
            return;
          }
          const resumed = this.taskManager.resumeTask(task.id);
          if (resumed) {
            this.adoptTask(campaign, resumed.id);
            getLoggerSafe().info("Campaign resumed paused task after restart", {
              id: campaign.id,
              pausedTask: task.id,
              resumedTask: resumed.id,
            });
            return;
          }
          // fall through to resubmission when resume was refused
        } else if (task && ACTIVE_STATUSES.has(task.status)) {
          this.adoptTask(campaign, task.id);
          return; // genuinely still in flight — track the live id
        } else if (task && task.status === TaskStatus.completed) {
          // Landed while we were down; the settlement event is gone. Judge it.
          // Audited 2026-09-02: this branch was gated on state === "executing",
          // so a completed GDD draft fell through to submitDraft — a whole new
          // draft, no revision note, no attempt charged, gate never opened.
          if (campaign.state === "drafting-gdd") {
            await this.onDraftSettled(campaign, task.status, task.result ?? "");
            return;
          }
          const milestone = campaign.milestones[campaign.currentMilestone];
          if (milestone) {
            await this.onMilestoneOutcome(campaign, milestone, task.status, task.result ?? "", {
              countAttempt: false,
            });
            return;
          }
        } else if (task && campaign.state === "executing" && !ACTIVE_STATUSES.has(task.status)) {
          // A terminal NON-completed tip (failed/blocked/cancelled) found at
          // boot is an outcome, not an interruption. Audited 2026-09-02: it
          // fell through to the resubmission below with countAttempt:false,
          // which never consults the time box — so across repeated restarts a
          // sprint was relaunched forever with attempts frozen. Judge it on
          // the same path a live settle takes: time box, outage exemption
          // (an outage still charges nothing), and otherwise a real attempt.
          const milestone = campaign.milestones[campaign.currentMilestone];
          if (milestone) {
            getLoggerSafe().info("Campaign judging a terminal tip found at boot", {
              id: campaign.id,
              milestone: milestone.id,
              status: task.status,
            });
            await this.onMilestoneOutcome(
              campaign,
              milestone,
              task.status,
              task.error ?? task.result ?? "",
              { countAttempt: true },
            );
            return;
          }
        }

        // The process died mid-task; the settlement events will never come.
        getLoggerSafe().info("Campaign resuming after restart", {
          id: campaign.id,
          state: campaign.state,
        });
        if (campaign.state === "drafting-gdd") {
          this.submitDraft(campaign);
        } else {
          // A restart is not the milestone's fault — do not burn its budget.
          this.submitCurrentMilestone(campaign, { countAttempt: false });
        }
        return;
      }
      case "planning":
        // The ladder is persisted BEFORE the announcement round-trip that
        // precedes the flip to `executing`, so a restart in that window finds
        // planning + a complete ladder. Audited 2026-09-02: it replanned from
        // scratch — a second billable planning pass that can also produce a
        // different ladder from the one already announced. Resume the work
        // item instead; this milestone has never been submitted, so its first
        // attempt is charged exactly as a fresh launch charges it.
        if (this.isIdeaModeBeforeGdd(campaign)) {
          getLoggerSafe().info("Campaign resuming the GDD draft instead of planning", {
            id: campaign.id,
          });
          this.submitDraft(campaign);
          return;
        }
        if (campaign.milestones.length > 0 && campaign.milestones[campaign.currentMilestone]) {
          getLoggerSafe().info("Campaign resuming a persisted ladder instead of replanning", {
            id: campaign.id,
            milestones: campaign.milestones.length,
            currentMilestone: campaign.currentMilestone,
          });
          this.submitCurrentMilestone(campaign);
          return;
        }
        void this.planAndLaunch(campaign.id);
        return;
      case "awaiting-approval":
        // Passive by design: the designer's next message re-enters via
        // tryHandleApproval. A boot-time nudge would re-spam every restart.
        return;
      default:
        return;
    }
  }

  // ===========================================================================
  // INTERNAL — transitions
  // ===========================================================================

  /**
   * Idea mode with no design document yet: the work to resume is the DRAFT,
   * not planning. Audited 2026-09-02 — every pre-ladder resume (restart,
   * "kampanya devam", outage self-revival) funnelled into planAndLaunch,
   * which adopts the NEWEST docs/*GDD*.md by mtime. On a repo that already
   * holds another game's GDD that plans a ladder for the wrong game and drops
   * the idea silently.
   */
  private isIdeaModeBeforeGdd(campaign: Campaign): boolean {
    return !!campaign.ideaText && !campaign.gddPath && !campaign.gddText;
  }

  private newCampaign(
    ctx: CampaignContext,
    seed: { ideaText?: string; gddText?: string; gddPath?: string },
  ): Campaign {
    const now = Date.now();
    const campaign: Campaign = {
      id: generateCampaignId(),
      chatId: ctx.chatId,
      channelType: ctx.channelType,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectRoot: this.projectRoot,
      state: "planning",
      draftAttempts: 0,
      milestones: [],
      currentMilestone: 0,
      createdAt: now,
      updatedAt: now,
      ...seed,
    };
    // Persist at birth: planAndLaunch re-reads from storage, so an
    // unpersisted campaign would silently no-op its own launch.
    this.persist(campaign);
    return campaign;
  }

  private submitDraft(campaign: Campaign, revisionNote?: string): void {
    campaign.state = "drafting-gdd";
    // A new draft attempt gets a new deferral clock, as a new milestone
    // attempt does (audited 2026-09-02) — otherwise the next reap inherits a
    // spent bound and is judged instead of deferred.
    campaign.draftDeferredSince = undefined;
    const task = this.taskManager.submit(
      campaign.chatId,
      campaign.channelType,
      GDD_DRAFT_PROMPT(campaign.ideaText ?? "", revisionNote),
      { userId: campaign.userId, conversationId: campaign.conversationId },
    );
    campaign.draftTaskId = task.id;
    this.persist(campaign);
  }

  private async planAndLaunch(campaignId: string): Promise<void> {
    const campaign = this.storage.get(campaignId);
    if (!campaign) return;
    campaign.state = "planning";
    if (!campaign.gddPath) {
      campaign.gddPath = this.findNewestGddPath();
    }
    this.persist(campaign);

    try {
      const gddPath = campaign.gddPath ?? "docs/GDD.md";
      const textForPlanning = campaign.gddText ?? readGddFile(this.projectRoot, gddPath);
      if (!textForPlanning) {
        throw new Error(`GDD not readable at ${gddPath} — cannot plan the ladder`);
      }
      campaign.gddPath = gddPath;
      // Every sprint prompt references the GDD by this path instead of
      // restating it — a dangling pointer means agents building with no
      // design at all. Audited 2026-08-29: the fallback path was handed out
      // with no existence check. Materialize the text we planned from.
      try {
        const absGdd = join(this.projectRoot, gddPath);
        if (!existsSync(absGdd) && campaign.gddText) {
          mkdirSync(join(this.projectRoot, "docs"), { recursive: true });
          writeFileSync(absGdd, campaign.gddText, "utf8");
          getLoggerSafe().warn("GDD file was missing at its referenced path — materialized from campaign text", {
            id: campaign.id,
            gddPath,
          });
        }
      } catch { /* best-effort; planning proceeds on in-memory text */ }

      // Derive the game's style from its own GDD (post-approval — the design
      // is confirmed, so the profile now means something). Never a universal
      // preset; a failed analysis degrades to tool defaults, not a failed plan.
      let styleSummary = "";
      if (this.styleAnalysis) {
        try {
          const { saveStyleProfile } = await import("../agents/style/style-profile.js");
          const { profile, source } = await this.styleAnalysis.analyze(textForPlanning);
          saveStyleProfile(this.projectRoot, profile);
          styleSummary =
            `\nStyle (${source === "llm" ? "GDD-derived" : "keyword-derived, review it"}): ` +
            `${profile.family} / ${profile.pipeline}, palette ${profile.palette.slice(0, 4).join(" ")}` +
            `${profile.outline.width > 0 ? `, outline ×${profile.outline.width}` : ", no outline"}` +
            ` — stored at style.json.`;
        } catch (err) {
          getLoggerSafe().warn("Style analysis failed at plan time — tools will use stock defaults", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const ladder = await this.planner.planMilestones(
        textForPlanning,
        gddPath,
        styleSummary.trim() || undefined,
      );
      campaign.milestones = ladder.milestones.map((m, i) => ({
        id: `m${i + 1}`,
        title: m.title,
        prompt: m.prompt,
        status: "pending",
        attempts: 0,
        ...(m.coveredSections?.length ? { coveredSections: m.coveredSections } : {}),
        ...(m.deliverables?.length ? { deliverables: m.deliverables } : {}),
        // Read the PLANNER's wording, once, before anything is appended.
        visualGateArmed: /captur/i.test(m.prompt),
      }));
      // The plan against the GDD's measured section inventory: recorded on
      // the campaign, said to the chat, shown by /campaign. Never silent.
      const uncoveredPlan = ladder.uncoveredSections ?? [];
      campaign.planCoverage = {
        covered: (ladder.totalSections ?? 0) - uncoveredPlan.length,
        total: ladder.totalSections ?? 0,
        uncovered: uncoveredPlan.slice(0, 40),
        excluded: (ladder.excluded ?? []).slice(0, 30),
        minMilestones: ladder.minMilestones ?? campaign.milestones.length,
        maxMilestones: ladder.maxMilestones ?? campaign.milestones.length,
      };
      if (uncoveredPlan.length > 0) {
        getLoggerSafe().warn("Campaign plan leaves GDD sections unclaimed", {
          id: campaign.id,
          uncovered: uncoveredPlan.slice(0, 20),
          total: ladder.totalSections ?? 0,
        });
      }
      // The planner is told to demand a captured frame of every sprint; the
      // visual gate keys on that wording. Name the sprints where it did not,
      // so a gate that will never run is visible before the ladder starts.
      const ungated = campaign.milestones.filter((m) => m.visualGateArmed !== true).map((m) => m.id);
      if (ungated.length > 0) {
        getLoggerSafe().warn("Planner omitted the captured-frame demand — visual gate will not run for these sprints", {
          id: campaign.id,
          milestones: ungated,
        });
      }
      campaign.currentMilestone = 0;
      this.persist(campaign);

      const coverage = campaign.planCoverage;
      const coverageLine = coverage
        ? `\nPlan covers ${coverage.covered}/${coverage.total} GDD sections (ladder sized ${coverage.minMilestones}–${coverage.maxMilestones} from the measured scope)` +
          (coverage.uncovered.length > 0 ? `; UNPLANNED: ${coverage.uncovered.slice(0, 8).join(", ")}${coverage.uncovered.length > 8 ? ", …" : ""}` : "") +
          (coverage.excluded.length > 0 ? `; excluded by the GDD: ${coverage.excluded.slice(0, 4).join("; ")}` : "") +
          "."
        : "";
      await this.tell(
        campaign,
        `Milestone ladder ready (${campaign.milestones.length} sprints):\n${campaign.milestones
          .map((m) => `• ${m.title}${m.coveredSections?.length ? ` — ${m.coveredSections.slice(0, 4).join(", ")}${m.coveredSections.length > 4 ? ", …" : ""}` : ""}`)
          .join("\n")}${styleSummary}${coverageLine}\n\nSprint 1 starts now.`,
      );
      this.submitCurrentMilestone(campaign);
    } catch (err) {
      campaign.state = "failed";
      campaign.lastError = err instanceof Error ? err.message : String(err);
      // A planning failure caused by a full provider outage is a scheduled
      // wait, not a defeat — park with a self-revival appointment exactly as
      // the milestone terminal path does. Audited 2026-09-02: this catch
      // armed nothing, so a quota wall hit before the ladder existed left the
      // campaign dead until a human typed "kampanya devam" (and that revive
      // re-entered the same unarmed catch while the wall persisted). The
      // planner's contract explicitly promised the caller would park.
      const outageWaitMs = allProvidersCoolingDownMs();
      // Arm ONLY on a measured outage. Arming on the error's wording alone
      // (review of 6d520d19, 2026-09-02) made a 'quota' message with a chain
      // that reads available replan every two minutes with no attempt budget
      // — planning has none — so the loop was unbounded.
      if (outageWaitMs > 0) {
        const delayMs = Math.max(outageWaitMs, 60_000) + 60_000;
        campaign.autoReviveAt = Date.now() + delayMs;
        this.persist(campaign);
        this.scheduleAutoRevive(campaign.id, delayMs, campaign.autoReviveAt);
        await this.tell(
          campaign,
          `⏸️ Campaign paused by a provider outage before the milestone ladder could be planned.\n` +
            `Cause: ${this.outageCause(campaign.lastError ?? "")}\n` +
            `Self-revival armed for ${new Date(campaign.autoReviveAt).toLocaleTimeString()} (when the provider chain recovers). Reply **kampanya devam** to revive sooner.`,
        );
        return;
      }
      this.persist(campaign);
      await this.tell(
        campaign,
        `Campaign could not plan the milestone ladder: ${campaign.lastError}\nReply **kampanya devam** to replan from the GDD.`,
      );
    }
  }

  /** Re-point the current work item at the lineage's live task id. */
  private adoptTask(campaign: Campaign, taskId: string): void {
    if (campaign.state === "drafting-gdd") {
      if (campaign.draftTaskId === taskId) return;
      campaign.draftTaskId = taskId;
    } else {
      const milestone = campaign.milestones[campaign.currentMilestone];
      if (!milestone || milestone.taskId === taskId) return;
      milestone.taskId = taskId;
      // A retry is a new attempt at proof: the freshness clock moves with it,
      // or evidence from the abandoned attempt stays eligible (Codex 2026-09-11 C#9).
      milestone.attemptStartedAtMs = Date.now();
    }
    this.persist(campaign);
  }

  private submitCurrentMilestone(campaign: Campaign, opts?: { countAttempt?: boolean }): void {
    const milestone = campaign.milestones[campaign.currentMilestone];
    if (!milestone) {
      // NEVER a silent delivery. A missing milestone here means the ladder is
      // empty or the index ran past its end — a corrupt milestones_json (the
      // storage parser degrades to []) or a bad resume, not a finished game.
      // Flipping to "done" here made a live 7-sprint campaign vanish with no
      // message, no report and no revival path (audited 2026-09-01).
      campaign.state = "failed";
      campaign.lastError =
        `Ladder is unusable: milestone index ${campaign.currentMilestone} of ${campaign.milestones.length}. ` +
        "The plan may have been lost or corrupted; reply **kampanya devam** to replan from the GDD.";
      this.persist(campaign);
      getLoggerSafe().error("Campaign ladder unusable — refusing to declare delivery", {
        id: campaign.id,
        currentMilestone: campaign.currentMilestone,
        milestones: campaign.milestones.length,
      });
      void this.tell(campaign, `❌ Campaign halted: ${campaign.lastError}`);
      return;
    }
    // THE PREVIOUS LINEAGE IS ABANDONED, SO STOP IT. Every resubmit path
    // (revive, bounce, gate refusal, outage, escalation) points the milestone
    // at a NEW task and forgets the old one, whose keep-alive keeps reviving
    // it — and once the campaign no longer references that lineage, nothing
    // can find it to cancel. Measured live 2026-09-03: lineage task_3f52a987
    // was abandoned by a resubmit, then resurrected at 09:19, 09:37, 09:53 and
    // 10:20 — four times after the campaign had delivered, each able to write
    // to the project the user was inspecting.
    if (milestone.taskId) {
      try {
        const previousTip = this.taskManager.findLatestLineageTask(milestone.taskId as TaskId);
        const previousId = (previousTip as { id?: string; status?: string } | null)?.id;
        const previousStatus = (previousTip as { status?: string } | null)?.status;
        if (previousId && previousStatus !== "completed" && previousStatus !== "cancelled") {
          // "superseded": the next attempt is this task's child, and the
          // executor's keep-alive must not read this cancel as a stop order.
          this.taskManager.cancel(previousId as TaskId, { reason: "superseded" });
          getLoggerSafe().info("Cancelled the milestone's previous lineage before resubmitting", {
            id: campaign.id,
            milestone: milestone.id,
            taskId: previousId,
          });
        }
      } catch { /* already settled */ }
    }
    // A remediation sprint is judged on what it changes, so record what it
    // starts from. First submission only: a bounce must be measured against
    // the same baseline, not against its own failed attempt.
    if (milestone.id.startsWith("mcov") && milestone.placeholderArtAtStart === undefined) {
      const art = this.measurePlaceholderArt(campaign);
      if (art) milestone.placeholderArtAtStart = art;
    }
    // THE FINAL SPRINT OWNS BUILD HYGIENE. The planner is told this too, but
    // a planner instruction is a suggestion an LLM may drop; this append is
    // deterministic, so the sprint that delivers ALWAYS carries the
    // requirement. Measured 2026-09-03: the delivered tree left 14 scenes
    // enabled in Build Settings and the report named none of them.
    if (campaign.currentMilestone === campaign.milestones.length - 1) {
      // The CURRENT wording, not the first one persisted. Measured 2026-09-08
      // 06:00: a campaign planned before the "disable, do not delete" change
      // kept its original paragraph on every resubmission because the append
      // was gated on the heading alone.
      // Any BUILD HYGIENE paragraph — the planner writes one of its own
      // ("BUILD HYGIENE: …", campaign-planner.ts) and it carried the old
      // "deleted or disabled" wording too (review 2026-09-08).
      milestone.prompt = milestone.prompt
        .replace(/\n\nBUILD HYGIENE\b[^\n]*(?:\n(?!\n)[^\n]*)*/g, "")
        // The planner's heading can also sit mid-list ("- BUILD HYGIENE: …");
        // a paragraph regex misses it and `includes` then kept the old
        // wording out of the current instruction (Codex review 2026-09-08).
        .replace(/^[^\n]*\bBUILD HYGIENE\b[^\n]*\n?/gm, "");
      if (!milestone.prompt.includes("BUILD HYGIENE (final sprint):")) {
        milestone.prompt +=
          "\n\nBUILD HYGIENE (final sprint): when you are done, the FIRST enabled scene in Build Settings " +
          "must be the entry scene a person opens to play the game, and every scene enabled after it must be " +
          "one the game itself loads (menu, levels, results). Every verification or scaffolding scene " +
          "(InitTestScene*, *Verification, *Verified, *SmokeTest*, Sandbox*) must be DISABLED in Build " +
          "Settings. Do NOT delete scene files that existed before this sprint: " +
          "the write-back carries only deletions of files the system itself wrote, so deleting a " +
          "pre-existing scene costs a turn and changes nothing (measured 2026-09-08: twelve such deletes, " +
          "none applied). Your report must name the entry scene and list every scene you disabled.";
      }
      // THE FINAL SPRINT PLAYS THE GAME. Measured 2026-09-10: the campaign
      // delivered green on compile + tests + art counts while the entry scene
      // idled after boot — nothing at runtime starts a level — and no sprint
      // had ever driven Home → level → win/fail. The delivery gate reads the
      // verdict unity_playthrough leaves; this tells the sprint to earn it.
      // Worded without "capture": the visual-evidence gate's legacy fallback
      // scans the live prompt for that word, and a deterministic append must
      // not arm a gate the planner never asked for.
      if (!milestone.prompt.includes("PLAY-THROUGH (final sprint):")) {
        milestone.prompt +=
          "\n\nPLAY-THROUGH (final sprint): the game must register ONE Strada.Core.Play.IPlaythroughDriver " +
          "in its service container — an adapter over its own flow, level and input services (Phase, " +
          "IsSessionActive, Outcome, StartSession(index), Act()). Before you report, run unity_playthrough: " +
          "it boots the entry scene, resolves that driver, starts a session, acts until the session ends, " +
          "records checkpoint frames and judges them. Delivery requires its verdict to be ok — fix what it " +
          "names (no driver registered, a session that never ends, a screen that never changes, a driver " +
          "that refuses to start). Register a Strada.Core.Play.ISessionCatalog as well (SessionCount = how many " +
          "levels/rounds StartSession accepts) and run unity_playthrough with sessions: \"all\" so every level is " +
          "played to an outcome and the GDD's level count is measured against what is shipped. " +
          "It also reports whether the game starts play BY ITSELF after boot; if " +
          "it does not, wire the GDD's entry flow so a person who opens the entry scene is playing, not " +
          "staring at an idle screen. Then run unity_build_player for the GDD's platform (or the project's " +
          "active target): a delivery is a runnable artifact, and its measured path and size belong in your report. " +
          "Then run unity_run_player on that artifact: it plays the game inside the built player and measures the " +
          "real frame rate — the number the GDD's frame-rate target means.";
      }
      this.attachStructureMeasurement(campaign, milestone);
    }
    // NO PROVIDER, NO TASK. Measured 2026-09-08 01:08: a boot resubmitted the
    // milestone while every provider was cooling; the task seeded a 2000-file
    // lease and blocked 38 s later on "All providers are in cooldown". The
    // executor's keep-alive already waits out the horizon; the campaign's own
    // submits (boot, bounce, revive) now park the same way instead.
    const outageWaitMs = allProvidersCoolingDownMs();
    if (outageWaitMs > 0) {
      const delayMs = outageWaitMs + 60_000;
      milestone.status = "pending";
      campaign.state = "failed";
      campaign.lastError = `${milestone.title} not started: every provider is in cooldown (${describeProviderOutage()})`;
      campaign.autoReviveAt = Date.now() + delayMs;
      this.persist(campaign);
      this.scheduleAutoRevive(campaign.id, delayMs, campaign.autoReviveAt);
      getLoggerSafe().info("Campaign milestone parked — every provider is cooling down, nothing submitted", {
        id: campaign.id,
        milestone: milestone.id,
        reviveInMs: delayMs,
      });
      void this.tell(
        campaign,
        `⏸️ Campaign paused before starting **${milestone.title}**: every provider is in cooldown.\n` +
          `Cause: ${this.outageCause(campaign.lastError ?? "")}\n` +
          `Self-revival armed for ${new Date(campaign.autoReviveAt).toLocaleTimeString()}. Reply **kampanya devam** to try sooner.`,
      );
      return;
    }
    milestone.status = "running";
    milestone.startedAtMs ??= Date.now();
    // Every submit is a new attempt at proof, so the freshness clock moves
    // even when the milestone clock does not (Codex 2026-09-11 B#4).
    milestone.attemptStartedAtMs = Date.now();
    // A new attempt gets a new deferral clock. Audited 2026-09-02: the clock
    // was cleared only on the judge path, so revive/bounce/escalation/restart
    // attempts inherited a stale one — past 24h the deferral was skipped and
    // the fresh attempt's first keep-alive reap (whose text promises the
    // executor's own retry) was charged and resubmitted on top of it.
    milestone.reconcileDeferredSince = undefined;
    if (opts?.countAttempt !== false) {
      milestone.attempts += 1;
    }
    campaign.state = "executing";
    // Attempt N+1 must know what attempt N ACHIEVED, not only how it died.
    // Audited 2026-08-29: the resubmit carried only the milestone prompt plus
    // a 400-char failure tail — files written, sub-goals done and commits made
    // were all invisible, so every retry re-derived the sprint from scratch.
    // parentId makes the retry a real lineage descendant (adoption, lineage
    // queries and checkpoint lookup all key on it); the progress block is
    // appended to the SUBMITTED prompt only, never persisted into
    // milestone.prompt, so it cannot accumulate.
    const prevTaskId = milestone.taskId as TaskId | undefined;
    const priorProgress = prevTaskId ? this.taskManager.priorProgressSummary?.(prevTaskId) ?? "" : "";
    const task = this.taskManager.submit(
      campaign.chatId,
      campaign.channelType,
      priorProgress ? `${milestone.prompt}${priorProgress}` : milestone.prompt,
      {
        userId: campaign.userId,
        conversationId: campaign.conversationId,
        // A NEW GENERATION after a deliberate stop: linking the new attempt to
        // a lineage someone cancelled makes it inherit that stop for ever, so
        // the revival that a person just asked for abandons its own recovery
        // (Codex 2026-09-11 J#7). The prior work stands in the repo; only the
        // task chain starts again.
        ...(prevTaskId && !this.lineageWasCancelledOnPurpose(prevTaskId) ? { parentId: prevTaskId } : {}),
      },
    );
    milestone.taskId = task.id;
    this.persist(campaign);
    getLoggerSafe().info("Campaign milestone submitted", {
      id: campaign.id,
      milestone: milestone.id,
      title: milestone.title,
      attempt: milestone.attempts,
    });
  }

  /** Per-campaign settlement serialization — see handleTaskSettled. */
  private readonly settleChains = new Map<string, Promise<void>>();

  private enqueueSettle(campaignId: string, fn: () => Promise<void>): void {
    const prev = this.settleChains.get(campaignId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err: unknown) => {
      getLoggerSafe().warn("Campaign settlement handler failed", {
        id: campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.settleChains.set(campaignId, next);
  }

  private async handleTaskSettled(taskId: string, status: TaskStatus, output: string): Promise<void> {
    // Correlate by scanning active campaigns — the active set is tiny
    // (typically one), so this stays cheap. Correlation is by task LINEAGE,
    // not a single id: every retry/resume path mints a new task id with
    // parentId pointing back, and matching only the original id meant the
    // real continuation proceeded untracked while the campaign judged a
    // stale ancestor.
    //
    // Handlers are SERIALIZED per campaign and re-validate against fresh
    // storage when they actually run: the milestone commit awaits a write
    // lock, so two settlement events processed concurrently could both read
    // the same currentMilestone and advance the ladder twice.
    for (const campaign of this.storage.listActive()) {
      if (
        campaign.state === "drafting-gdd" &&
        campaign.draftTaskId &&
        this.taskManager.isInLineage(campaign.draftTaskId as TaskId, taskId as TaskId)
      ) {
        this.enqueueSettle(campaign.id, async () => {
          const fresh = this.storage.get(campaign.id);
          if (
            !fresh ||
            fresh.state !== "drafting-gdd" ||
            !fresh.draftTaskId ||
            !this.taskManager.isInLineage(fresh.draftTaskId as TaskId, taskId as TaskId)
          ) {
            return; // already handled or moved on
          }
          await this.onDraftSettled(fresh, status, output);
        });
        return;
      }
      if (campaign.state === "executing") {
        const milestone = campaign.milestones[campaign.currentMilestone];
        if (
          milestone?.taskId &&
          this.taskManager.isInLineage(milestone.taskId as TaskId, taskId as TaskId)
        ) {
          this.enqueueSettle(campaign.id, async () => {
            const fresh = this.storage.get(campaign.id);
            if (!fresh || fresh.state !== "executing") return;
            const freshMilestone = fresh.milestones[fresh.currentMilestone];
            if (
              !freshMilestone?.taskId ||
              !this.taskManager.isInLineage(freshMilestone.taskId as TaskId, taskId as TaskId)
            ) {
              return; // the ladder already advanced past this settlement
            }
            await this.onMilestoneSettled(fresh, freshMilestone, status, output);
          });
          return;
        }
      }
    }
  }

  private async onDraftSettled(campaign: Campaign, status: TaskStatus, output: string): Promise<void> {
    if (status === TaskStatus.completed) {
      // The executor commits the task's lease back to the project root AFTER
      // complete() — order the docs/ scan behind that write-back, as the
      // milestone path does, or a correctly written GDD is not there yet.
      if (this.completedSettleDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.completedSettleDelayMs));
      }
      const gddPath = this.findNewestGddPath();
      if (!gddPath) {
        // The draft "completed" without producing the document — redo it with
        // the gap named, instead of gating on air. This round is CHARGED:
        // audited 2026-09-02, this branch never touched draftAttempts, so a
        // draft that kept landing off-pattern spun full LLM tasks forever with
        // no message, no failure and the project slot wedged unrevivably.
        const gap =
          "no *GDD*.md was found under docs/ (searched recursively)";
        if (campaign.draftAttempts >= this.maxDraftAttempts) {
          campaign.state = "failed";
          campaign.lastError = `GDD draft completed ${campaign.draftAttempts + 1} times but ${gap}`;
          this.persist(campaign);
          await this.tell(
            campaign,
            `GDD drafting failed — ${campaign.lastError}. Share the document, or reply **kampanya devam** to try again.`,
          );
          return;
        }
        campaign.draftAttempts += 1;
        this.submitDraft(
          campaign,
          `The previous draft never wrote the GDD file under docs/ — ${gap}. Write the file this time, as docs/<GameName>_GDD.md.`,
        );
        return;
      }
      campaign.gddPath = gddPath;
      campaign.state = "awaiting-approval";
      this.persist(campaign);
      await this.tell(
        campaign,
        `GDD drafted at \`${gddPath}\`. Review it — reply **evet/onay** to start the build, or write what to change (revision ${campaign.draftAttempts + 1} of max ${this.maxDraftAttempts}).`,
      );
      return;
    }
    // A block/failure may be the executor's own keep-alive parking the task
    // while it schedules a retry under a new id. Audited 2026-09-02: this
    // branch reacted instantly — draftAttempts += 1 and a second, lineage-less
    // draft task — so one transient blip spent a designer revision round and
    // ran two drafters against docs/ at once; four blips failed the campaign
    // before a real draft was attempted. Same grace-window reconcile as the
    // milestone path, on the settle chain.
    const campaignId = campaign.id;
    const timer = setTimeout(() => {
      this.enqueueSettle(campaignId, () => this.reconcileDraftAfterSettle(campaignId, status, output));
    }, this.retryAdoptionGraceMs);
    timer.unref?.();
  }

  /** Draft-lineage counterpart of reconcileMilestoneAfterSettle. */
  private async reconcileDraftAfterSettle(
    campaignId: string,
    settledStatus: TaskStatus,
    settledOutput: string,
  ): Promise<void> {
    const campaign = this.storage.get(campaignId);
    if (!campaign || campaign.state !== "drafting-gdd" || !campaign.draftTaskId) return;
    const tip = this.taskManager.findLatestLineageTask(campaign.draftTaskId as TaskId);

    if (tip && ACTIVE_STATUSES.has(tip.status) && tip.status !== TaskStatus.paused) {
      this.adoptTask(campaign, tip.id);
      getLoggerSafe().info("Campaign adopted executor retry of the GDD draft instead of redrafting", {
        id: campaign.id,
        adoptedTask: tip.id,
      });
      return;
    }
    if (tip && tip.status === TaskStatus.paused) {
      const resumed = this.taskManager.resumeTask(tip.id);
      if (resumed) {
        this.adoptTask(campaign, resumed.id);
        return;
      }
    }
    if (tip && tip.status === TaskStatus.completed) {
      await this.onDraftSettled(campaign, tip.status, tip.result ?? "");
      return;
    }

    const status = tip && tip.id !== campaign.draftTaskId ? tip.status : settledStatus;
    const output = tip && tip.id !== campaign.draftTaskId ? (tip.error ?? tip.result ?? "") : settledOutput;

    // A reaped/auto-retry tip names a retry the executor WILL mint; wait one
    // promised horizon (trust-but-verify, as the milestone path does) before
    // judging, so the campaign does not redraft on top of the coming retry.
    // Provider wording alone is not a promise. Measured 2026-09-07 07:51: a
    // task ended "blocked" by loop detection with "provider_unavailable" in
    // one sub-goal's note while every provider was healthy; nothing was going
    // to retry it, and the campaign waited 22 minutes for a ghost before
    // judging. The words defer only while the chain is actually cooling.
    const namesRetry = /Reaped:|Auto-retry \d+\/\d+/i.test(output);
    const providerWording = /provider_unavailable|All providers (failed|are in cooldown)/i.test(output);
    const executorWillRetry = namesRetry || (providerWording && allProvidersCoolingDownMs() > 0);
    if (executorWillRetry) {
      const promised = /Auto-retry \d+\/\d+ in ~(\d+)s/.exec(output);
      const promisedMs = (promised ? Number(promised[1]) : 600) * 1000;
      const tipUpdatedAt = (tip as { updatedAt?: number } | null)?.updatedAt;
      const promiseDead =
        tipUpdatedAt !== undefined && Date.now() > tipUpdatedAt + promisedMs + 5 * 60_000;
      // Deferral is TIME-BOUNDED here exactly as on the milestone path
      // (reconcileDeferredSince). Audited 2026-09-02: this path had no clock,
      // so a tip whose updatedAt kept refreshing never read "dead" and the
      // draft re-deferred every horizon forever — no draft, no failure, no
      // message, and the one-campaign-per-project slot held.
      const deferSince = campaign.draftDeferredSince ?? Date.now();
      const boundSpent = Date.now() - deferSince >= 24 * 60 * 60_000;
      if (boundSpent) {
        getLoggerSafe().warn("GDD draft deferral passed its 24h bound — judging the outcome", {
          id: campaign.id,
          deferredForMs: Date.now() - deferSince,
        });
      }
      if (!promiseDead && !boundSpent) {
        const waitMs = Math.min(Math.max(promisedMs + 60_000, 60_000), 12 * 60 * 60_000);
        campaign.draftDeferredSince = deferSince;
        this.persist(campaign);
        getLoggerSafe().info("Campaign deferring GDD draft judgement to the executor's pending retry", {
          id: campaign.id,
          recheckInMs: waitMs,
        });
        const timer = setTimeout(() => {
          this.enqueueSettle(campaign.id, () => this.reconcileDraftAfterSettle(campaign.id, status, output));
        }, waitMs);
        timer.unref?.();
        return;
      }
    }
    campaign.draftDeferredSince = undefined;

    // A measured full outage is a scheduled wait, not a draft failure: park
    // with a self-revival appointment at the chain's recovery horizon, as the
    // planning and milestone paths do. Audited 2026-09-02: this path answered
    // the same wall by resubmitting the draft uncharged, so a fresh LLM task
    // was issued into a chain with no available member every ~11 minutes (the
    // deferral re-check horizon) with no park and no appointment.
    const outageWaitMs = allProvidersCoolingDownMs();
    if (/provider|cooldown|quota|rate.?limit/i.test(output) && outageWaitMs > 0) {
      const delayMs = Math.max(outageWaitMs, 60_000) + 60_000;
      campaign.state = "failed";
      campaign.lastError = `GDD draft ${status} during a full provider outage: ${output.slice(0, 200)}`;
      campaign.autoReviveAt = Date.now() + delayMs;
      this.persist(campaign);
      this.scheduleAutoRevive(campaign.id, delayMs, campaign.autoReviveAt);
      getLoggerSafe().info("GDD draft parked by a provider outage — no revision round charged", {
        id: campaign.id,
        reviveInMs: delayMs,
      });
      await this.tell(
        campaign,
        `⏸️ Campaign paused by a provider outage while drafting the GDD.\n` +
          `Cause: ${this.outageCause(campaign.lastError ?? "")}\n` +
          `Self-revival armed for ${new Date(campaign.autoReviveAt).toLocaleTimeString()} (when the provider chain recovers). Reply **kampanya devam** to revive sooner.`,
      );
      return;
    }

    if (campaign.draftAttempts >= this.maxDraftAttempts) {
      campaign.state = "failed";
      campaign.lastError = `GDD draft ${status}: ${output.slice(0, 200)}`;
      this.persist(campaign);
      await this.tell(campaign, `GDD drafting ${status} — campaign failed. Cause: ${campaign.lastError}`);
      return;
    }
    // An outage-caused settle never reaches here — it parked above with a
    // self-revival appointment, charging no revision round (the same counter
    // the designer's feedback spends). What is left is the draft's own
    // failure, and that does spend a round.
    campaign.draftAttempts += 1;
    this.submitDraft(campaign, `The previous draft attempt ${status}: ${output.slice(0, 400)}`);
  }

  private async onMilestoneSettled(
    campaign: Campaign,
    milestone: CampaignMilestone,
    status: TaskStatus,
    output: string,
  ): Promise<void> {
    if (status === TaskStatus.completed) {
      // The executor commits the task's lease back to the project root in a
      // finally that runs AFTER complete() — audited 2026-08-29: this handler
      // could scan for capture evidence and cut the envelope commit against a
      // project root the sprint's files had not reached yet. A short delay
      // orders us behind the write-back (both sides also serialize on the
      // project write lock).
      if (this.completedSettleDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.completedSettleDelayMs));
      }
      await this.onMilestoneOutcome(campaign, milestone, status, output, { countAttempt: true });
      return;
    }

    // A block/failure may be the executor's own keep-alive parking the task
    // while it schedules a retry under a new id. React after a grace window,
    // against whatever the lineage says by then — not against this snapshot.
    const campaignId = campaign.id;
    const milestoneId = milestone.id;
    this.scheduleReconcile(campaignId, milestoneId, status, output, this.retryAdoptionGraceMs);
  }

  /**
   * Reconcile runs INSIDE the per-campaign settle chain, never from a bare
   * timer. Audited 2026-09-02: the outcome decision was made from an
   * un-serialized setTimeout, so two settle emissions for one task (the
   * task manager has no terminal guard; appendTaskNotice re-emits
   * task:blocked) scheduled two reconciles that both judged the same
   * milestone whenever the outcome path crossed a real async boundary
   * (commit lock, time-box tell, the minutes-long coverage audit) — a second
   * billable audit, a second delivery report, or a second sprint submitted
   * against the same repo. The chain re-reads storage when it actually
   * runs, so the second entrant sees the advanced ladder and no-ops.
   */
  private scheduleReconcile(
    campaignId: string,
    milestoneId: string,
    status: TaskStatus,
    output: string,
    delayMs: number,
  ): void {
    const timer = setTimeout(() => {
      this.enqueueSettle(campaignId, () =>
        this.reconcileMilestoneAfterSettle(campaignId, milestoneId, status, output),
      );
    }, delayMs);
    timer.unref?.();
  }

  /**
   * Grace-window follow-up to a non-completed settlement: re-read the task
   * lineage and act on its CURRENT tip. A newer active task means the
   * executor already retried — adopt it and burn nothing. A newer terminal
   * task is judged on its own outcome. Only when the lineage truly ended
   * badly does the campaign spend an attempt of its own.
   */
  private async reconcileMilestoneAfterSettle(
    campaignId: string,
    milestoneId: string,
    settledStatus: TaskStatus,
    settledOutput: string,
  ): Promise<void> {
    const campaign = this.storage.get(campaignId);
    if (!campaign || campaign.state !== "executing") return;
    const milestone = campaign.milestones[campaign.currentMilestone];
    if (!milestone || milestone.id !== milestoneId) return; // ladder moved on

    const tip = milestone.taskId
      ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)
      : null;

    // A STOP ORDER ANYWHERE IN THE LINEAGE outranks every continuation: a
    // deliberately cancelled task under a newer live child was adopted right
    // past it (Codex 2026-09-11 J#2).
    if (milestone.taskId && this.lineageWasCancelledOnPurpose(milestone.taskId)) {
      milestone.status = "failed";
      campaign.state = "failed";
      campaign.autoReviveAt = undefined;
      campaign.lastError = `NOT DELIVERED — ${milestone.title} was cancelled`;
      this.persist(campaign);
      this.cancelLiveLineages(campaign, "a sprint of this campaign was cancelled");
      getLoggerSafe().info("Campaign stopped: a task in its lineage was cancelled on purpose", {
        id: campaign.id,
        milestone: milestone.id,
      });
      await this.tell(
        campaign,
        `🛑 **${milestone.title}** was cancelled, so the campaign stops here. Reply **kampanya devam** to start it again.`,
      );
      return;
    }

    if (tip && ACTIVE_STATUSES.has(tip.status) && tip.status !== TaskStatus.paused) {
      // The box binds the adoption path too: adopting forever is precisely
      // how a sprint spends a day without an outcome.
      if (await this.escalateIfPastTimeBox(campaign, milestone)) return;
      this.adoptTask(campaign, tip.id);
      getLoggerSafe().info("Campaign adopted executor retry instead of resubmitting", {
        id: campaign.id,
        milestone: milestone.id,
        adoptedTask: tip.id,
      });
      return;
    }
    if (tip && tip.status === TaskStatus.paused) {
      const resumed = this.taskManager.resumeTask(tip.id);
      if (resumed) {
        this.adoptTask(campaign, resumed.id);
        return;
      }
    }
    if (tip && tip.status === TaskStatus.completed) {
      await this.onMilestoneOutcome(campaign, milestone, tip.status, tip.result ?? "", {
        countAttempt: true,
      });
      return;
    }

    const status = tip && tip.id !== milestone.taskId ? tip.status : settledStatus;
    const output = tip && tip.id !== milestone.taskId ? (tip.error ?? tip.result ?? "") : settledOutput;

    // A DELIBERATE CANCELLATION IS A STOP ORDER, and it is read BEFORE the
    // retry, time-box and gap-advance branches. It used to fall through them:
    // cancelling a gap sprint at attempt 1 resubmitted it, and cancelling it
    // on its last attempt advanced the ladder to the NEXT gap (Codex
    // 2026-09-11 I#6). The campaign's own supersessions are not stop orders —
    // that is what the mark is for.
    // The reason comes from the SAME task as the status. Reading the event's
    // "cancelled" beside the REPLACEMENT's missing reason turned the
    // campaign's own supersession into a person's stop order (Codex
    // 2026-09-11 J#1).
    const statusSource =
      tip && tip.id !== milestone.taskId
        ? tip
        : milestone.taskId
        ? this.taskManager.getStatus(milestone.taskId as TaskId)
        : null;
    // A PERSON's stop, not any cancellation: an executor retirement carries no
    // reason at all, and reading that as a stop order stranded the campaign
    // (Codex 2026-09-11 K#6).
    const cancelledOnPurpose =
      status === TaskStatus.cancelled &&
      (statusSource as { cancelReason?: string } | null)?.cancelReason === "user";
    if (cancelledOnPurpose) {
      milestone.status = "failed";
      milestone.resultExcerpt = output.slice(-500);
      campaign.state = "failed";
      campaign.autoReviveAt = undefined;
      campaign.lastError = `NOT DELIVERED — ${milestone.title} was cancelled`;
      this.persist(campaign);
      getLoggerSafe().info("Campaign stopped: its sprint was cancelled on purpose", {
        id: campaign.id,
        milestone: milestone.id,
        taskId: tip?.id ?? milestone.taskId,
      });
      await this.tell(
        campaign,
        `🛑 **${milestone.title}** was cancelled, so the campaign stops here. Reply **kampanya devam** to start it again.`,
      );
      return;
    }

    // A reaped task ("Reaped: no progress…" / "Auto-retry N/M in ~Xs") is one
    // the executor's keep-alive WILL retry — but its backoff grows past this
    // grace window (measured live: retry at +120s vs grace 90s), so reacting
    // now double-submits the sprint. Wait one keep-alive horizon and look
    // again; if the retry landed, the lineage check above adopts it.
    // Provider-fleet outages join the defer set: an "all providers in
    // cooldown" block has a KNOWN expiry the keep-alive waits out — burning a
    // campaign attempt on it killed the campaign twice in four minutes
    // (measured live 2026-08-28 20:04-20:08).
    // Provider wording alone is not a promise (see the draft path above):
    // measured 2026-09-07 07:51, a loop-blocked task carrying
    // "provider_unavailable" in one sub-goal note held the campaign 22
    // minutes for a retry nobody was going to make, with every provider up.
    const namesRetry = /Reaped:|Auto-retry \d+\/\d+/i.test(output);
    const providerWording = /provider_unavailable|All providers (failed|are in cooldown)/i.test(output);
    const executorWillRetry = namesRetry || (providerWording && allProvidersCoolingDownMs() > 0);
    // Deferral is TIME-bounded, not one-shot. The old boolean was consumed by
    // the second of a doubled settle emission (measured 2026-08-29 19:04: one
    // handler logged the defer, the next burned attempt 2 within the same
    // second) — and its fixed 11-minute re-check undershot a quota cooldown's
    // 68-minute keep-alive floor, so the re-check itself counted an attempt
    // against a task that was still honestly parked. Defer for as long as the
    // tip keeps naming a pending retry, re-checking just past the promised
    // horizon, bounded by 24h so a wedged lineage still surfaces.
    if (executorWillRetry) {
      const deferSince = milestone.reconcileDeferredSince ?? Date.now();
      const promised = /Auto-retry \d+\/\d+ in ~(\d+)s/.exec(output);
      const promisedMs = (promised ? Number(promised[1]) : 600) * 1000;
      // TRUST BUT VERIFY THE PROMISE: the tip's text says a retry is coming,
      // but a keep-alive whose budget hit 10/10 (or whose timer died with a
      // restart) never delivers — measured live 2026-08-30 15:33-15:55: zero
      // active tasks while reconcile re-deferred every cycle to a retry that
      // no longer existed. When the promised horizon (plus slack) passed and
      // the lineage tip is still this same terminal task, the promise is
      // dead: judge the outcome instead of waiting for a ghost.
      const tipUpdatedAt = (tip as { updatedAt?: number } | null)?.updatedAt;
      const promiseDead =
        tipUpdatedAt !== undefined && Date.now() > tipUpdatedAt + promisedMs + 5 * 60_000;
      if (promiseDead) {
        getLoggerSafe().warn("Deferred retry never arrived — judging the milestone outcome", {
          id: campaign.id,
          milestone: milestone.id,
          promisedMs,
        });
      } else if (Date.now() - deferSince < 24 * 60 * 60_000) {
        const waitMs = Math.min(
          Math.max(promisedMs + 60_000, 60_000),
          12 * 60 * 60_000,
        );
        milestone.reconcileDeferredSince = deferSince;
        this.persist(campaign);
        getLoggerSafe().info("Campaign deferring to the executor's pending keep-alive retry", {
          id: campaign.id,
          milestone: milestone.id,
          recheckInMs: waitMs,
        });
        this.scheduleReconcile(campaign.id, milestone.id, status, output, waitMs);
        return;
      }
    }
    milestone.reconcileDeferredSince = undefined;

    await this.onMilestoneOutcome(campaign, milestone, status, output, { countAttempt: true });
  }

  /**
   * Time-box check usable from BOTH the outcome path and the
   * adoption/deferral path. A sprint that keeps being adopted or deferred
   * never reaches an outcome — which is exactly the runaway case the box
   * exists for (measured 2026-09-01: m6 ran 7h+ at escalations=0 because
   * every settle was adopted). Returns true when it escalated.
   */
  private async escalateIfPastTimeBox(campaign: Campaign, milestone: CampaignMilestone): Promise<boolean> {
    const elapsedMs = milestone.startedAtMs ? Date.now() - milestone.startedAtMs : 0;
    const escalations = milestone.timeBoxEscalations ?? 0;
    if (elapsedMs <= this.milestoneTimeBoxMs) return false;
    if (escalations >= 2) {
      // Past the second narrowing the box used to switch OFF — the sprint
      // could run unbounded again (measured 2026-09-01: m6 at 33h with
      // escalations=2). A third overrun is a failed attempt: retry while
      // attempts remain, otherwise stop loudly so a person decides.
      const tipId = milestone.taskId
        ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)?.id
        : undefined;
      if (tipId) {
        try { this.taskManager.cancel(tipId as TaskId, { reason: "superseded" }); } catch { /* already settled */ }
      }
      const hours = Math.round(elapsedMs / 3_600_000);
      if (milestone.attempts < this.maxMilestoneAttempts) {
        milestone.startedAtMs = Date.now();
        milestone.prompt = stripTimeBoxDirectives(milestone.prompt);
        milestone.prompt +=
          `\n\nTIME BOX EXHAUSTED (${hours}h after two scope narrowings): this attempt is charged. ` +
          "Deliver ONLY the single smallest verifiable increment and stop.";
        this.persist(campaign);
        await this.tell(
          campaign,
          `⏱️ **${milestone.title}** overran its time box a third time (${hours}h) — attempt charged, ` +
            `retrying with the narrowest scope (${milestone.attempts + 1}/${this.maxMilestoneAttempts}).`,
        );
        this.submitCurrentMilestone(campaign);
        return true;
      }
      campaign.state = "failed";
      campaign.lastError = `${milestone.title} overran its time box after two narrowings and ${milestone.attempts} attempts`;
      // The same bounded recovery every other exhausted milestone gets: this
      // path used to stop dead with no appointment at all (Codex H#6).
      // The fields are reset BEFORE the revival arms its timer: persisting
      // this snapshot afterwards overwrote a revival that had already
      // happened, putting the campaign back to failed with the old task
      // (Codex 2026-09-11 J#14).
      milestone.timeBoxEscalations = 0;
      milestone.startedAtMs = undefined;
      if (await this.selfReviveImplementation(campaign, milestone, "over its time box", campaign.lastError)) {
        return true;
      }
      campaign.autoReviveAt = undefined;
      this.persist(campaign);
      await this.tell(
        campaign,
        `❌ Campaign stopped: **${milestone.title}** ran ${hours}h past two scope narrowings and ` +
          `${milestone.attempts} attempts without landing green. Reply **kampanya devam** to retry, or narrow the GDD.`,
      );
      return true;
    }

    milestone.timeBoxEscalations = escalations + 1;
    milestone.startedAtMs = Date.now();
    // One directive, the current one. Measured 2026-09-07 14:20: the prompt
    // carried "TIME BOX (6h elapsed, escalation 1/2)" and "TIME BOX (7h
    // elapsed, escalation 1/2)" back to back — the first from before a revive
    // reset the budget, both read by the sprint as live instructions.
    milestone.prompt = stripTimeBoxDirectives(milestone.prompt);
    milestone.prompt +=
      `\n\nTIME BOX (${Math.round(elapsedMs / 3_600_000)}h elapsed, escalation ${escalations + 1}/2): this sprint has run far past its budget ` +
      "without landing green. NARROW THE SCOPE NOW: pick the single highest-value unmet requirement, " +
      "implement it end-to-end (code + bound visual + passing test), commit it, and report precisely what " +
      "remains for a follow-up sprint. A smaller delivered increment beats another broad attempt.";
    this.persist(campaign);
    getLoggerSafe().warn("Milestone time-box exceeded — forcing scope narrowing", {
      id: campaign.id,
      milestone: milestone.id,
      elapsedMs,
      escalation: escalations + 1,
    });
    await this.tell(
      campaign,
      `⏱️ **${milestone.title}** has run ${Math.round(elapsedMs / 3_600_000)}h without landing green — ` +
        `narrowing scope (escalation ${escalations + 1}/2): the next attempt must deliver the smallest complete increment.`,
    );
    // Stop the runaway lineage before starting the narrowed one, or the two
    // write the same repo in parallel.
    const tipId = milestone.taskId
      ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)?.id
      : undefined;
    if (tipId) {
      try {
        this.taskManager.cancel(tipId as TaskId, { reason: "superseded" });
      } catch { /* already settled */ }
    }
    this.submitCurrentMilestone(campaign, { countAttempt: false });
    return true;
  }

  private async onMilestoneOutcome(
    campaign: Campaign,
    milestone: CampaignMilestone,
    status: TaskStatus,
    output: string,
    opts: { countAttempt: boolean },
  ): Promise<void> {
    // Defense in depth against the false-green chain: a task can settle
    // "completed" while its result is an honest terminal failure report
    // ("blocked: the bridge is down, nothing was verified"). That is not a
    // green sprint — route it through the retry/fail path on its own text.
    // MECHANICAL TEST GATE: the settle carries a verdict derived from what
    // the test tools actually printed (Task.verification) — when the latest
    // lineage task's last observed test run was RED, "completed" is not
    // green whatever the report's prose says. Audited 2026-08-29: the
    // campaign judged green from wording alone.
    if (status === TaskStatus.completed) {
      try {
        const latest = milestone.taskId
          ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)
          : null;
        const verdict = (latest as { verification?: { testsGreen?: boolean; detail: string } } | null)
          ?.verification;
        if (verdict?.testsGreen === false) {
          getLoggerSafe().warn("Milestone completion rejected: last test run was red", {
            id: campaign.id,
            milestone: milestone.id,
            detail: verdict.detail,
          });
          status = TaskStatus.failed;
          output = `Tests were RED at completion: ${verdict.detail}. ${output}`.slice(0, 2000);
        }
        // The NUnit record outranks the prose here too: a green/absent prose
        // verdict beside a fresh RED run record advanced a non-final sprint
        // (Codex 2026-09-11 B#14).
        const run = readPlaymodeRun(this.projectRoot, this.sprintStartMs(milestone), attemptRunId(milestone));
        if (status === TaskStatus.completed && run.found && (run.failed ?? 0) > 0) {
          getLoggerSafe().warn("Milestone completion rejected: the NUnit run record is red", {
            id: campaign.id,
            milestone: milestone.id,
            detail: run.detail,
          });
          milestone.testVerdict = undefined;
          milestone.testVerdictUnfiltered = undefined;
          milestone.testRunSource = "nunit";
          milestone.testFailures = run.failedNames && run.failedNames.length > 0 ? run.failedNames.slice(0, 5) : milestone.testFailures;
          status = TaskStatus.failed;
          output = `Tests were RED at completion (NUnit record): ${run.detail}. ${output}`.slice(0, 2000);
        }
      } catch { /* verdict read is best-effort; other gates still apply */ }
    }

    if (status === TaskStatus.completed && isTerminalFailureReport(output)) {
      getLoggerSafe().warn("Milestone task completed with a terminal failure report — treating as failed", {
        id: campaign.id,
        milestone: milestone.id,
      });
      status = TaskStatus.failed;
    }

    // VISUAL EVIDENCE GATE: when the sprint's own prompt demands a captured
    // frame (the planner demands it of every sprint), a completed task with
    // NO fresh capture since the milestone started is a sim-green/screen-empty
    // sprint — the exact disease the user found by hand: scenes look right in
    // reports and draw nothing. One missing-evidence bounce per milestone; the
    // bounce names the gap so the retry produces the frame instead of prose.
    // The recorded planner demand, NOT a scan of the live prompt: appended
    // directives must not arm a gate the planner never asked for (audited
    // 2026-09-04). Rows persisted before the field exists fall back to the scan.
    const visualGateArmed = milestone.visualGateArmed ?? /captur/i.test(milestone.prompt);
    if (status === TaskStatus.completed && visualGateArmed) {
      const evidence = this.freshCaptureEvidence(milestone);
      if (!evidence.found && !milestone.visualEvidenceBounced) {
        milestone.visualEvidenceBounced = true;
        milestone.prompt +=
          "\n\nVISUAL EVIDENCE MISSING: the previous attempt reported completion but produced no NEW " +
          "captured frame (Recordings/ or Assets/Art/Prerendered) since this sprint began. A sprint " +
          "whose game draws nothing is not done. Run unity_playmode_verify with capture:true (or the " +
          "capture path your work uses), confirm frames render with actual content, and only then report completion.";
        this.persist(campaign);
        getLoggerSafe().warn("Milestone completion rejected: no fresh visual evidence", {
          id: campaign.id,
          milestone: milestone.id,
        });
        this.submitCurrentMilestone(campaign, { countAttempt: false });
        return;
      }
    }

    if (status === TaskStatus.completed) {
      // Commit gate: a sprint is not green while its work sits uncommitted in
      // the working tree. No path in the pipeline commits into the REAL repo:
      // the lease write-back only copies files, and the agent's own git_commit
      // runs inside a detached worktree whose commits die with the worktree
      // (now preserved on lease-salvage/* branches, but still not on main).
      // That is how a campaign once ended with 282 dirty files and a corrupted
      // next-sprint seed. The envelope commits.
      const commitNote = await this.commitMilestoneWork(campaign, milestone);
      // NO-WORK GATE: green with a clean tree AND no commits since the sprint
      // began is a sprint that changed nothing — audited 2026-08-29: the green
      // stamp sat unconditionally beside the commit call, so an empty sprint
      // went green silently. One bounce per milestone, like the visual gate.
      if (commitNote === "" && !milestone.noWorkBounced && !this.repoChangedSince(milestone)) {
        milestone.noWorkBounced = true;
        milestone.prompt +=
          "\n\nNO WORK DETECTED: the previous attempt reported completion but left the repository " +
          "untouched — no dirty files to commit and no new commits since this sprint began. A sprint " +
          "that changes nothing is not done. Do the sprint's work in the actual project tree and only " +
          "then report completion.";
        this.persist(campaign);
        getLoggerSafe().warn("Milestone completion rejected: repository unchanged", {
          id: campaign.id,
          milestone: milestone.id,
        });
        this.submitCurrentMilestone(campaign, { countAttempt: false });
        return;
      }
      // ART NOT PRODUCED. Measured 2026-09-07: four coverage-remediation
      // attempts against a tree whose sprite art was 410/429 placeholder-grade
      // ended with the same 410/429 — the sprints compiled, verified and wrote
      // documents, and never called a generator or the purchased library. The
      // installed local model draws a real sprite in ~45 s (measured today).
      // The measurement that says "placeholder art" at delivery says it here,
      // once, while the sprint can still act on it.
      const artGate = this.placeholderArtGate(campaign, milestone);
      if (artGate !== undefined && !milestone.artBounced) {
        milestone.artBounced = true;
        milestone.prompt += `\n\n${artGate}`;
        this.persist(campaign);
        getLoggerSafe().warn("Milestone completion rejected: placeholder art count did not drop", {
          id: campaign.id,
          milestone: milestone.id,
          atStart: milestone.placeholderArtAtStart,
        });
        this.submitCurrentMilestone(campaign, { countAttempt: false });
        return;
      }
      // PROSE IS NOT WORK. Measured live 2026-09-04: told not to audit, the
      // final sprint answered three times with DOCUMENTS — a gap analysis, an
      // entry-scene audit, a "vertical slice" write-up — and its commit
      // touched 0 code, scene, prefab or asset files. The no-work gate above
      // sees a dirty tree and passes it. A sprint whose entire output is
      // documentation has not built anything.
      if (!milestone.prosOnlyBounced && this.changedOnlyProse(milestone)) {
        milestone.prosOnlyBounced = true;
        milestone.prompt +=
          "\n\nDOCUMENTS ARE NOT DELIVERY: your last attempt changed only documentation — no .cs, " +
          "no .unity, no .prefab, no asset. Write code and scenes; the report is the test output and " +
          "the captured frame, not a markdown file.";
        this.persist(campaign);
        getLoggerSafe().warn("Milestone completion rejected: the sprint changed only documentation", {
          id: campaign.id,
          milestone: milestone.id,
        });
        this.submitCurrentMilestone(campaign, { countAttempt: false });
        return;
      }
      milestone.status = "green";
      milestone.resultExcerpt = output.slice(-500);
      milestone.commitNote = commitNote.trim() || undefined;
      // Record what the capture scan saw for EVERY green, not only the gated
      // ones: the gate above is keyed on planner wording, and a sprint whose
      // gate never ran must not read like one that passed it in the report
      // (audited 2026-09-02).
      try {
        const captureDemanded = visualGateArmed;
        milestone.visualEvidence = this.freshCaptureEvidence(milestone).found
          ? "observed"
          : captureDemanded
            ? "none-gate-spent"
            : "none-gate-not-demanded";
      } catch { /* evidence capture is best-effort */ }
      try {
        const tip = milestone.taskId
          ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)
          : null;
        const verdict = (tip as {
          verification?: {
            testsGreen?: boolean;
            detail: string;
            unfiltered?: boolean;
            failedTests?: readonly string[];
            failedTestsOmitted?: number;
            assetSourcingBlind?: string;
          };
        } | null)?.verification;
        // THE ONLY REAL-ART SOURCE BEING DEAD IS NEWS. Audited 2026-09-06: a
        // whole campaign's my-assets calls failed on an expired Unity link and
        // nothing reached the channel or the report. Told once per campaign,
        // carried on every affected sprint for the report.
        if (verdict?.assetSourcingBlind) {
          milestone.assetSourcingBlind = verdict.assetSourcingBlind;
          const alreadyTold = campaign.milestones.some((m) => m.assetSourcingBlindTold === true);
          if (!alreadyTold) {
            milestone.assetSourcingBlindTold = true;
            await this.tell(
              campaign,
              `⚠️ Asset sourcing is BLIND: ${verdict.assetSourcingBlind}\n` +
                "The purchased library (unity_my_assets_cloud) cannot be reached until you run " +
                "`strada unity-link` in a terminal — sprints can only fall back to procedural placeholders " +
                "until then.",
            );
          }
        }
        // THE NUNIT FILE OVER THE PROSE (2026-09-10): when the verification
        // tool left its run record for this sprint, the counts and the filter
        // come from there — green is failed === 0 with tests executed,
        // unfiltered is "no -testFilter/-categories given", never a word in a
        // sentence. The prose-derived verdict remains the fallback.
        const run = readPlaymodeRun(this.projectRoot, this.sprintStartMs(milestone), attemptRunId(milestone));
        // A STALE record is not silence: reading an old result with
        // unity_test_results produced green prose while the record on disk
        // predated the attempt, so the prose fallback turned a cached answer
        // into fresh proof (Codex 2026-09-11 C#10). The final sprint is held
        // to the file; earlier sprints keep the prose fallback.
        const finalSprint = campaign.currentMilestone >= campaign.milestones.length - 1;
        // THE FINAL SPRINT NEEDS THE RECORD, not prose. Accepting prose when
        // no record file happened to exist — and clearing it when a stale one
        // did — made an unrelated file decide whether identical evidence
        // counted (Codex 2026-09-11 D#13). Earlier sprints keep the fallback.
        // …and the record must say WHEN it ran. A copied file's mtime is
        // fresh by construction, so a record with no usable measuredAt is not
        // this attempt's proof either (Codex 2026-09-11 G#4).
        if (finalSprint && !(run.found === true && run.total !== undefined && run.stampMissing !== true)) {
          milestone.testVerdict = undefined;
          milestone.testVerdictUnfiltered = undefined;
          milestone.testRunSource = "nunit";
          milestone.testFailures = verdict?.failedTests;
          milestone.testFailuresOmitted = verdict?.failedTestsOmitted;
        } else if (run.found && run.total !== undefined) {
          const green = run.green === true;
          milestone.testVerdict = green ? run.detail : undefined;
          milestone.testVerdictUnfiltered = green ? run.unfiltered : undefined;
          milestone.testFailures = run.failedNames && run.failedNames.length > 0 ? run.failedNames.slice(0, 5) : verdict?.failedTests;
          milestone.testFailuresOmitted = run.failedNames && run.failedNames.length > 5 ? run.failedNames.length - 5 : verdict?.failedTestsOmitted;
          milestone.testRunSource = "nunit";
        } else {
          milestone.testVerdict = verdict?.testsGreen === true ? verdict.detail : undefined;
          milestone.testVerdictUnfiltered = verdict?.testsGreen === true ? verdict.unfiltered : undefined;
          // Red names are kept even though the milestone is green: a sprint can
          // land green after a red run, and "which tests were red on the way"
          // is what a reader needs (audited 2026-09-03).
          milestone.testFailures = verdict?.failedTests;
          milestone.testFailuresOmitted = verdict?.failedTestsOmitted;
          milestone.testRunSource = verdict ? "prose" : undefined;
        }
      } catch (e) {
        // NOT best-effort: leaving the PREVIOUS attempt's verdict standing is
        // how a failure to read this attempt's evidence became this attempt's
        // green (Codex 2026-09-11 E#1). No reading, no verdict.
        milestone.testVerdict = undefined;
        milestone.testVerdictUnfiltered = undefined;
        milestone.testRunSource = undefined;
        getLoggerSafe().warn("Test evidence unreadable — the sprint's verdict is cleared, not carried over", {
          milestone: milestone.id,
          error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        });
      }
      // Persist the green BEFORE the coverage audit: that await is a
      // 400k-window LLM call lasting minutes, and storage said "running" the
      // whole time. What this persist buys is a DURABLE record of the green
      // (commit note, test verdict) so a crash mid-audit does not lose it; a
      // restart still re-enters this path and re-runs the audit, which is
      // right — the audit's result was never recorded. Concurrent re-entry
      // is prevented by the settle chain (scheduleReconcile), not by this
      // persist (audited 2026-09-02: the comment used to claim otherwise).
      this.persist(campaign);
      const isLast = campaign.currentMilestone >= campaign.milestones.length - 1;
      // The gate spends one bounce per ATTEMPT the milestone still has, not
      // one for the whole milestone. Measured live 2026-09-03 08:33: the
      // second attempt also ran no tests, the single bounce was spent, and
      // the ladder delivered a game whose suite was never seen to pass.
      // While attempts remain, an unverified final sprint is charged and
      // resent instead of waved through.
      const deliveryBouncesSpent = milestone.deliveryVerificationBounces ?? (milestone.deliveryVerificationBounced ? 1 : 0);
      // DELIVERY NEEDS THE WHOLE SUITE. A verdict that merely EXISTS is not
      // proof: the delivered PixelFlow campaign carried no verdict on any
      // milestone, its filtered runs were green, and the one unfiltered run
      // reported 6 of 173 failing — including WinLevel_ReachesWonState
      // ("LevelWon event did not fire"). A green from a filter is the sprint
      // choosing which tests count (audited 2026-09-03).
      // ASK THE COMPILER, not the agent. Every other gate reads what a run
      // REPORTED; this one measures. Sprint 7 was committed green (1296 files,
      // f674e8d) and the campaign delivered while the tree carried 37 compile
      // errors — found seconds later by the real-tree guardian, and by no gate
      // at all (measured live 2026-09-04 21:37). A verifier that could not run
      // is recorded as NOT RUN and never as a pass.
      const compile = await this.measureCompile();
      milestone.compileVerdict = compile;
      const compileBroken = compile.ran && !compile.ok;
      // A verifier that could not run proves nothing: at the final sprint that
      // is a missing proof, not a pass (Codex 2026-09-11 B#2).
      const compileNotRun = isLast && !compile.ran;
      // A non-final sprint that does not compile is not green either: it
      // advanced with the failure disclosed, and the next sprint inherited a
      // red tree (Codex 2026-09-11 B#14). Same budget as the delivery gate;
      // past it the attempt is charged and the milestone fails on its own.
      if (!isLast && compileBroken) {
        if (deliveryBouncesSpent < this.maxMilestoneAttempts) {
          milestone.deliveryVerificationBounced = true;
          milestone.deliveryVerificationBounces = deliveryBouncesSpent + 1;
          const marker = "\n\n[COMPILE GATE — latest measurement]";
          const cut = milestone.prompt.indexOf(marker);
          if (cut >= 0) milestone.prompt = milestone.prompt.slice(0, cut);
          milestone.prompt += `${marker}\nTHE PROJECT DOES NOT COMPILE${typeof compile.errors === "number" ? ` — ${compile.errors} error(s)` : ""}. ` +
            `Fix that before anything else; a sprint is not green while the tree does not build.${compile.detail ? ` The verifier said: ${compile.detail}` : ""}`;
          this.persist(campaign);
          getLoggerSafe().warn("Sprint blocked: the tree does not compile", { id: campaign.id, milestone: milestone.id, bounce: milestone.deliveryVerificationBounces, errors: compile.errors });
          this.submitCurrentMilestone(campaign, { countAttempt: deliveryBouncesSpent > 0 });
          return;
        }
        await this.onMilestoneOutcome(campaign, milestone, TaskStatus.failed, `The tree does not compile${typeof compile.errors === "number" ? ` (${compile.errors} error(s))` : ""}: ${compile.detail ?? ""}`.slice(0, 600), { countAttempt: true });
        return;
      }
      // PLAY-THROUGH PROOF. A green suite and a clean compile say the game
      // builds and its tests pass; neither says it can be played. Measured
      // 2026-09-10: delivered green, entry scene idle after boot, no level
      // ever started at runtime. Only the final sprint is held to it, and
      // only within the same bounce budget as the test verdict.
      // Measured at EVERY sprint (2026-09-10): a fresh verdict from a mid-
      // ladder sprint is evidence the report can show and the next sprint can
      // build on; only the final sprint is held to it.
      const playthrough = this.measurePlaythrough(milestone);
      milestone.playthroughVerdict = playthrough;
      const playthroughMissing = isLast && (playthrough === undefined || !playthrough.found || playthrough.ok !== true);
      // THE GDD'S OWN NUMBERS. "60 fps", "loads in under 3 s", "a round lasts
      // 30–90 s" were repeated to the planner and measured by nothing until
      // 2026-09-10. Each is now answered from the play-through's timing or
      // listed as NOT MEASURED with the reason; a blown budget the medium can
      // answer (boot time, session length) refuses delivery like the other
      // proofs, within the same bounce budget.
      // THE ARTIFACT. A delivery is a runnable player, not an editor project
      // that compiles. The campaign builds it ITSELF from the project root,
      // once the other proofs stand — the worker's "built successfully" is a
      // sentence; the artifact's size on disk is a measurement. Not attempted
      // while earlier proofs are missing (a build is minutes), and disclosed
      // as NOT MEASURED then, never as a pass.
      const earlierProofsMissing =
        !milestone.testVerdict || milestone.testVerdictUnfiltered !== true || compileBroken || compileNotRun || playthroughMissing;
      const build = isLast
        ? earlierProofsMissing
          ? { ran: false, detail: "not attempted: earlier delivery proofs are missing (suite, compile or play-through)" }
          : await this.measureBuild(campaign)
        : undefined;
      if (build !== undefined) milestone.buildVerdict = build;
      const buildBroken = Boolean(build?.ran) && build?.ok !== true;
      // The build was attempted (earlier proofs stood) and could not run: no
      // artifact was measured — a missing proof, disclosed by its reason.
      const buildNotRun = isLast && build !== undefined && !earlierProofsMissing && !build.ran;
      // THE PLAYER, PLAYED. With an artifact in hand the campaign plays it
      // (unity_run_player) — real rendering, real frame rate — and reads the
      // verdict back. A player that runs but cannot be played to an outcome
      // blocks; an artifact this machine cannot run (an .apk) is disclosed.
      const player = isLast && build?.ran && build.ok === true ? await this.measurePlayerRun(milestone, build) : undefined;
      if (player !== undefined) milestone.playerPlaythrough = player;
      const playerBroken = player !== undefined && player.found && player.ok !== true;
      // An artifact in hand that was never played to a verdict — no runner,
      // the run could not start, or it left no file — is a missing proof too.
      const playerUnrunnableHere = player !== undefined && typeof (player as { unrunnableHere?: string }).unrunnableHere === "string";
      const playerMissing = isLast && build?.ran === true && build.ok === true
        && (player === undefined || (!player.found && !playerUnrunnableHere));
      // THE GDD'S OWN NUMBERS. "60 fps", "loads in under 3 s", "a round lasts
      // 30–90 s" were repeated to the planner and measured by nothing until
      // 2026-09-10. Each is now answered from the play-throughs' timing (the
      // built player's frame rate when it was played) or listed as NOT
      // MEASURED with the reason; a blown budget the medium can answer
      // refuses delivery like the other proofs, within the same bounce budget.
      const claims = isLast ? this.measureGddClaims(campaign, playthrough, player, build) : undefined;
      if (claims) milestone.gddClaims = claims.lines;
      const claimsBroken = Boolean(claims?.refusal);
      const deliveryProofMissing = earlierProofsMissing || buildBroken || buildNotRun || playerBroken || playerMissing || claimsBroken;
      // What is missing, in words — for the bounce, the NOT DELIVERED report
      // and the stored milestone. Empty when everything stands.
      const missingProofs: string[] = [];
      if (isLast) {
        if (!milestone.testVerdict) missingProofs.push("no test run was observed");
        else if (milestone.testVerdictUnfiltered !== true) missingProofs.push("the only green test run was FILTERED (a subset the sprint chose)");
        if (compileBroken) missingProofs.push(`the project does not compile${typeof compile.errors === "number" ? ` (${compile.errors} error(s))` : ""}`);
        if (compileNotRun) missingProofs.push(`the compile check did not run: ${compile.detail ?? "no reason recorded"}`.slice(0, 220));
        if (playthroughMissing) missingProofs.push(describePlaythrough(playthrough).slice(0, 220));
        if (buildBroken) missingProofs.push(`the player build failed: ${(build?.reasons ?? []).slice(0, 2).join("; ") || build?.detail || "no reason recorded"}`.slice(0, 220));
        if (buildNotRun) missingProofs.push(`the player build did not run: ${build?.detail ?? "no reason recorded"}`.slice(0, 220));
        if (playerMissing) {
          const missingRunner = (player as { missingRunner?: string } | undefined)?.missingRunner;
          missingProofs.push(
            missingRunner
              ? `the built player was never played: ${missingRunner}`
              : "the built player was never played to a verdict (unity_run_player left no verdict)",
          );
        }
        if (playerUnrunnableHere) {
          milestone.gddClaims = [
            ...(milestone.gddClaims ?? []),
            `NOT MEASURED: the built artifact cannot be run on this machine — ${(player as { unrunnableHere?: string }).unrunnableHere}`,
          ];
        }
        if (playerBroken && player) missingProofs.push(`inside the built player: ${describePlaythrough(player)}`.slice(0, 220));
        // A requirement the audit NAMED and no sprint has run yet is missing
        // work, and delivery may not step over it (Codex 2026-09-11 I#4).
        const queuedGaps = campaign.pendingCoverageGaps ?? [];
        if (queuedGaps.length > 0) {
          missingProofs.push(
            `${queuedGaps.length} GDD requirement(s) the audit named have no sprint yet: ${queuedGaps.slice(0, 2).join("; ")}`.slice(0, 220),
          );
        }
        if (claims?.refusal) missingProofs.push(claims.refusal.slice(0, 220));
        milestone.deliveryProofsMissing = missingProofs;
        // …and the IDENTITY of this round's failure, computed from the gate
        // outcomes themselves rather than from the sentences they produce.
        // Every prose classifier this week has been defeated by a
        // measurement moving inside a sentence or a word appearing in an
        // explanation (Codex 2026-09-11 K#3, K#4, K#5). The flags cannot be
        // paraphrased.
        milestone.deliveryFailureKinds = deliveryFailureKinds({
          testsNotRun: !milestone.testVerdict,
          testsFiltered: Boolean(milestone.testVerdict) && milestone.testVerdictUnfiltered !== true,
          compileBroken,
          compileNotRun,
          playthroughMissing,
          playthroughStale: playthrough?.stale === true,
          playthroughRefused: playthrough?.found === true && playthrough.ok !== true,
          buildBroken,
          buildNotRun,
          playerMissing,
          playerBroken,
          claimsBroken,
          structureRefused: milestone.structureRefused === true,
          queuedGaps: (campaign.pendingCoverageGaps ?? []).length > 0,
        });
      }
      if (isLast && deliveryProofMissing && deliveryBouncesSpent < this.maxMilestoneAttempts) {
        // DELIVERY GATE: "the whole game runs" was only ever a sentence in the
        // planner's prompt — nothing in code required the final sprint to
        // have RUN the suite. A milestone whose task printed no recognizable
        // test result carries no verdict at all and sailed through
        // (audited 2026-09-01). One bounce, then the ladder proceeds so an
        // honest report can still be delivered.
        milestone.deliveryVerificationBounced = true;
        milestone.deliveryVerificationBounces = deliveryBouncesSpent + 1;
        const observedButFiltered = Boolean(milestone.testVerdict) && milestone.testVerdictUnfiltered !== true;
        const suiteProofMissing = !milestone.testVerdict || milestone.testVerdictUnfiltered !== true || compileBroken;
        const playthroughClause = playthroughMissing ? `\n${playthroughDirective(playthrough)}` : "";
        const claimsClause = claims?.refusal ? `\n${claims.refusal}` : "";
        const buildClause = buildBroken
          ? `\nPLAYER BUILD FAILED: the campaign built the player from the project root and it did not produce a runnable artifact — ${
              (build?.reasons ?? []).slice(0, 4).join("; ") || build?.detail || "no reason recorded"
            }. Run unity_build_player yourself, fix what it names, and run it again until it reports the artifact's path and size; a delivery is a runnable artifact.`
          : "";
        const playerClause = playerBroken && player
          ? `\nPLAYER PLAY-THROUGH FAILED: the campaign built the player and played it (unity_run_player); ${describePlaythrough(player)}. Fix what it names and run unity_run_player yourself until its verdict is ok.`
          : "";
        const suiteClause = !suiteProofMissing && !playthroughMissing && !claimsBroken && buildBroken
          ? "the suite is green, the game was played and the GDD's numbers hold, but the PLAYER DOES NOT BUILD. "
          : !suiteProofMissing && !playthroughMissing && claimsBroken
          ? "the suite is green, the project compiles and the game was played, but the GDD's own numbers are NOT met. "
          : !suiteProofMissing
          ? "the suite is green and the project compiles, but the game was not shown to be PLAYABLE. "
          : compileBroken && Boolean(milestone.testVerdict) && milestone.testVerdictUnfiltered === true
          ? "the suite's green run means nothing while the project does not compile. "
          : observedButFiltered
          ? "the only green test run observed was FILTERED — a subset you chose. "
          : "no test run was observed in the last attempt. ";
        const directive =
          "\n\nDELIVERY VERIFICATION REQUIRED: this is the final sprint, and " + suiteClause +
          "Run the FULL PlayMode suite UNFILTERED against the assembled scene, capture a frame of " +
          "the running game, and report the suite's actual pass/fail counts. Delivery is not declared on a sprint " +
          "whose whole suite was never seen to pass.\n" +
          // Measured live 2026-09-03 23:30: the sprint answered this directive
          // with a JSON INVENTORY (module counts, prefab counts, a scene list)
          // and changed nothing. "Report the counts" was read as "produce a
          // report". The verb has to be unmistakable.
          "DO NOT AUDIT. An inventory of modules, prefabs, scenes or tests is not work and will be " +
          "rejected: run the tools, change the code, and let the suite's own output be your report.\n" +
          // The id that binds a record to THIS attempt. A tool that does not
          // pass it through changes nothing; one that does makes a record from
          // another attempt impossible to present as this one's proof.
          `RUN ID for this attempt: ${attemptRunId(milestone)} — pass it to the verification tools ` +
          "(runId) so the records they write name the attempt that asked for them." +
          playthroughClause +
          claimsClause +
          buildClause +
          playerClause;
        // SAY EVERYTHING THAT IS WRONG, NOT ONE THING AT A TIME. The
        // structural check runs only after this gate passes, so a sprint stuck
        // here never learns its scenes render nothing — measured live
        // 2026-09-04 04:05: while bounced for a missing verdict, the sprint
        // ADDED two more CreatePrimitive scripts (5 → 7), moving away from the
        // requirement it had not been told about.
        const structureNow = this.measureDeliveryStructure(campaign);
        // Lead with the compiler when the compiler is the problem: a tree that
        // does not build cannot be tested, so telling the sprint to run the
        // suite first would send it at the second problem.
        const compileFirst = compileBroken
          ? `THE PROJECT DOES NOT COMPILE${
              typeof compile.errors === "number" ? ` — ${compile.errors} error(s)` : ""
            }. Fix that before anything else; no test run means anything until it builds.${
              compile.detail ? ` The verifier said: ${compile.detail}` : ""
            }\n\n`
          : "";
        // The structural verdict is NOT repeated here. Measured 2026-09-08
        // 05:25: a gate block from a verification bounce days earlier still
        // said "ALSO, ALREADY MEASURED: the shipped scenes render NOTHING …
        // bind them in the scene", while <<MEASURED NOW>> — refreshed at every
        // submit — said the art was placeholder-grade with six world renderers
        // in place. The sprint followed the older sentence: nineteen
        // unity_bind_sprite calls, no sprite drawn, the count unchanged. One
        // measurement, in one place, current at submit: <<MEASURED NOW>>
        // (attachStructureMeasurement). structureNow still feeds the log.
        const combined = `${compileFirst}${directive}`;
        if (structureNow.refusal) {
          getLoggerSafe().info("Delivery gate bounce — structural refusal carried by <<MEASURED NOW>>, not repeated in the gate", {
            id: campaign.id,
            milestone: milestone.id,
            refusal: structureNow.refusal.slice(0, 200),
          });
        }
        // The CURRENT reason, not the first one. Review 2026-09-07: the block
        // was appended only when absent, so a second bounce for a different
        // cause (the compile broke after a green suite; the structure now
        // refuses) sent the charged retry out with the stale "no test run was
        // observed" text and never the compile failure.
        const gateMarker = "\n\n[DELIVERY GATE — latest measurement]";
        const cutAt = [milestone.prompt.indexOf(gateMarker), milestone.prompt.indexOf("\n\nDELIVERY VERIFICATION REQUIRED")]
          .filter((i) => i >= 0);
        if (cutAt.length > 0) milestone.prompt = milestone.prompt.slice(0, Math.min(...cutAt));
        milestone.prompt += `${gateMarker}\n${combined}`;
        this.persist(campaign);
        getLoggerSafe().warn("Delivery blocked: the final milestone lacks its proof", {
          id: campaign.id,
          milestone: milestone.id,
          bounce: milestone.deliveryVerificationBounces,
          cause: compileBroken ? "does not compile" : observedButFiltered ? "filtered test run" : !milestone.testVerdict ? "no test verdict" : "no ok play-through",
          playthrough: playthrough === undefined ? "not measured" : describePlaythrough(playthrough).slice(0, 200),
          structuralRefusal: structureNow.refusal !== undefined,
        });
        // The FIRST bounce is free (the sprint may simply not have printed a
        // recognizable line); a repeat is charged, so the milestone's own
        // attempt budget bounds this instead of it looping forever.
        this.submitCurrentMilestone(campaign, { countAttempt: deliveryBouncesSpent > 0 });
        return;
      }
      if (isLast) {
        // STRUCTURAL DELIVERY GATE (audited 2026-09-03): nothing in the
        // pipeline ever asked what the delivered SCENES contain. PixelFlow
        // shipped "game build complete" with an entry scene holding zero
        // renderer components, five runtime scripts drawing the world with
        // GameObject.CreatePrimitive, and 100 prefabs / 198 pngs / 62 models
        // nothing bound — the user opened it and found flat squares and four
        // spheres. This measures the enabled build scenes and the prefabs they
        // place, and refuses ONLY the strong case; everything else is recorded
        // for the report. Delivery-only by construction (inside `isLast`), and
        // it shares the delivery bounce budget so it cannot loop.
        const structure = this.measureDeliveryStructure(campaign);
        milestone.structureFindings = structure.lines;
        // The flag follows the CURRENT measurement. Review 2026-09-07: it was
        // only ever set, never cleared, so one structural bounce followed by a
        // sprint that placed the prefabs still ended the campaign "failed"
        // below on a tree the check had just passed — and "kampanya devam"
        // could not get past it either.
        milestone.structureRefused = structure.refusal !== undefined;
        if (structure.refusal && deliveryBouncesSpent < this.maxMilestoneAttempts) {
          milestone.deliveryVerificationBounced = true;
          milestone.deliveryVerificationBounces = deliveryBouncesSpent + 1;
          milestone.structureRefused = true;
          const marker = "\n\nDELIVERY REFUSED — THE GAME IS NOT BUILT AS THE GDD SPECIFIES:";
          const previous = milestone.prompt.indexOf(marker);
          // Carry the LATEST measurement, not a stack of stale ones.
          if (previous >= 0) milestone.prompt = milestone.prompt.slice(0, previous);
          milestone.prompt +=
            `${marker} ${structure.refusal}\n` +
            "Fix the game, not the report: place the project's own prefabs in the scenes the build ships, bind " +
            "real materials/meshes/sprites to their renderers instead of engine primitives, and re-verify with a " +
            "captured frame of the entry scene. Then report what the scenes contain.\n" +
            "DO NOT AUDIT: counting what exists is not the task — binding it into the shipped scenes is.";
          this.persist(campaign);
          getLoggerSafe().warn("Delivery blocked: the shipped scenes are not built as specified", {
            id: campaign.id,
            milestone: milestone.id,
            bounce: milestone.deliveryVerificationBounces,
            refusal: structure.refusal.slice(0, 300),
          });
          this.submitCurrentMilestone(campaign, { countAttempt: deliveryBouncesSpent > 0 });
          return;
        }
        if (structure.refusal) {
          // Budget spent: the delivery proceeds, but it must NOT read like one
          // that passed the check.
          milestone.structureRefused = true;
          milestone.structureFindings = [
            `REFUSAL STANDS, bounce budget spent: ${structure.refusal}`,
            ...structure.lines,
          ];
        }
        // SCENE HYGIENE GATE. Measured on the delivered PixelFlow tree
        // 2026-09-03: 14 scenes enabled in Build Settings, most of them
        // single-purpose verification scaffolding, and the person who opened
        // the delivery could not find the game. The COUNT always reaches the
        // report (see describeEntryPoint); this gate refuses delivery only in
        // the two cases where there is nothing to open at all — no enabled
        // scene, or no enabled scene whose file can be read and holds
        // anything. Deleting or disabling a user's scenes is NOT a decision
        // this system may make unilaterally, so a merely untidy build is
        // disclosed and delivered, never blocked.
        const hygiene = assessSceneHygiene(this.projectRoot);
        const hygieneBounces = milestone.sceneHygieneBounces ?? 0;
        if (hygiene.refusal && hygieneBounces < this.maxMilestoneAttempts) {
          milestone.sceneHygieneBounces = hygieneBounces + 1;
          const directive =
            "\n\nNO ENTRY SCENE: " + hygiene.refusal.detail + ". A delivery nobody can open is not a " +
            "delivery. Put the obvious entry scene FIRST in Build Settings — the scene that " +
            "runs the game — with every verification/scaffolding scene deleted or disabled, and name that " +
            "scene in your final report.";
          if (!milestone.prompt.includes("NO ENTRY SCENE")) milestone.prompt += directive;
          this.persist(campaign);
          getLoggerSafe().warn("Delivery blocked: the build has no scene a person can open", {
            id: campaign.id,
            milestone: milestone.id,
            refusal: hygiene.refusal.kind,
            bounce: milestone.sceneHygieneBounces,
          });
          // Same charging rule as the delivery-verification gate: the first
          // bounce is free, repeats are charged, so the attempt budget bounds
          // this instead of it looping forever.
          this.submitCurrentMilestone(campaign, { countAttempt: hygieneBounces > 0 });
          return;
        }
        // A gate that ran out of bounces must not read like one that passed:
        // the surviving refusal is carried into the delivery report verbatim.
        milestone.sceneHygieneUnresolved = hygiene.refusal?.detail;
        // DOES IT LOOK LIKE THE GDD? Disclosure only: the structural gate
        // above already refuses the hard case, and a stylised look is a
        // judgement a model can get wrong. What must never happen is silence
        // (audited 2026-09-03: 11351 frames of a flat coloured grid satisfied
        // a check that only asks for size and a distinct hash).
        try {
          const gddForLook =
            campaign.gddText ?? (campaign.gddPath ? readGddFile(this.projectRoot, campaign.gddPath) : undefined);
          const look = extractLookDescription(gddForLook ?? "");
          const frame = selectGameplayFrame(this.projectRoot, this.sprintStartMs(milestone));
          const verdict = await judgeVisualConformance({ look, frame, visionProvider: this.visionProvider });
          milestone.visualConformance = renderVisualConformance(verdict, frame);
          // ONE bounce on an explicit "no" (2026-09-10): the check used to be
          // disclosure only, so a frame of the wrong game shipped with a
          // footnote. A vision model's judgement is fallible, so this is a
          // single chance to fix the look, never a wall — after it, the
          // disclosure stands and the report says NO MATCH.
          const mismatchBounces = milestone.visualMismatchBounces ?? 0;
          if (verdict.status === "checked" && verdict.matches === false && mismatchBounces < 1 && deliveryBouncesSpent < this.maxMilestoneAttempts) {
            milestone.visualMismatchBounces = mismatchBounces + 1;
            milestone.deliveryVerificationBounced = true;
            milestone.deliveryVerificationBounces = deliveryBouncesSpent + 1;
            const marker = "\n\nLOOK DOES NOT MATCH THE GDD:";
            const previous = milestone.prompt.indexOf(marker);
            if (previous >= 0) milestone.prompt = milestone.prompt.slice(0, previous);
            milestone.prompt +=
              `${marker} a vision model judged the newest captured frame (${frame.path ?? "?"}) against the GDD's own look description and said: ${verdict.detail}. ` +
              "Bind the GDD's art and style into the shipped scenes (sprites, materials, palette, camera framing), capture a new frame of the running game, and report what changed. " +
              "DO NOT AUDIT: change the scenes, not the description.";
            this.persist(campaign);
            getLoggerSafe().warn("Delivery bounced: the frame does not show the described game", {
              id: campaign.id,
              milestone: milestone.id,
              detail: verdict.detail.slice(0, 200),
            });
            this.submitCurrentMilestone(campaign, { countAttempt: deliveryBouncesSpent > 0 });
            return;
          }
        } catch (err) {
          milestone.visualConformance =
            `**Does it look like the GDD?**\n- ⚠️ visual conformance not checked — ${err instanceof Error ? err.message : String(err)}.`;
        }
        // Coverage gate: "done" is measured against the GDD, not against the
        // ladder having run out. When scheduled items are missing, a
        // remediation sprint is appended instead of delivering short.
        const remediation = await this.buildCoverageRemediation(campaign);
        if (remediation && remediation.length > 0) {
          milestone.status = "green";
          campaign.milestones.push(...remediation);
          campaign.currentMilestone += 1;
          this.persist(campaign);
          await this.tell(
            campaign,
            `✅ ${milestone.title} — green.${commitNote}\n⚠️ Coverage audit against the GDD found ${remediation.length} gap${remediation.length === 1 ? "" : "s"} — appending ` +
              `${remediation.map((m) => `**${m.title}**`).join(", ")} before delivery.`,
          );
          const id = campaign.id;
          this.resubmitSoon(id);
          return;
        }
        // A GAME THAT RENDERS NOTHING IS NOT DELIVERED. When the structural
        // check still refuses after its bounce budget is spent, the campaign
        // used to declare `done` and disclose the refusal as a caveat —
        // measured live 2026-09-04 21:37: "🏁 Campaign delivery — game built"
        // above "REFUSAL STANDS … The shipped scenes render NOTHING … 360
        // assets no enabled scene reaches". The disclosure was honest and the
        // headline was not: the one sentence a person reads first said the
        // opposite of the evidence under it. Stop and hand it to a person
        // instead; every finding still travels in the report.
        // The compiler is held to the same rule (review 2026-09-07): with the
        // delivery bounces spent, a tree that still does not build was
        // declared "game build complete" with the compile failure as a
        // footnote mark.
        // DELIVERY GATES ARE NOT WAIVABLE (2026-09-10). The suite, the
        // play-through, the GDD's numbers and the player build are held to
        // the same rule as the structural check and the compiler: when the
        // bounce budget runs out with a proof still missing, the campaign is
        // NOT DELIVERED — it used to declare `done` with "went green with NO
        // observed test run" as a caveat under "game build complete". It
        // then resumes the final sprint BY ITSELF after a pause, with a fresh
        // budget, so a GDD runs until the game is actually done; a person can
        // resume sooner with "kampanya devam".
        if (milestone.structureRefused === true || compileBroken || missingProofs.length > 0) {
          campaign.state = "failed";
          campaign.lastError = compileBroken
            ? `the project does not compile${typeof compile.errors === "number" ? ` (${compile.errors} error(s))` : ""}, and the delivery bounce budget is spent`
            : milestone.structureRefused === true
            ? "the shipped scenes do not render the project's own art, and the structural " +
              "bounce budget is spent"
            : `delivery proofs still missing after the bounce budget: ${missingProofs.join("; ")}`.slice(0, 600);
          // A proof that is missing because this MACHINE cannot produce it
          // will be missing again in fifteen minutes: revive twice, then stop
          // and ask a person instead of looping forever (Codex 2026-09-11 C#2).
          // ANY unmeasurable proof counts: `every` meant one game-shaped
          // proof beside it reset the count and the loop ran forever (Codex
          // 2026-09-11 D#3). A round with no unmeasurable proof at all clears
          // it, so a game that starts failing for real revives as before.
          const unmeasurable = hasUnmeasurableProof(missingProofs);
          campaign.unmeasurableRevives = unmeasurable ? (campaign.unmeasurableRevives ?? 0) + 1 : 0;
          if (unmeasurable && campaign.unmeasurableRevives > MAX_UNMEASURABLE_REVIVES) {
            campaign.autoReviveAt = undefined;
            // The boot sweep re-reports a failed campaign only when its error
            // starts with NOT DELIVERED; without the prefix this stop lost its
            // notice to any crash or messenger failure (Codex 2026-09-11 D#8).
            campaign.lastError = `NOT DELIVERED — this machine cannot produce the missing proof: ${missingProofs.slice(0, 2).join("; ")}`.slice(0, 600);
            campaign.deliveryReported = false;
            this.persist(campaign);
            this.cancelLiveLineages(campaign, "campaign stopped short of delivery", { recoverable: true });
            await this.gatherIndependentReview(campaign);
            await this.tell(
              campaign,
              `${this.buildDeliveryReport(campaign)}${commitNote}\n\n` +
                "This machine cannot produce the missing proof, so retrying changes nothing: " +
                `${missingProofs.slice(0, 2).join("; ")}. Connect the verification tooling (Unity bridge, build/test runners) ` +
                "or run the campaign where it exists, then reply **kampanya devam**.",
            );
            await this.attachDeliveryEvidence(campaign);
            return;
          }
          // A DELIVERY ROUND IS CHARGED, and the charge is durable. This
          // path had no counter of its own: with a repeatable missing proof —
          // a worker that completes without ever running the suite — it
          // revived on every completion for ever. Measured by Codex
          // 2026-09-11 H#1: 100 completions, 100 submissions, no stop.
          //
          // PROGRESS STARTS THE BUDGET AGAIN: the charge is per DISTINCT set
          // of missing proofs, so a campaign that closes one proof and fails
          // on the next keeps going, and only one that repeats itself stops.
          // A STABLE signature. The first version hashed the proof SENTENCES,
          // which carry measurements: a play-through whose frame count went
          // 100, 101, 102 produced a different signature every round and the
          // budget never charged (Codex 2026-09-11 I#1). And the structural
          // refusal never entered missingProofs at all, so a campaign stuck
          // on it had the EMPTY signature and its report named no proof
          // (I#2). Kinds, not numbers.
          // The structured identity, with the prose one only as a fallback
          // for a milestone persisted before it existed.
          const signature = (milestone.deliveryFailureKinds ?? []).join(" | ")
            || proofSignature(missingProofs, { structureRefused: milestone.structureRefused === true, compileBroken });
          const repeating = campaign.deliveryProofsSignature === signature;
          campaign.deliveryRevives = repeating ? (campaign.deliveryRevives ?? 0) + 1 : 1;
          campaign.deliveryProofsSignature = signature;
          if (campaign.deliveryRevives > MAX_DELIVERY_REVIVES) {
            campaign.autoReviveAt = undefined;
            campaign.lastError = `NOT DELIVERED — ${MAX_DELIVERY_REVIVES} delivery rounds ended with the same proofs missing: ${missingProofs.slice(0, 2).join("; ")}`.slice(0, 600);
            campaign.deliveryReported = false;
            this.persist(campaign);
            this.cancelLiveLineages(campaign, "campaign stopped short of delivery", { recoverable: true });
            await this.gatherIndependentReview(campaign);
            await this.tell(
              campaign,
              `${this.buildDeliveryReport(campaign)}${commitNote}\n\n` +
                `${MAX_DELIVERY_REVIVES} delivery rounds ended with exactly the same proofs missing, so another round changes nothing: ` +
                `${missingProofs.slice(0, 2).join("; ")}. Reply **kampanya devam** to try again anyway, or change the GDD.`,
            );
            await this.attachDeliveryEvidence(campaign);
            return;
          }
          const resumeMs = this.deliveryResumeDelayMs;
          campaign.autoReviveAt = Date.now() + resumeMs;
          this.persist(campaign);
          this.cancelLiveLineages(campaign, "campaign stopped short of delivery", { recoverable: true });
          await this.gatherIndependentReview(campaign);
          await this.tell(
            campaign,
            `${this.buildDeliveryReport(campaign)}${commitNote}\n\n` +
              `The final sprint resumes by itself in ${Math.round(resumeMs / 60_000)} min with a fresh budget against this ` +
              `(delivery round ${campaign.deliveryRevives} of ${MAX_DELIVERY_REVIVES} on these proofs). ` +
              "Reply **kampanya devam** to resume now, or change the GDD if this is the game you wanted.",
          );
          this.scheduleAutoRevive(campaign.id, resumeMs, campaign.autoReviveAt);
          await this.attachDeliveryEvidence(campaign);
          return;
        }
        campaign.state = "done";
        this.cancelLiveLineages(campaign, "campaign delivered");
        // The flag is written only AFTER the report actually leaves. Audited
        // 2026-09-02: `done` was persisted first and tell() swallows an
        // outbound failure, so a crash or a messenger error in this window
        // lost the report for good — a done campaign is not active, not
        // revivable and not queryable, so nothing ever noticed.
        campaign.deliveryReported = false;
        this.persist(campaign);
        await this.gatherIndependentReview(campaign);
        if (await this.tell(campaign, `${this.buildDeliveryReport(campaign)}${commitNote}`)) {
          campaign.deliveryReported = true;
          this.persist(campaign);
        }
        await this.attachDeliveryEvidence(campaign);
        return;
      }
      // WHAT THE SCENES HOLD, EVERY SPRINT (2026-09-10). The structural
      // measurement used to run only at delivery, so nine sprints of ten were
      // never asked what they left in the shipped scenes. Disclosure here —
      // the refusal stays a delivery decision — and the next sprint's
      // <<MEASURED NOW>> block already carries the same numbers.
      try {
        milestone.structureFindings = this.measureDeliveryStructure(campaign).lines;
      } catch {
        /* measured at delivery regardless */
      }
      campaign.currentMilestone += 1;
      this.persist(campaign);
      const entryLine = milestone.structureFindings?.find((l) => l.startsWith("The entry scene ")) ?? "";
      await this.tell(
        campaign,
        `✅ ${milestone.title} — green.${commitNote}${entryLine ? ` ${entryLine}` : ""} Sprint ${campaign.currentMilestone + 1}/${campaign.milestones.length} starts now.`,
      );
      // Defer out of the event handler: submit() fires task:created and the
      // next sprint must not re-enter this handler mid-emit.
      const id = campaign.id;
      this.resubmitSoon(id);
      return;
    }

    // TIME-BOX: bounces and deferrals deliberately do not burn attempts, so a
    // sprint that keeps almost-finishing can spin indefinitely (measured
    // 2026-08-31: m6 ran 22h at attempts=1).
    // A graceful shutdown is the OPERATOR stopping the process, not the sprint
    // failing (see below); it is judged before the time box, or a routine
    // restart of a sprint past its second narrowing ended the campaign
    // (review 2026-09-07).
    const shutdownCaused = /shutting down|shutdown|durduruldu \(shutting/i.test(output);
    if (!shutdownCaused && (await this.escalateIfPastTimeBox(campaign, milestone))) return;

    const canRetry = milestone.attempts < this.maxMilestoneAttempts;
    // An outage-caused settle is not the sprint's failure: the run never got
    // to work. Charging it an attempt (measured 2026-09-01 16:16: attempts
    // 1→2 during a four-account quota wall) spends the milestone's budget on
    // the provider's downtime and pushes a healthy sprint toward a stop.
    // Checked BEFORE the blocked-nudge branch: an outage surfaces as
    // `blocked:provider_unavailable`, and that branch charged it (measured
    // 2026-09-02 02:36: m7 "blocked after 2 attempts" while all four
    // accounts were on quota walls).
    const outageCaused = isOutageCausedSettle(output, allProvidersCoolingDownMs(), msSinceNewestProviderFailure());
    // A graceful shutdown is the OPERATOR stopping the process, not the sprint
    // failing: the executor aborts in-flight runs with "shutting down" and the
    // work done so far is kept. Charging it ended a campaign on a routine
    // deploy — measured 2026-09-03 06:45: Sprint 7 "blocked after 2 attempts"
    // whose cause was a daemon restart, with no self-revival armed because it
    // was not an outage.
    // A shutdown is exempt from the ATTEMPT BUDGET ITSELF, not merely from
    // being charged: the operator stopped the process, so the sprint's last
    // attempt was never spent on work. Gating it behind canRetry meant a
    // sprint already at 2/2 was ended by a routine deploy — measured live
    // 2026-09-03 21:24, the second time the same deploy killed the same
    // campaign (audited 2026-09-03).
    if (shutdownCaused) {
      getLoggerSafe().info("Milestone resubmitted after a process shutdown — no attempt charged", {
        id: campaign.id,
        milestone: milestone.id,
        attempts: milestone.attempts,
      });
      this.submitCurrentMilestone(campaign, { countAttempt: false });
      return;
    }
    if (canRetry && outageCaused) {
      getLoggerSafe().info("Milestone resubmitted without charging an attempt", {
        id: campaign.id,
        milestone: milestone.id,
        cause: shutdownCaused ? "process-shutdown" : "provider-outage",
      });
      this.submitCurrentMilestone(campaign, { countAttempt: false });
      return;
    }
    if (canRetry && status === TaskStatus.blocked) {
      // Autonomous campaign context: a block is usually the agent asking a
      // person it was told not to need. Nudge with the mandate repeated —
      // once; a re-blocked milestone must not accumulate copies.
      const reminder =
        "\n\nREMINDER: this is an autonomous campaign sprint — do not ask the user questions; make the strong choice and continue.";
      if (!milestone.prompt.includes(reminder)) milestone.prompt += reminder;
      this.submitCurrentMilestone(campaign, { countAttempt: opts.countAttempt });
      return;
    }

    if (canRetry) {
      // The failure tail is retry CONTEXT, not history: keep exactly one, and
      // strip retry-machinery noise ("Reaped: …", "Auto-retry n/m in ~Xs")
      // that names the executor's plumbing instead of the sprint's problem.
      // NO FALLBACK to the unstripped text: `cleaned || output` put the whole
      // "Reaped: no progress signal for 60 minutes." sentence back into the
      // next sprint's prompt whenever stripping left nothing (Codex
      // 2026-09-11 G#10). Nothing left to say is nothing to say.
      const cleaned = stripRetryMachinery(output);
      // The strip must match the tail as APPENDED below. Audited 2026-09-02:
      // it ended on "do not repeat it." while the append continues "do not
      // repeat it — and do NOT spend…", so it never matched and every revived
      // budget stacked another stale tail into the persisted prompt. The
      // tempered token keeps one match from spanning two tails (rows persisted
      // before 2026-08-31 still carry the old "do not repeat it." ending).
      milestone.prompt = milestone.prompt.replace(
        /\n\nThe previous attempt ended (?:(?!\n\nThe previous attempt ended )[\s\S])*?(?:first unmet requirement\.|Fix the root cause, do not repeat it\.(?! —))/g,
        "",
      );
      milestone.prompt += `\n\nThe previous attempt ended ${status}: ${(cleaned || "no cause the executor could name").slice(0, 400)}. Fix the root cause, do not repeat it — and do NOT spend this attempt auditing prior attempts: continue the sprint's actual work from the first unmet requirement.`;
      // The art directive is not only for completions. Measured 2026-09-07:
      // five remediation attempts in a row ended blocked or failed, so the
      // completion-time art gate never spoke, and no retry ever started with
      // the recipe in front of it. Same measurement, same words, no bounce.
      const artDirective = this.placeholderArtGate(campaign, milestone);
      if (artDirective !== undefined && !milestone.prompt.includes("ART NOT PRODUCED")) {
        milestone.prompt += `\n\n${artDirective}`;
      }
      this.submitCurrentMilestone(campaign, { countAttempt: opts.countAttempt });
      return;
    }

    // A gap sprint that spent its attempts does not take the remaining gap
    // sprints with it: mark it, say so, and move to the next one. The
    // delivery report carries its ❌.
    const nextGap = campaign.milestones[campaign.currentMilestone + 1];
    if (milestone.id.startsWith("mcov") && nextGap?.status === "pending" && nextGap.id.startsWith("mcov")) {
      milestone.status = "failed";
      milestone.resultExcerpt = output.slice(-500);
      campaign.currentMilestone += 1;
      this.persist(campaign);
      getLoggerSafe().warn("Gap sprint spent its attempts — moving to the next gap", {
        id: campaign.id,
        milestone: milestone.id,
        next: nextGap.id,
      });
      await this.tell(
        campaign,
        `❌ ${milestone.title} — ${status} after ${milestone.attempts} attempts; it stays open in the delivery report. Moving on to **${nextGap.title}**.`,
      );
      this.resubmitSoon(campaign.id);
      return;
    }

    milestone.status = "failed";
    campaign.state = "failed";
    campaign.lastError = `${milestone.title} ${status} after ${milestone.attempts} attempts: ${output.slice(0, 200)}`;

    // A stop caused by a full provider outage is a scheduled wait, not a
    // defeat — park with a self-revival at the chain's recovery horizon.
    // The registry decides, never the wording alone (review 2026-09-07): a
    // sprint failing twice with "sprite provider 'local' returned PLACEHOLDER"
    // on a healthy chain armed a two-minute self-revival with a fresh attempt
    // budget each cycle — an unbounded loop the attempt budget was meant to end.
    const outageWaitMs = allProvidersCoolingDownMs();
    if (outageWaitMs > 0 || isOutageCausedSettle(output, outageWaitMs, msSinceNewestProviderFailure())) {
      const delayMs = Math.max(outageWaitMs, 60_000) + 60_000;
      campaign.autoReviveAt = Date.now() + delayMs;
      this.persist(campaign);
      this.scheduleAutoRevive(campaign.id, delayMs, campaign.autoReviveAt);
      await this.tell(
        campaign,
        `⏸️ Campaign paused by a provider outage at **${milestone.title}**.\n` +
          `Cause: ${this.outageCause(campaign.lastError ?? "")}\n` +
          `Self-revival armed for ${new Date(campaign.autoReviveAt).toLocaleTimeString()} (when the provider chain recovers). Reply **kampanya devam** to revive sooner.`,
      );
      return;
    }

    // PARTIAL DELIVERY: the sprint that ran out of attempts is a
    // coverage-remediation round (mcovN) and every PLANNED milestone is
    // green — the game itself was built. Audited 2026-09-02: this stopped
    // with "❌ Campaign stopped" and reported none of it, and never named the
    // gaps it failed to close either. Deliver, with the ladder's own ❌ line
    // and the unclosed gaps rendered by the report (so a re-send after a lost
    // report carries the same caveats).
    const plannedMilestones = campaign.milestones.filter((m) => !m.id.startsWith("mcov") && !m.id.startsWith("mfinal"));
    if (
      milestone.id.startsWith("mcov") &&
      // A CANCEL is a person stopping the work; it does not start a new
      // sprint (Codex 2026-09-11 C#1).
      status !== TaskStatus.cancelled &&
      plannedMilestones.length > 0 &&
      plannedMilestones.every((m) => m.status === "green")
    ) {
      // The remediation may have changed the game since the last sprint's
      // proofs — and it was never played, built or measured itself. Ending
      // here set `done` without any of the final gates (Codex 2026-09-11
      // B#1). A FINAL PROOF SPRINT is appended instead: it is the ladder's
      // last milestone, so the whole delivery gate judges the tree as it is.
      // QUEUED REQUIREMENTS COME FIRST. The final proof sprint is the end of
      // the ladder, and appending it while the audit's own list still had
      // entries stranded them for good (Codex 2026-09-11 I#4).
      // Deduplicated here as well as in the ordinary drain: this branch reads
      // the same persisted list (Codex 2026-09-11 J#12).
      const stillQueued = unscheduledGaps(campaign.pendingCoverageGaps ?? [], campaign.milestones);
      if (stillQueued.length > 0) {
        const round = campaign.milestones.reduce((max, m) => {
          const r = /^mcov(\d+)/.exec(m.id);
          return r ? Math.max(max, Number(r[1])) : max;
        }, 0) + 1;
        const take = stillQueued.slice(0, CampaignManager.MAX_GAP_SPRINTS_PER_ROUND);
        const rest = stillQueued.slice(take.length);
        campaign.pendingCoverageGaps = rest.length > 0 ? rest : undefined;
        milestone.status = "failed";
        milestone.resultExcerpt = output.slice(-500);
        const sprints = take.map((item, i) => this.gapSprint(campaign, round, i, item));
        // BEFORE the final proof sprint, never after it: appended at the end
        // they ran after mfinal and the ladder then declared `done` with the
        // final proofs still pending (Codex 2026-09-11 J#11). The index is
        // found by ID rather than computed, so it cannot land on the wrong
        // milestone.
        // The LAST final milestone that has not been proven: inserting before
        // the FIRST one rewound the ladder past sprints already green when an
        // older mfinal sat earlier in it (Codex 2026-09-11 K#10).
        const finalAt = campaign.milestones.findIndex(
          (m, i) => m.id.startsWith("mfinal") && m.status !== "green" && i >= campaign.currentMilestone,
        );
        if (finalAt >= 0) campaign.milestones.splice(finalAt, 0, ...sprints);
        else campaign.milestones.push(...sprints);
        const firstId = sprints[0]!.id;
        campaign.currentMilestone = campaign.milestones.findIndex((m) => m.id === firstId);
        campaign.state = "executing";
        campaign.lastError = undefined;
        // The exhausted lineage is retired before its successor starts, or it
        // stays eligible for the executor's own recovery beside it (J#12).
        this.cancelLiveLineages(campaign, "superseded by the next coverage sprint", { recoverable: true });
        this.persist(campaign);
        this.submitCurrentMilestone(campaign);
        getLoggerSafe().info("Draining queued coverage gaps before the final proof sprint", {
          id: campaign.id,
          scheduled: take.length,
          stillQueued: rest.length,
        });
        await this.tell(
          campaign,
          `⚠️ ${milestone.title} ended without closing its gap. ${take.length} requirement(s) the audit named still have no sprint — running them now.`,
        );
        return;
      }
      if (!campaign.milestones.some((m) => m.id.startsWith("mfinal"))) {
        const gaps = campaign.milestones.filter((m) => m.id.startsWith("mcov") && m.status !== "green").map((m) => m.title);
        const finalProof: CampaignMilestone = {
          id: `mfinal-${campaign.milestones.length + 1}`,
          title: "Final delivery proofs",
          prompt:
            "FINAL DELIVERY PROOFS: the coverage remediation ended and the game as it is NOW must be proven, not the game an earlier sprint saw. " +
            "Run unity_verify_change (compile), run the FULL PlayMode suite UNFILTERED, run unity_playthrough with sessions \"all\" and capture frames, " +
            "then run unity_build_player. Fix only what these measurements name. Do NOT audit; the tools' own output is the report." +
            (gaps.length > 0 ? ` Unclosed coverage gaps stay named in the report: ${gaps.slice(0, 4).join("; ")}.` : ""),
          status: "pending",
          attempts: 0,
          visualGateArmed: true,
        } as CampaignMilestone;
        campaign.milestones.push(finalProof);
        campaign.currentMilestone = campaign.milestones.length - 1;
        campaign.state = "executing";
        campaign.lastError = undefined;
        this.persist(campaign);
        // The abandoned remediation lineage is retired first: left alive, the
        // boot re-arm could retry it beside the final proofs (C#3).
        this.cancelLiveLineages(campaign, "superseded by the final proof sprint", { recoverable: true });
        // Submit BEFORE announcing: a messenger that never settles used to
        // leave the sprint appended but never submitted (C#6).
        this.submitCurrentMilestone(campaign);
        await this.tell(
          campaign,
          `⚠️ Coverage remediation ended without closing ${gaps.length || "its"} gap(s). The game is NOT delivered on that alone — a final proof sprint runs the whole delivery gate on the tree as it is now.`,
        );
        return;
      }
      // A PENDING FINAL PROOF SPRINT IS RUN, not stepped over. Reaching this
      // branch with an mfinal still pending declared `done` from the
      // structural check alone: compile, tests, build and play-through never
      // ran on the game the remediation had just changed (Codex 2026-09-11
      // K#9). Move to it instead.
      const pendingFinal = campaign.milestones.findIndex(
        (m) => m.id.startsWith("mfinal") && m.status !== "green",
      );
      if (pendingFinal >= 0) {
        milestone.status = "failed";
        milestone.resultExcerpt = output.slice(-500);
        campaign.currentMilestone = pendingFinal;
        campaign.milestones[pendingFinal]!.status = "pending";
        campaign.milestones[pendingFinal]!.attempts = 0;
        campaign.state = "executing";
        campaign.lastError = undefined;
        this.cancelLiveLineages(campaign, "superseded by the final proof sprint", { recoverable: true });
        this.persist(campaign);
        this.submitCurrentMilestone(campaign);
        getLoggerSafe().info("Coverage remediation ended — running the pending final proof sprint", {
          id: campaign.id,
          milestone: campaign.milestones[pendingFinal]!.id,
        });
        await this.tell(
          campaign,
          `⚠️ ${milestone.title} ended without closing its gap. The final proof sprint runs the whole delivery gate on the tree as it is now.`,
        );
        return;
      }
      // Measure the tree being delivered, not the one an earlier sprint saw.
      // Measured 2026-09-07 07:00: the report rendered findings stored two
      // days before ("198 sprite textures", no placeholder line) while the
      // tree on disk held 429 sprites, 410 of them placeholder-grade — and a
      // refusal that stands makes this NOT a delivery, whatever the ladder.
      const structure = this.measureDeliveryStructure(campaign);
      milestone.structureFindings = structure.lines;
      milestone.structureRefused = structure.refusal !== undefined;
      if (structure.refusal !== undefined) {
        milestone.structureFindings = [`REFUSAL STANDS at delivery: ${structure.refusal}`, ...structure.lines];
        campaign.lastError = `NOT DELIVERED — ${structure.refusal.slice(0, 200)}`;
      }
      campaign.state = structure.refusal !== undefined ? "failed" : "done";
      campaign.deliveryReported = false;
      this.persist(campaign);
      this.cancelLiveLineages(
        campaign,
        structure.refusal !== undefined ? "campaign stopped short of delivery" : "campaign delivered",
        { recoverable: structure.refusal !== undefined },
      );
      getLoggerSafe().warn("Delivering with unclosed GDD gaps — remediation sprint spent its attempts", {
        id: campaign.id,
        milestone: milestone.id,
        attempts: milestone.attempts,
        state: campaign.state,
        structureRefused: milestone.structureRefused,
      });
      await this.gatherIndependentReview(campaign);
      if (await this.tell(campaign, this.buildDeliveryReport(campaign))) {
        campaign.deliveryReported = true;
        this.persist(campaign);
      }
      return;
    }

    // AN ORDINARY FAILURE IS NOT THE END: bounded self-revival with a changed
    // approach, in one place for every path that exhausts a milestone.
    if (status !== TaskStatus.cancelled && await this.selfReviveImplementation(campaign, milestone, String(status), campaign.lastError ?? output)) {
      return;
    }

    campaign.autoReviveAt = undefined;
    campaign.lastError = `NOT DELIVERED — ${campaign.lastError ?? `${milestone.title} ${status}`}`.slice(0, 600);
    this.persist(campaign);
    await this.tell(
      campaign,
      `❌ Campaign stopped: **${milestone.title}** ended ${status} after ${milestone.attempts} attempts, ` +
        `and ${campaign.implementationRevives ?? 0} self-revival(s) with a changed approach did not get past it.\n` +
        `Cause: ${campaign.lastError}\nReply **kampanya devam** to revive it with a fresh attempt budget.`,
    );
  }

  // ===========================================================================
  // INTERNAL — helpers
  // ===========================================================================

  /**
   * Commit whatever the sprint left in the working tree, as the milestone's
   * closing commit. Returns a short note for the chat message ("" when the
   * tree was already clean or the project is not a git repo). Never throws:
   * a failed commit is reported loudly but does not wedge the ladder — the
   * defect being fixed is silent accumulation, and a warning in the channel
   * is the opposite of silent.
   */
  private async commitMilestoneWork(campaign: Campaign, milestone: CampaignMilestone): Promise<string> {
    const git = (args: string[], timeoutMs = 120_000): string =>
      execFileSync("git", ["-C", this.projectRoot, ...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
    try {
      git(["rev-parse", "--is-inside-work-tree"], 10_000);
    } catch {
      return "";
    }
    // Serialize against the other bulk writer (the lease write-back) so the
    // envelope never commits a tree that is half-way through a copy-back.
    const { acquireProjectWriteLock } = await import("../common/project-write-lock.js");
    const lock = await acquireProjectWriteLock(this.projectRoot);
    try {
      // Never stage .strada — it holds lease-conflict quarantines and vault
      // indexes; sweeping them into the user's history is how quarantined
      // project mirrors ended up committed. It is excluded from both the
      // dirtiness check and the add, or a .strada-only change would produce
      // an empty commit attempt.
      // Recordings/ is the system's capture output (and Unity Recorder's
      // folder): measured 2026-09-07 21:33, one envelope commit added 2 300
      // frames from eight capture runs to the user's history. Excluded like
      // .strada, and untracked in this commit if an earlier envelope swept it in.
      const isSystemPath = (path: string): boolean =>
        /^(?:\.strada|Recordings)(?:[/\\]|$)/.test(path);
      const dirty = git(["status", "--porcelain"], 60_000)
        .split("\n")
        .filter((line) => {
          const path = line.slice(3).replace(/^"/, "");
          return line.trim() !== "" && !isSystemPath(path);
        })
        .join("\n")
        .trim();
      if (dirty === "") return "";
      git(["add", "-A", "--", ".", ":(exclude).strada", ":(exclude)Recordings"]);
      const trackedSystemPaths = git(["ls-files", "--", ".strada", "Recordings"], 60_000).trim();
      if (trackedSystemPaths !== "") {
        git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ".strada", "Recordings"]);
        getLoggerSafe().info("Campaign envelope untracked the system's own paths", {
          id: campaign.id,
          files: trackedSystemPaths.split("\n").length,
        });
      }
      git([
        "commit",
        "-m",
        `campaign: ${milestone.title} — milestone green`,
        "-m",
        `Campaign ${campaign.id}, sprint ${campaign.currentMilestone + 1}/${campaign.milestones.length}. Working tree committed by the campaign envelope at milestone close.`,
      ]);
      const hash = git(["rev-parse", "--short", "HEAD"], 10_000).trim();
      const fileCount = dirty.split("\n").length;
      getLoggerSafe().info("Campaign milestone work committed", {
        id: campaign.id,
        milestone: milestone.id,
        hash,
        files: fileCount,
      });
      return ` Committed ${fileCount} file(s) as \`${hash}\`.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getLoggerSafe().warn("Campaign milestone commit failed — tree left dirty", {
        id: campaign.id,
        milestone: milestone.id,
        error: message,
      });
      return ` ⚠️ Could not commit the sprint's working tree (${message.slice(0, 120)}) — commit it manually before the next sprint.`;
    } finally {
      lock.release();
    }
  }

  /** Newest capture frame under Recordings/ or Assets/Art/Prerendered since
   *  the milestone's first task was created. Cheap directory scan, bounded. */
  /** Did the project repo gain any commit since this milestone's lineage began? */
  private repoChangedSince(milestone: CampaignMilestone): boolean {
    try {
      const rootId = milestone.taskId ? this.taskManager.findLineageRootId(milestone.taskId as TaskId) : null;
      const root = rootId ? this.taskManager.getStatus(rootId) : null;
      const sinceMs = root?.createdAt;
      // Unknown start time must not veto a green — the gate only fires on a
      // DEMONSTRABLY unchanged repo.
      if (!sinceMs) return true;
      // Compare the newest commit's timestamp instead of rev-list --since:
      // approxidate parsing is second-granular and inclusive, which read a
      // pre-sprint baseline commit in the same second as fresh work.
      const headTime = Number(
        execFileSync("git", ["-C", this.projectRoot, "log", "-1", "--format=%ct", "HEAD"], {
          encoding: "utf8",
          timeout: 20_000,
        }).trim(),
      );
      if (!Number.isFinite(headTime)) return true;
      return headTime * 1000 >= sinceMs;
    } catch {
      // Unknowable repo state must not veto a green — the gate exists to catch
      // a demonstrably unchanged repo, not to punish a missing git binary.
      return true;
    }
  }

  /** When this milestone's lineage began — evidence older than this was earned by another build. */
  private sprintStartMs(milestone: CampaignMilestone): number {
    // The lineage root's creation was the clock; a bounce keeps the root, so
    // a verdict earned BEFORE the bounce — before the sprint changed the game
    // again — still counted as this sprint's (Codex 2026-09-11 B#4). The
    // later of the root's creation and this ATTEMPT's start is the clock now.
    const attemptStart = milestone.attemptStartedAtMs ?? milestone.startedAtMs ?? 0;
    try {
      const rootId = milestone.taskId ? this.taskManager.findLineageRootId(milestone.taskId as TaskId) : null;
      const root = rootId ? this.taskManager.getStatus(rootId) : null;
      return Math.max(root?.createdAt ?? Date.now() - 6 * 60 * 60_000, attemptStart);
    } catch {
      return Math.max(Date.now() - 6 * 60 * 60_000, attemptStart);
    }
  }

  /** The play-through verdict for this sprint, if unity_playthrough ran since it began. */
  private measurePlaythrough(milestone: CampaignMilestone): ReturnType<typeof readPlaythroughVerdict> {
    return readPlaythroughVerdict(this.projectRoot, this.sprintStartMs(milestone), undefined, attemptRunId(milestone));
  }

  /**
   * The newest captured frame of the running game, sent as a file after a
   * delivery (or NOT DELIVERED) report. Best-effort: a channel without file
   * delivery, or a project with no frame, changes nothing about the report.
   */
  private async attachDeliveryEvidence(campaign: Campaign): Promise<void> {
    if (!this.attach) return;
    try {
      const frame = selectGameplayFrame(this.projectRoot, 0);
      if (!frame.path) return;
      const abs = frame.path; // absolute — visual-conformance reads it as such
      const size = existsSync(abs) ? statSync(abs).size : undefined;
      await this.attach(campaign.chatId, {
        type: "image",
        name: basename(frame.path),
        url: abs,
        mimeType: "image/png",
        ...(size !== undefined ? { size } : {}),
      });
    } catch (err) {
      getLoggerSafe().warn("Delivery evidence could not be attached", {
        id: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Build the player from the project root; `ran: false` when no builder is configured or it could not run. */
  private async measureBuild(campaign?: Campaign): Promise<PlayerBuildEvidence> {
    if (!this.buildPlayer) return { ran: false, detail: "no player builder is configured" };
    // The GDD's own platform, when it names one: the build used to take
    // whatever target the project had active, so a desktop player answered a
    // phone's frame-rate budget (Codex 2026-09-11 B#11).
    const platform = gddPlatform(this.gddTextOf(campaign));
    try {
      const built = await this.buildPlayer(this.projectRoot, platform.target);
      // Every platform the document asked for is NAMED, built or not: a
      // two-platform GDD used to deliver one silently (Codex 2026-09-11 F#11).
      const unbuilt = platform.targets.filter((t) => t !== platform.target);
      const withTarget = platform.target ? { ...built, requestedTarget: platform.target } : built;
      // STRUCTURED, not a sentence in `reasons`: a failed build renders only
      // its first two reasons, so the disclosure disappeared precisely when
      // the campaign still had work to do (Codex 2026-09-11 J#21).
      return unbuilt.length > 0 ? { ...withTarget, unbuiltTargets: unbuilt } : withTarget;
    } catch (err) {
      const unbuilt = platform.targets.filter((t) => t !== platform.target);
      return {
        ran: false,
        detail: `the player build could not run (${err instanceof Error ? err.message : String(err)})`,
        ...(unbuilt.length > 0 ? { unbuiltTargets: unbuilt } : {}),
        ...(platform.target ? { requestedTarget: platform.target } : {}),
      };
    }
  }

  /**
   * Play the artifact the campaign just built and read the verdict back
   * (unity_run_player writes it under Recordings/player-playthrough). Not
   * measurable — no runner configured, or the run could not start — is said.
   */
  private async measurePlayerRun(
    milestone: CampaignMilestone,
    build: PlayerBuildEvidence,
  ): Promise<PlaythroughEvidence & { unrunnableHere?: string; missingRunner?: string }> {
    // NOT `unrunnableHere`: that field waives the player run, and this early
    // return set it directly, so removing the phrase from UNRUNNABLE_HERE_RE
    // changed nothing and delivery still reached `done` with an artifact
    // nobody had run (Codex 2026-09-11 H#8, the hole in F#12). A runner this
    // deployment never configured is a missing proof that names its cause.
    if (!this.runPlayer) return { found: false, missingRunner: "no player runner is configured" };
    if (!build.artifactPath) return { found: false };
    const since = Date.now();
    let failure: string | undefined;
    try {
      await this.runPlayer(this.projectRoot, build.artifactPath);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      getLoggerSafe().warn("The built player could not be played", { milestone: milestone.id, error: failure });
    }
    const verdict = readPlaythroughVerdict(this.projectRoot, since - 1000, PLAYER_PLAYTHROUGH_VERDICT_REL, attemptRunId(milestone));
    // An .apk on a Mac is not a failed game, it is an artifact this machine
    // cannot execute — disclosed, never a refusal, and never a reason to
    // retry forever (Codex 2026-09-11 C#2).
    if (!verdict.found && failure !== undefined && UNRUNNABLE_HERE_RE.test(failure)) {
      return { ...verdict, unrunnableHere: failure.slice(0, 200) };
    }
    return verdict;
  }

  /** The GDD's numeric claims held against the play-through timing (see gdd-claims.ts). */
  /** The GDD's text, however this campaign carries it. */
  private gddTextOf(campaign?: Campaign): string | undefined {
    if (!campaign) return undefined;
    return campaign.gddText ?? (campaign.gddPath ? readGddFile(this.projectRoot, campaign.gddPath) : undefined);
  }

  private measureGddClaims(
    campaign: Campaign,
    playthrough: ReturnType<typeof readPlaythroughVerdict> | undefined,
    player?: ReturnType<typeof readPlaythroughVerdict>,
    build?: PlayerBuildEvidence,
  ): { lines: string[]; refusal?: string } {
    let gddText = campaign.gddText;
    if (!gddText && campaign.gddPath) {
      try {
        gddText = readGddFile(this.projectRoot, campaign.gddPath);
      } catch {
        gddText = undefined;
      }
    }
    // A DELIVERY WITHOUT THE DOCUMENT IS NOT A DELIVERY. This used to be a
    // disclosure line and the gate moved on, so a campaign whose GDD file had
    // disappeared reached `done` with "none were checked" and a coverage audit
    // that skipped itself for the same reason — nothing established that the
    // document the user supplied was implemented (Codex 2026-09-11 H#5).
    if (!gddText || gddText.trim() === "") {
      return {
        lines: [`GDD numbers: the GDD text was not available at delivery (${campaign?.gddPath ?? "no path"}), so none were checked`],
        refusal: `the GDD could not be read at delivery (${campaign?.gddPath ?? "no path recorded"}), so nothing here was measured against the document`,
      };
    }
    const { claims, truncated } = extractNumericClaims(gddText);
    const assessments = assessNumericClaims(claims, playthrough, player, { platform: gddPlatform(gddText), builtTarget: build?.target ?? build?.requestedTarget });
    const refusal = claimsRefusal(assessments);
    return { lines: describeClaims(assessments, truncated), ...(refusal ? { refusal } : {}) };
  }

  private freshCaptureEvidence(milestone: CampaignMilestone): { found: boolean } {
    const sinceMs = this.sprintStartMs(milestone);
    const roots = [
      join(this.projectRoot, "Recordings"),
      join(this.projectRoot, "Assets", "Art", "Prerendered"),
    ];
    let scanned = 0;
    const freshFiles: Array<{ path: string; size: number }> = [];
    const stack = roots.filter((r) => existsSync(r));
    while (stack.length > 0 && scanned < 20_000) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        scanned++;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (/\.(png|jpg|mp4)$/i.test(e.name)) {
          try {
            const st = statSync(full);
            if (st.mtimeMs >= sinceMs) freshFiles.push({ path: full, size: st.size });
          } catch {
            /* skip */
          }
        }
      }
    }
    // CONTENT CHECK — a recent file is not yet evidence. Audited 2026-08-29:
    // any fresh png passed, so a black/empty capture (or one file copied N
    // times) satisfied the gate. Tiny files are no evidence; when several
    // frames exist they must not all be byte-identical (an unchanging screen
    // "capture" is the sim-green disease this gate exists to catch).
    const meaningful = freshFiles.filter((f) => f.size > 1024);
    if (meaningful.length === 0) return { found: false };
    if (meaningful.length >= 2) {
      try {
        const digests = new Set(
          meaningful.slice(0, 12).map((f) => createHash("sha1").update(readFileSync(f.path)).digest("hex")),
        );
        if (digests.size === 1) return { found: false };
      } catch {
        /* hash pass is best-effort; recency+size already held */
      }
    }
    return { found: true };
  }

  /** How many coverage-remediation sprints may be appended before delivering as-is. */
  private static readonly MAX_COVERAGE_ROUNDS = 2;

  /**
   * Audit the finished ladder against the GDD; return a remediation milestone
   * when scheduled items are missing, undefined when coverage holds — or when
   * the audit itself cannot run (no GDD on disk, provider down, round budget
   * spent). A failed audit never wedges delivery; it is logged and skipped.
   */
  /** Gaps per remediation round; more than this is a planning failure, not a sprint list. */
  private static readonly MAX_GAP_SPRINTS_PER_ROUND = 4;

  /** One gap, one sprint — the audit's list is a ladder, not a prompt. */
  private gapSprint(campaign: Campaign, round: number, index: number, item: string): CampaignMilestone {
    const gddRef = campaign.gddPath ?? "the GDD";
    return {
      id: index === 0 ? `mcov${round}` : `mcov${round}-${index + 1}`,
      title: `Coverage completion ${round}.${index + 1} — ${item.slice(0, 60)}`,
      // The requirement IN FULL, because the title is truncated and identity
      // by prefix merged different requirements (Codex 2026-09-11 J#13).
      coverageGap: item,
      prompt: [
        `The build's milestone ladder finished, but auditing it against ${gddRef} found this scheduled item undelivered:`,
        `- ${item}`,
        "",
        `Implement it exactly as ${gddRef} specifies it, following the project's existing module pattern. This sprint is this one item; the other gaps have their own sprints.`,
        "Verification bar: headless compile green, the relevant PlayMode tests green and unfiltered, and a captured frame proving the bound visual renders (the project's style.json holds the derived art direction — generators read it).",
        "Commit per logical unit. End with a summary naming the item and the evidence it is done.",
        "This is an autonomous campaign sprint — do not ask the user questions; make the strong choice and continue.",
      ].join("\n"),
      status: "pending" as const,
      attempts: 0,
    };
  }

  private async buildCoverageRemediation(campaign: Campaign): Promise<CampaignMilestone[] | undefined> {
    // After the FINAL PROOF sprint there is no further remediation: the
    // unclosed gaps stay named in the report. Auditing again would append
    // another remediation round and, on its exhaustion, another proof sprint
    // — a loop with no end (Codex 2026-09-11 B#1 follow-up).
    // KNOWN GAPS OUTLIVE THE FINAL PROOF SPRINT. This guard used to come
    // first, so five queued requirements were stranded the moment mfinal was
    // appended and the game delivered without them (Codex 2026-09-11 I#4).
    // The queue is drained below; only a NEW audit is skipped here.
    if (campaign.milestones.some((m) => m.id.startsWith("mfinal")) && (campaign.pendingCoverageGaps ?? []).length === 0) {
      campaign.coverageAuditNote = "coverage audit not repeated after the final proof sprint — the unclosed gaps are named in the report";
      this.persist(campaign);
      return undefined;
    }
    // Rounds, not sprints: a round now appends one sprint per gap.
    const priorRounds = campaign.milestones.reduce((max, m) => {
      const round = /^mcov(\d+)/.exec(m.id);
      return round ? Math.max(max, Number(round[1])) : max;
    }, 0);
    // KNOWN GAPS FIRST, and the round budget does not apply to them: they are
    // already identified, so no audit is needed and none of them may be
    // dropped. Nine gaps used to become eight sprints and a `done` campaign
    // (Codex 2026-09-11 F#9).
    const queued = campaign.pendingCoverageGaps ?? [];
    if (queued.length > 0) {
      const round = priorRounds + 1;
      // Deduplicated as it drains: a queue persisted by an older version, or
      // by an audit that repeated itself, held ["Save", "Save"] and produced
      // two sprints for one requirement (Codex 2026-09-11 J#12).
      const distinct = unscheduledGaps(queued, campaign.milestones);
      const take = distinct.slice(0, CampaignManager.MAX_GAP_SPRINTS_PER_ROUND);
      const rest = distinct.slice(take.length);
      // NOT PERSISTED HERE. The queue shrinks and the sprints are appended in
      // the CALLER's single write: persisting the shortened queue first meant
      // a crash in that window lost every gap this round had taken off it
      // (Codex 2026-09-11 I#3).
      campaign.pendingCoverageGaps = rest.length > 0 ? rest : undefined;
      campaign.coverageAuditNote =
        rest.length > 0
          ? `${distinct.length} gaps still known; round ${round} schedules ${take.length}, and ${rest.length} stay queued: ${rest.join("; ").slice(0, 300)}`
          : undefined;
      getLoggerSafe().info("Coverage remediation drains the known gap queue", {
        id: campaign.id,
        round,
        scheduled: take.length,
        stillQueued: rest.length,
      });
      return take.map((item, i) => this.gapSprint(campaign, round, i, item));
    }
    // Every non-clean outcome is RECORDED, not collapsed into "undefined":
    // a skipped audit read exactly like a passing one in the delivery report
    // (audited 2026-09-01 — the round-budget and missing-GDD skips were
    // silent, and the doctrine comment below only covered the throw).
    if (priorRounds >= CampaignManager.MAX_COVERAGE_ROUNDS) {
      campaign.coverageAuditNote =
        `coverage audit stopped after ${CampaignManager.MAX_COVERAGE_ROUNDS} remediation rounds — ` +
        "the last rounds reported gaps that were not re-audited";
      this.persist(campaign);
      return undefined;
    }
    if (campaign.milestones.some((m) => m.id.startsWith("mfinal"))) {
      campaign.coverageAuditNote = "coverage audit not repeated after the final proof sprint — the unclosed gaps are named in the report";
      this.persist(campaign);
      return undefined;
    }
    const gddText =
      campaign.gddText ?? (campaign.gddPath ? readGddFile(this.projectRoot, campaign.gddPath) : undefined);
    if (!gddText) {
      campaign.coverageAuditNote = `coverage audit skipped — the GDD text could not be read (${campaign.gddPath ?? "no path"})`;
      this.persist(campaign);
      return undefined;
    }
    try {
      const missing = await this.planner.auditCoverage(gddText, campaign.milestones);
      if (missing.length === 0) {
        // A clean verdict names its scope. Audited 2026-09-02: past the audit
        // threshold the GDD is windowed for the audit too, and an empty
        // `missing` was recorded as "genuinely audited clean" — items living
        // only in the elided middle were undetectable and the report carried
        // no caveat.
        campaign.coverageAuditNote =
          gddText.length > GDD_AUDIT_FULL_CHARS
            ? `coverage audit ran on a WINDOWED GDD (${gddText.length} chars; the middle was reduced to an outline) — ` +
              "its clean verdict covers only what the window contained"
            : undefined; // genuinely audited clean, against the whole document
        this.persist(campaign);
        return undefined;
      }
      // ONE SPRINT PER GAP, ART FIRST. Measured 2026-09-07: one remediation
      // sprint carried "Art production …", "Audio production …" and "Story
      // and theme content …" together; four attempts, three of them narrowed
      // by the time-box to a single item that was never the art, and the
      // campaign delivered with all three gaps open. A gap is a sprint's
      // worth of work; the audit's list is a ladder, not a prompt.
      const round = priorRounds + 1;
      // ONE SPRINT PER REQUIREMENT: the planner's schema accepts a repeated
      // entry, and ["Save: absent", "Save: absent", …] produced two sprints
      // for the same work plus a third in the queue — duplicate workers that
      // can overwrite each other's implementation (Codex 2026-09-11 I#5).
      // Already-scheduled gaps are excluded too, for the same reason.
      // A requirement is covered by a sprint that is GREEN or still open, not
      // by one that failed: scheduling used to count as completion, so a
      // required feature disappeared from further repair the moment one
      // attempt had been made (Codex 2026-09-11 J#13).
      const unique = unscheduledGaps(missing, campaign.milestones, { reopenCompleted: true });
      if (unique.length === 0) {
        campaign.coverageAuditNote = `coverage audit repeated ${missing.length} gap(s) that already have sprints`;
        this.persist(campaign);
        return undefined;
      }
      const ordered = [...unique].sort((a, b) => Number(isArtGap(b)) - Number(isArtGap(a)));
      const shown = ordered.slice(0, CampaignManager.MAX_GAP_SPRINTS_PER_ROUND);
      const overflow = ordered.slice(shown.length);
      if (overflow.length > 0) {
        // QUEUED, not "waiting for the next audit": the next audit may never
        // come, and the gap is already known (Codex 2026-09-11 F#9).
        // Queued in MEMORY; the caller's write commits it together with the
        // sprints this round appends (Codex 2026-09-11 I#3).
        campaign.pendingCoverageGaps = overflow;
        campaign.coverageAuditNote =
          `coverage audit found ${ordered.length} gaps; round ${round} schedules the first ${shown.length} and ` +
          `${overflow.length} are queued for the following round(s): ${overflow.join("; ").slice(0, 300)}`;
      }
      return shown.map((item, i) => this.gapSprint(campaign, round, i, item));
    } catch (err) {
      getLoggerSafe().warn("Coverage audit failed — delivering without it", {
        id: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // The skip must reach the person, not only the log — a silently
      // unaudited delivery reads exactly like an audited one.
      campaign.coverageAuditNote = `coverage audit could not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
      this.persist(campaign);
      return undefined;
    }
  }

  /**
   * What the shipped scenes actually contain, plus the GDD's own
   * dimensionality against them. Delivery-only; never called mid-ladder,
   * because an early sprint must not be judged against work scheduled for a
   * later one. A failure to measure is RECORDED, never swallowed — a skipped
   * check must not read like a passed one. Audited 2026-09-03.
   */
  /** Literal text as a regex source — the markers hold `<`, `>` and `—`. */
  private static escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Delimits the re-measured structure block so a resubmit replaces it. */
  /** "ALSO, ALREADY MEASURED: …" up to the next blank line — the pre-2026-09-08 gate blocks carried it. */
  private static readonly LEGACY_STRUCTURE_SENTENCE_RE = /\n\nALSO, ALREADY MEASURED: [^\n]*(?:\n(?!\n)[^\n]*)*/g;
  private static readonly STALE_REFUSAL_PARAGRAPH_RE =
    /\n\nDELIVERY REFUSED — THE GAME IS NOT BUILT AS THE GDD SPECIFIES:[\s\S]*?(?=\n\n|$)/g;
  private static readonly STRUCTURE_OPEN = "<<MEASURED NOW — what the shipped scenes render>>";
  private static readonly STRUCTURE_CLOSE = "<</MEASURED NOW>>";
  /** How much of the measurement the prompt carries before it says it trimmed. */
  private static readonly STRUCTURE_MAX_CHARS = 3_400;

  /**
   * Put the CURRENT structural measurement in the final sprint's prompt, on
   * every submit.
   *
   * Measured 2026-09-04 10:32: the refusal ("the shipped scenes render
   * NOTHING … 100 prefabs, 62 models and 198 sprites no enabled scene
   * reaches") was computed only inside the delivery-gate bounce, so the
   * persisted m7 prompt held none of it — no "render NOTHING", no
   * CreatePrimitive, no unbound art. Every sprint resubmitted by an outage, a
   * self-revival, a time-box escalation or a restart therefore ran as blind
   * as the seven before it, and each one answered by writing a document.
   *
   * Re-measured rather than cached: the whole point is to tell the sprint
   * what the tree looks like NOW, including what its own last attempt
   * changed. The previous block is stripped first, so a revived campaign
   * carries one measurement and not a stack of stale ones — the same defect
   * the previous-attempt tail already had (audited 2026-09-02).
   */
  private attachStructureMeasurement(campaign: Campaign, milestone: CampaignMilestone): void {
    const open = CampaignManager.STRUCTURE_OPEN;
    const close = CampaignManager.STRUCTURE_CLOSE;
    let stripped = milestone.prompt
      .replace(
        new RegExp(`\\n*${CampaignManager.escapeRegExp(open)}[\\s\\S]*?${CampaignManager.escapeRegExp(close)}`, "g"),
        "",
      )
      // A structural sentence an older gate block left behind is a second,
      // stale measurement next to this one (measured 2026-09-08 05:25, see the
      // bounce path): the paragraph goes, this block is the measurement.
      .replace(CampaignManager.LEGACY_STRUCTURE_SENTENCE_RE, "");
    let structure: { refusal?: string; lines: string[] };
    try {
      structure = this.measureDeliveryStructure(campaign);
    } catch {
      // measureDeliveryStructure already degrades to a disclosure; a throw
      // here must not cost the sprint its prompt.
      milestone.prompt = stripped;
      return;
    }
    // Most actionable first, so a trim takes the least important lines.
    // Measured 2026-09-07 14:23: the block for the coverage sprint was cut at
    // its budget before "Project art: … 410 of the 429 sprite textures are
    // placeholder-grade" — the one line the art sprint exists to act on.
    // A bounce's "DELIVERY REFUSED … <refusal>" paragraph must say what is
    // refused NOW: rewritten to the fresh refusal while the gate still
    // refuses, dropped once it passes. Left alone, a revive carried "OLD:
    // render NOTHING" beside "NOW: six renderers" (Codex review 2026-09-08).
    stripped = stripped.replace(CampaignManager.STALE_REFUSAL_PARAGRAPH_RE, (paragraph) =>
      structure.refusal
        ? paragraph.replace(/(THE GAME IS NOT BUILT AS THE GDD SPECIFIES:)[^\n]*/, `$1 ${structure.refusal}`)
        : "",
    );
    const inventory = structure.lines.filter((l) => /^Project (art|audio):/.test(l));
    const rest = structure.lines.filter((l) => !/^Project (art|audio):/.test(l));
    const body = [structure.refusal ? `REFUSED: ${structure.refusal}` : undefined, ...inventory, ...rest]
      .filter((l): l is string => typeof l === "string" && l.length > 0)
      .join("\n- ");
    if (body.length === 0) {
      milestone.prompt = stripped;
      return;
    }
    // No silent cap: a trimmed measurement says it was trimmed, or the sprint
    // reads a truncated list as the whole truth.
    let shown = body;
    if (body.length > CampaignManager.STRUCTURE_MAX_CHARS) {
      // Cut on a line boundary, not mid-word: the first render of this block
      // ended "- Camera projection in the shi", which reads as a corrupted
      // measurement rather than a trimmed one. Falls back to the hard cut
      // when a single line is itself longer than the budget.
      const head = body.slice(0, CampaignManager.STRUCTURE_MAX_CHARS);
      const lastBreak = head.lastIndexOf("\n- ");
      shown =
        `${lastBreak > 0 ? head.slice(0, lastBreak) : head}\n` +
        "- (measurement trimmed here; re-run the structural check yourself for the rest)";
    }
    milestone.prompt =
      `${stripped}\n\n${open}\n- ${shown}\n` +
      "This is a file-level measurement of the tree as it stands, not a review of your plan. " +
      "If it says the scenes render nothing, binding the project's own prefabs into the entry scene " +
      "is the sprint's work — not a document about it.\n" +
      // The same directive the gate-bounce paths carry. It lived ONLY there,
      // so a sprint revived by an outage never saw it — measured live
      // 2026-09-04 14:12: with the measurement in its prompt and no
      // anti-audit line, the sprint planned "read the GDD in full" and "audit
      // the landed modules" first, hit the decomposition node cap, and left
      // "Produce real art-backed presentation and asset bindings" UNEXPANDED.
      // It never reached the work it had correctly identified.
      "DO NOT AUDIT. Counting or listing what exists is not the task, and an inventory will be " +
      "rejected. Do not re-read the whole GDD or re-audit the landed modules before acting: this " +
      "measurement is that audit, already done. Spend the sprint on the change itself — open the " +
      "entry scene, place the named prefabs in it (unity_place_prefab), bind real sprites to their " +
      "renderers (unity_bind_sprite) instead of engine primitives, save the scene, and let a captured frame and the " +
      "unfiltered suite be your report. Art comes from the purchased library (unity_my_assets_cloud " +
      "'purchases' → 'download' → unity_import_asset_package) or the generators, which use the installed " +
      "local model by default — unity_generate_sprite draws up to 12 named sprites per call with `batch` " +
      "(one model load, ~50 s each), unity_generate_mesh for dimensional props, unity_generate_audio for " +
      "SFX presets and music loops. A result marked PLACEHOLDER or ✗ is not the element's visual.\n" +
      // Measured 2026-09-06 23:14: 45 minutes into a sprint told DO NOT AUDIT,
      // discovery was file_read/list_directory/code_search_rag — and zero
      // vault_search, against an indexed 84 MB project vault. The tool's own
      // description says "PRIMARY … use BEFORE file_read"; a description is
      // not enough, so the sprint is told here too.
      "DISCOVERY: the project is indexed — query vault_search (project vault, hybrid) first for any " +
      "symbol, module or prefab you need to find; use file_read only for exact contents of a file you " +
      "already know. Do not walk directories to learn the codebase.\n" +
      `${close}`;
  }

  /**
   * Does the project compile right now?
   *
   * Never throws and never guesses: a missing verifier, or one that fails on
   * its own plumbing, answers `ran: false`, which the report renders as NOT
   * MEASURED. Treating "we could not ask" as "it compiles" is the exact shape
   * of the false green this gate exists to stop.
   */
  private async measureCompile(): Promise<CompileVerdict> {
    if (!this.verifyCompile) {
      return { ok: false, ran: false, detail: "no compile verifier is configured" };
    }
    try {
      return await this.verifyCompile(this.projectRoot);
    } catch (err) {
      return {
        ok: false,
        ran: false,
        detail: `the compile check could not run (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  /** The project's sprite count and placeholder-grade count, or undefined when the scan could not run. */
  private measurePlaceholderArt(campaign: Campaign): { sprites: number; placeholders: number } | undefined {
    try {
      const report = assessBuiltAsSpecified(this.projectRoot);
      if (!report.measured) return undefined;
      return { sprites: report.artInventory.sprites, placeholders: report.artInventory.placeholderSprites };
    } catch (err) {
      getLoggerSafe().warn("Placeholder-art measurement could not run", {
        id: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * The directive for a remediation sprint that reported completion while the
   * project's placeholder-grade sprite count did not drop — or undefined when
   * the gate does not apply (no baseline, art was not placeholder art to begin
   * with, or the count did drop). Strong case only, as in built-as-specified:
   * at least 10 sprites and 80% of them placeholder-grade at the start.
   */
  private placeholderArtGate(campaign: Campaign, milestone: CampaignMilestone): string | undefined {
    if (!milestone.id.startsWith("mcov")) return undefined;
    // Only a sprint whose gap IS art is judged by the sprite count. Review
    // 2026-09-07: an audio-only remediation sprint did its audio work, left
    // the sprites alone (correctly), and was bounced with "ART NOT PRODUCED".
    const items = coverageGapItems(milestone);
    if (items.length > 0 && !items.some(isArtGap)) return undefined;
    const start = milestone.placeholderArtAtStart;
    if (!start || start.sprites < 10 || start.placeholders / start.sprites < 0.8) return undefined;
    // …and never against a document that ASKED for flat art: the pixel
    // heuristic cannot tell a minimalist style from unmade art, and this
    // bounce would demand it be replaced (Codex 2026-09-11 B#17).
    // The whole document, not only a long-enough "Art Direction" section: the
    // extractor rejects a section under 200 characters and the exemption then
    // never reached a legitimately minimal GDD (Codex 2026-09-11 C#19).
    const gddText = this.gddTextOf(campaign) ?? "";
    const look = extractLookDescription(gddText);
    const artDirection = artDirectionText(look, gddText) ?? "";
    if (asksForFlatArt(artDirection)) return undefined;
    const now = this.measurePlaceholderArt(campaign);
    if (!now) return undefined;
    // Real art added under NEW names counts as much as a placeholder replaced.
    // Measured 2026-09-07 15:15: the first sprint to draw real sprites wrote
    // Ufo.png and SeatRed.png beside the 410 placeholders — the placeholder
    // count alone would have bounced the one attempt that did the work.
    const realBefore = start.sprites - start.placeholders;
    const realNow = now.sprites - now.placeholders;
    if (now.placeholders < start.placeholders || realNow > realBefore) return undefined;
    return (
      `ART NOT PRODUCED: when this sprint began, ${start.placeholders} of ${start.sprites} sprite textures were ` +
      `placeholder-grade (flat shapes by their pixels: ${PLACEHOLDER_GRADE_RULE}); now it is ` +
      `${now.placeholders} of ${now.sprites}. Compiling, verifying and documenting did not change the art. ` +
      "Produce real art NOW, before anything else: unity_generate_sprite with provider \"local\" (the installed " +
      "model draws a real sprite in under a minute). Call it with the SAME name and the SAME path as the placeholder " +
      "file: that overwrites the placeholder and keeps its .meta GUID, so every binding survives and no bind call is " +
      "needed — a new file beside the placeholder (e.g. <Name>_Real.png) leaves this count unchanged. Or " +
      "unity_my_assets_cloud action \"purchases\" → \"download\" → unity_import_asset_package for owned packs. " +
      "Then bind what you made. This sprint is judged by that count dropping, not by a report."
    );
  }

  /** The newest play-through's runtime scene dump, for the structural check (see built-as-specified opts.runtime). */
  private latestRuntimeEvidence(campaign: Campaign): import("../agents/autonomy/built-as-specified.js").RuntimeSceneEvidence | undefined {
    // Only the CURRENT sprint's play-through, and only when it played to an
    // outcome: an earlier sprint's dump showing sprites withdrew the "render
    // NOTHING" refusal over a scene emptied since (Codex 2026-09-11 B#5).
    const current = (campaign.milestones ?? [])[campaign.currentMilestone];
    const v = current?.playthroughVerdict;
    return v?.found && v.ok === true ? v.runtime : undefined;
  }

  private measureDeliveryStructure(campaign: Campaign): { refusal?: string; lines: string[] } {
    try {
      // The GDD's own dimensionality against the scenes (audited 2026-09-03):
      // it asked for "plump, glossy 3D-feel pigs" and nothing ever checked.
      // DELIVERY is judged against the whole GDD, so the whole text is read.
      const gddText =
        campaign.gddText ?? (campaign.gddPath ? readGddFile(this.projectRoot, campaign.gddPath) : undefined);
      // …and its art direction decides whether flat artwork is a defect or the
      // style the document asked for (Codex 2026-09-11 B#17).
      const look = gddText ? extractLookDescription(gddText) : undefined;
      const report = assessBuiltAsSpecified(this.projectRoot, undefined, {
        runtime: this.latestRuntimeEvidence(campaign),
        // The WHOLE DOCUMENT when its art-direction section is too short to
        // pass extractLookDescription's prose floor. "Minimalist flat
        // geometric art: use solid colored squares." is 44 characters, and
        // dropping it refused the ten flat sprites the document asked for —
        // forever, since the repair is to replace the requested style (Codex
        // 2026-09-11 F#3). The same fallback the numeric-claims path uses.
        ...(artDirectionText(look, gddText) !== undefined
          ? { artDirection: artDirectionText(look, gddText)! }
          : {}),
      });
      // Sound, motion and effects (2026-09-10): the GDD's cue list and
      // animation brief against what the shipped scenes carry. Refuses only
      // the strong audio case (clips exist, no shipped scene reaches one).
      const media = describeMedia(gddText, report);
      const lines = [...report.disclosures, ...describeDimensionality(gddText, report).lines, ...media.lines];
      // No silent caps: when the unmeasured list is trimmed, the trim says so.
      const shown = report.incomplete.slice(0, 5);
      for (const note of shown) lines.push(`NOT measured: ${note}`);
      if (report.incomplete.length > shown.length) {
        lines.push(`NOT measured: +${report.incomplete.length - shown.length} further item(s), same scan`);
      }
      // THE GDD'S OWN SCHEDULE. spec-scope parses the element table and looks
      // for each element in the code; it had two consumers (a self-test and the
      // conformance guard) and the campaign never asked it (audited
      // 2026-09-10). A scheduled element the code never mentions is an
      // objective gap, and delivering without it is delivering another game.
      let refusal = report.refusal ?? media.refusal;
      const scope = assessSpecScope(this.projectRoot, campaign.gddPath ? join(this.projectRoot, campaign.gddPath) : undefined);
      if (scope.scheduled > 0) {
        if (scope.missing.length === 0) {
          lines.push(`GDD element schedule: all ${scope.scheduled} scheduled element(s) have a trace in code`);
        } else {
          const named = scope.missing.slice(0, 8).map((e) => `${e.unlock} ${e.name}`).join(", ");
          const more = scope.missing.length > 8 ? `, +${scope.missing.length - 8} more` : "";
          lines.push(`GDD element schedule: ${scope.missing.length} of ${scope.scheduled} scheduled element(s) have NO trace in code: ${named}${more}`);
          refusal ??=
            `the GDD schedules ${scope.missing.length} element(s) the code never mentions (${named}${more}) — ` +
            "a delivery without them is not the game the GDD specifies";
        }
      }
      return { refusal, lines };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      getLoggerSafe().warn("Structural delivery check could not run", { id: campaign.id, error: detail });
      return {
        lines: [
          `⚠️ the structural check of the shipped scenes could NOT run (${detail.slice(0, 160)}) — ` +
            "nothing was measured about what the delivered game renders",
        ],
      };
    }
  }

  /**
   * Ask the independent reviewer before a delivery report goes out, with the
   * campaign's own measurements in hand. Stored on the campaign so a re-sent
   * report carries the same opinion; a reviewer that cannot run is recorded
   * as unavailable — the report must never read as reviewed when it was not.
   */
  private async gatherIndependentReview(campaign: Campaign): Promise<void> {
    // Explicit opt-in: production wires the Codex runner at bootstrap; a
    // manager built without one (tests, embedded use) says so in the report.
    const reviewer = this.independentReviewer ?? null;
    if (reviewer === null) {
      campaign.independentReview = { ok: false, model: "none", text: "", ms: 0, error: "disabled by configuration" };
      this.persist(campaign);
      return;
    }
    const structural = [...campaign.milestones].reverse().find((m) => m.structureFindings?.length);
    const prompt = deliveryReviewPrompt({
      gddPath: campaign.gddPath,
      measurements: structural?.structureFindings ?? ["(no structural measurement recorded)"],
      ladder: campaign.milestones.map((m) => `${m.id} ${m.title}: ${m.status}`),
    });
    try {
      campaign.independentReview = await reviewer({ projectRoot: this.projectRoot, prompt });
    } catch (err) {
      campaign.independentReview = { ok: false, model: "unknown", text: "", ms: 0, error: err instanceof Error ? err.message : String(err) };
    }
    this.persist(campaign);
    const review = campaign.independentReview;
    getLoggerSafe().info("Independent delivery review", {
      id: campaign.id,
      ok: review?.ok,
      model: review?.model,
      ms: review?.ms,
      error: review?.error,
    });
  }

  private buildDeliveryReport(campaign: Campaign): string {
    // EVIDENCE, not stored booleans. The report used to render only
    // milestone.status — while the manager held commit hashes, capture
    // counts, test verdicts and every bounce/escalation and threw them away
    // (audited 2026-09-01). A green reached by spending its evidence bounce
    // must not read like a clean one.
    const caveats: string[] = [];
    // A delivery that carries an unfinished sprint says so in its FIRST line.
    // Audited 2026-09-02: partial delivery (a spent coverage-remediation
    // round after every planned sprint went green) had no rendering at all.
    const unfinished = campaign.milestones.filter((m) => m.status !== "green");
    // The HEADLINE must say what the evidence says. Measured live 2026-09-04
    // 21:37: "🏁 Campaign delivery — game built" sat directly above "REFUSAL
    // STANDS … The shipped scenes render NOTHING". The findings were right and
    // the first line a person reads was not.
    // The NEWEST measurement decides the headline (review 2026-09-07): a
    // refusal from an earlier sprint that a later one resolved must not
    // headline a delivered game, and a tree that does not compile must not
    // headline as complete.
    const newestStructural = [...campaign.milestones].reverse().find((m) => m.structureFindings?.length);
    const structureRefused = newestStructural?.structureRefused === true;
    const compiled = [...campaign.milestones].reverse().find((m) => m.compileVerdict?.ran);
    const compileBroken = compiled?.compileVerdict?.ran === true && compiled.compileVerdict.ok === false;
    const finalMilestone = campaign.milestones[campaign.milestones.length - 1];
    const proofsMissing = campaign.state !== "done" ? finalMilestone?.deliveryProofsMissing ?? [] : [];
    const lines = [
      structureRefused
        ? `⛔ **NOT DELIVERED — the shipped scenes do not render the project's own art**`
        : proofsMissing.length > 0 && !compileBroken
        ? `⛔ **NOT DELIVERED — the final sprint's proofs are missing: ${proofsMissing.slice(0, 2).join("; ").slice(0, 240)}${proofsMissing.length > 2 ? "; …" : ""}**`
        : compileBroken
        ? `⛔ **NOT DELIVERED — the project does not compile${
            typeof compiled?.compileVerdict?.errors === "number" ? ` (${compiled.compileVerdict.errors} error(s))` : ""
          }**`
        : unfinished.length === 0
        ? `🏁 **Campaign delivery — game build complete**`
        : `🏁 **Campaign delivery — game built, ${unfinished.length} sprint${unfinished.length > 1 ? "s" : ""} did NOT land green**`,
      `GDD: \`${campaign.gddPath ?? "n/a"}\``,
      ``,
    ];
    for (const [i, m] of campaign.milestones.entries()) {
      const marks: string[] = [];
      if (m.commitNote) marks.push(m.commitNote.replace(/^\s*/, ""));
      if (m.testVerdict) marks.push(`tests: ${m.testVerdict.slice(0, 80)}`);
      // The delivery gate is one-shot by design; a green reached by spending
      // it, or a final sprint with no observed test run at all (a revived
      // gate, a remediation round), must not read like a verified one.
      // Audited 2026-09-02: this flag was written and never rendered — the
      // waived sprint showed as a clean ✅ with no mark and no caveat.
      const isFinal = i === campaign.milestones.length - 1;
      if (m.deliveryVerificationBounced) marks.push("delivery-verification bounce spent");
      if (!isFinal && m.playthroughVerdict?.found) {
        marks.push(describePlaythrough(m.playthroughVerdict).slice(0, 160));
      }
      if (isFinal) {
        const line = describePlaythrough(m.playthroughVerdict);
        if (m.playthroughVerdict?.found && m.playthroughVerdict.ok) marks.push(line);
        else caveats.push(`${m.title}: ${line}`);
        if (m.playthroughVerdict?.found && m.playthroughVerdict.autoStarted === false) {
          caveats.push(`${m.title}: the game does not start play by itself after boot — a person opening the entry scene sees an idle screen`);
        }
        if (m.playerPlaythrough?.found) {
          const line = `inside the built player: ${describePlaythrough(m.playerPlaythrough)}`;
          if (m.playerPlaythrough.ok) marks.push(line);
          else caveats.push(`${m.title}: ${line}`);
        }
        // The GDD's numbers: a MET line is a mark, everything else a caveat —
        // "not measured" included, so a report never reads as if it checked.
        for (const line of m.gddClaims ?? []) {
          if (/: MET — /.test(line)) marks.push(line);
          else caveats.push(`${m.title}: ${line}`);
        }
      }
      if (!m.testVerdict && (isFinal || m.deliveryVerificationBounced)) {
        marks.push("NO observed test run");
        caveats.push(
          `${m.title}: went green with NO observed test run — the full suite was never seen to pass` +
            (m.deliveryVerificationBounced ? " (its delivery-verification bounces were spent)" : ""),
        );
      } else if (m.testVerdict && m.testVerdictUnfiltered !== true && (isFinal || m.deliveryVerificationBounced)) {
        // A filtered green is the sprint choosing which tests count. Saying
        // only "tests: …" would read as the suite passing (audited 2026-09-03).
        marks.push("green from a FILTERED run");
        caveats.push(
          `${m.title}: its green test run was filtered, not the whole suite — ` +
            `what the rest of the suite does was never observed (\`${m.testVerdict.slice(0, 80)}\`)`,
        );
      }
      if (m.testFailures && m.testFailures.length > 0) {
        const more = m.testFailuresOmitted ? ` (+${m.testFailuresOmitted} more)` : "";
        caveats.push(
          `${m.title}: the suite reported these tests FAILING — ${m.testFailures.join(", ")}${more}`,
        );
      }
      if (m.visualEvidenceBounced) { marks.push("visual-evidence bounce spent"); caveats.push(`${m.title}: needed a second attempt to produce a captured frame`); }
      // The compiler's own answer, on every final-sprint line. "Not measured"
      // is printed, never omitted: a delivery whose tree was never compiled
      // must not read like one that was (audited 2026-09-04).
      if (m.compileVerdict) {
        const c = m.compileVerdict;
        if (!c.ran) {
          marks.push("compile NOT measured");
          caveats.push(
            `${m.title}: the project was never compiled at the delivery gate — ${c.detail ?? "no verifier"}`,
          );
        } else if (!c.ok) {
          marks.push(`DOES NOT COMPILE${typeof c.errors === "number" ? ` (${c.errors} errors)` : ""}`);
          caveats.push(`${m.title}: the project did not compile — ${c.detail ?? "no detail"}`);
        } else {
          marks.push("compiles");
        }
      }
      // The artifact, on every final-sprint line: built (path, size), failed,
      // or NOT MEASURED — an editor project that compiles is not a delivery.
      if (m.buildVerdict) {
        const b = m.buildVerdict;
        if (!b.ran) {
          marks.push("player build NOT measured");
          caveats.push(`${m.title}: no player was built at the delivery gate — ${b.detail ?? "no builder"}`);
        } else if (!b.ok) {
          marks.push("PLAYER BUILD FAILED");
          caveats.push(`${m.title}: the player build failed — ${(b.reasons ?? []).slice(0, 3).join("; ") || b.detail || "no reason recorded"}`);
        } else {
          marks.push(
            `delivery artifact: ${b.artifactPath ?? "?"} (${b.target ?? "?"}, ${((b.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1)} MB${
              typeof b.durationMs === "number" ? `, built in ${Math.round(b.durationMs / 1000)} s` : ""
            })`,
          );
        }
      }
      if (m.assetSourcingBlind) {
        marks.push("asset sourcing BLIND");
        caveats.push(
          `${m.title}: the Unity account link was dead, so the purchased library was unreachable — ` +
            `${m.assetSourcingBlind} (run \`strada unity-link\`)`,
        );
      }
      if (m.visualEvidence === "observed") marks.push("captured frame observed");
      if (m.visualEvidence === "none-gate-not-demanded") {
        marks.push("no captured frame; visual gate NOT run");
        caveats.push(`${m.title}: no fresh captured frame was observed and the visual gate never ran — the sprint prompt never demanded a capture`);
      }
      if (m.visualEvidence === "none-gate-spent") {
        marks.push("no captured frame after the bounce");
        caveats.push(`${m.title}: went green after its visual bounce with STILL no fresh captured frame`);
      }
      if (m.noWorkBounced) { marks.push("no-work bounce spent"); caveats.push(`${m.title}: an attempt left the repository untouched`); }
      // The scene-hygiene gate ran out of bounces and delivery went ahead —
      // never silently (audited 2026-09-03).
      if (m.sceneHygieneUnresolved) {
        marks.push("no entry scene");
        caveats.push(
          `${m.title}: delivered with NO scene a person can open — ${m.sceneHygieneUnresolved}` +
            ` (the scene-hygiene gate bounced it ${m.sceneHygieneBounces ?? 0}× and ran out of attempts)`,
        );
      }
      if ((m.timeBoxEscalations ?? 0) > 0) { marks.push(`scope narrowed ×${m.timeBoxEscalations}`); caveats.push(`${m.title}: ran past its time box and was narrowed to a smaller increment — remaining scope is in its final report`); }
      if (m.attempts > 1) marks.push(`${m.attempts} attempts`);
      if (m.status !== "green") {
        marks.push(`did NOT land green (${m.attempts} attempts)`);
        const gaps = coverageGapItems(m);
        caveats.push(
          gaps.length > 0
            ? `${m.title}: unclosed — the GDD items it was appended to close are NOT delivered: ${gaps.join("; ")}`
            : `${m.title}: unclosed — its scope is NOT delivered. Cause: ${campaign.lastError ?? "not recorded"}`,
        );
      }
      lines.push(`• ${m.status === "green" ? "✅" : "❌"} ${m.title}${marks.length > 0 ? ` — ${marks.join("; ")}` : ""}`);
    }
    const frames = this.countCaptureFiles();
    lines.push("", `Captured frames on disk: ${frames}`);

    // HOW TO RUN IT. Measured 2026-09-03: the delivered project carried 20
    // scenes, 14 of them enabled in the build, most of them single-purpose
    // verification scaffolding — and the report never said which one is the
    // game. A person cannot open a delivery they cannot find.
    // The look disclosure rides with the entry-point block: both answer "what
    // did you actually deliver", and a missing one must be visible.
    const look = [...campaign.milestones].reverse().find((m) => m.visualConformance)?.visualConformance;
    if (look) lines.push("", look);
    const entry = this.describeEntryPoint();
    if (entry) lines.push("", entry, this.writeHowToRun(campaign));
    // What the shipped scenes actually contain — measured, not inferred from
    // the ladder. Audited 2026-09-03: 7/7 green and 11351 frames said nothing
    // about a delivery whose scenes held no renderer at all.
    lines.push("", ...renderSecondOpinion(campaign.independentReview));
    const structural = [...campaign.milestones].reverse().find((m) => m.structureFindings?.length);
    if (structural?.structureFindings) {
      lines.push("", "**What the shipped scenes actually contain:**", ...structural.structureFindings.map((l) => `- ${l}`));
      if (structural.structureRefused) {
        caveats.push(
          "the structural check REFUSED this delivery — the shipped scenes are not built the way the GDD specifies " +
            "(see 'What the shipped scenes actually contain')",
        );
      }
    } else {
      lines.push("", "⚠️ The shipped scenes were NOT structurally checked — nothing here says what the game renders.");
    }
    if (campaign.coverageAuditNote) {
      lines.push("", `⚠️ ${campaign.coverageAuditNote} — delivered WITHOUT a clean GDD-coverage check.`);
    }
    if (caveats.length > 0) {
      lines.push(
        "",
        unfinished.length === 0
          ? "**How these greens were reached:**"
          : "**What is unclosed, and how these greens were reached:**",
        ...caveats.map((c) => `- ${c}`),
      );
    }
    return lines.join("\n");
  }

  /**
   * The scene a person should open, and everything else the delivery left
   * enabled in Build Settings.
   *
   * The measurement moved into scene-hygiene.ts (audited 2026-09-03) so the
   * SAME numbers drive three consumers that must not disagree: this report
   * block, the delivery refusal, and HOW_TO_RUN.md. It also stopped being
   * silent when nothing can be measured — "which scene to open was NOT
   * measured" is a disclosure; saying nothing reads exactly like a build with
   * one obvious entry scene, which is the failure the user actually hit.
   */
  private describeEntryPoint(): string {
    return renderSceneHygiene(assessSceneHygiene(this.projectRoot));
  }

  /**
   * Write HOW_TO_RUN.md at the project root and return the report line that
   * names it.
   *
   * Measured 2026-09-03: the delivered tree had 20 scenes, no README of any
   * kind, and the delivery report — a chat message that scrolls away — was
   * the only thing that ever said which scene to open. The project itself
   * said nothing to the person who opened it.
   *
   * Every field is MEASURED here and nowhere else: the Unity version off
   * ProjectVersion.txt, the entry scene and the scaffolding off the same
   * scene-hygiene scan the report renders, the play instructions off the
   * GDD's own core-mechanic field, the suite off the final milestone's
   * recorded verdict. Nothing is inferred; an unmeasured field is written as
   * "Unknown — <why>". The file is left in the working tree rather than
   * committed: it is regenerated on every report (including a re-send after a
   * restart), and a commit per re-send would be noise in the user's history.
   */
  private writeHowToRun(campaign: Campaign): string {
    const hygiene = assessSceneHygiene(this.projectRoot);
    const version = readUnityVersion(this.projectRoot);

    // The GDD ON DISK, not campaign.gddText: the stored copy is the intake
    // snapshot and may be truncated, and the campaign may have redrafted.
    let gddText: string | undefined;
    let gddNote: string | undefined;
    if (campaign.gddPath) {
      try {
        gddText = readFileSync(join(this.projectRoot, campaign.gddPath), "utf8");
      } catch (err) {
        gddNote = `\`${campaign.gddPath}\` could not be read (${err instanceof Error ? err.message : String(err)})`;
      }
    } else {
      gddNote = "no GDD path was recorded for this campaign";
    }
    gddText ??= campaign.gddText;
    const coreLoop = gddText === undefined ? undefined : extractCoreLoop(gddText);
    if (coreLoop === undefined && gddNote === undefined) {
      gddNote = `${campaign.gddPath ?? "the GDD"} names no core-mechanic field this could quote`;
    }

    const finalMilestone = campaign.milestones[campaign.milestones.length - 1];
    const verdict = finalMilestone?.testVerdict;
    const relPath = "HOW_TO_RUN.md";
    const text = renderHowToRun({
      projectRoot: this.projectRoot,
      unityVersion: version.version,
      unityVersionNote: version.note,
      entryScene: hygiene.entry?.path,
      entryObjects: hygiene.entry?.objects,
      entryNote: hygiene.refusal?.detail ?? hygiene.note,
      scaffolding: hygiene.scaffolding.map((s) => s.path),
      unclassified: hygiene.unclassified.map((s) => s.path),
      otherEnabled: hygiene.otherEnabled,
      coreLoop,
      coreLoopNote: gddNote,
      gddPath: campaign.gddPath,
      suiteVerdict: verdict,
      suiteUnfiltered: finalMilestone?.testVerdictUnfiltered,
      suiteNote: verdict ? undefined : "the final sprint recorded no observed test verdict",
      // NEVER assumed: only what the recorded verdict actually names.
      testPlatform: /\bPlayMode\b/i.test(verdict ?? "")
        ? "PlayMode"
        : /\bEditMode\b/i.test(verdict ?? "")
          ? "EditMode"
          : undefined,
    });

    try {
      writeFileSync(join(this.projectRoot, relPath), text, "utf8");
      return (
        `- \`${relPath}\` at the project root says the same in the project itself: ` +
        "Unity version, entry scene, how to play, and the command that re-runs the suite."
      );
    } catch (err) {
      // A README that was not written must never be linked as if it were.
      return `- ⚠️ \`${relPath}\` could NOT be written (${err instanceof Error ? err.message : String(err)}) — this report is the only copy.`;
    }
  }

  /**
   * True when everything this sprint committed is prose. Measured from the
   * sprint's OWN commits (since startedAtMs), by file extension: a delivery
   * whose only artefacts are .md files under docs/ built nothing
   * (audited 2026-09-04).
   */
  private changedOnlyProse(milestone: CampaignMilestone): boolean {
    const since = milestone.startedAtMs;
    if (!since) return false;
    try {
      const iso = new Date(since).toISOString();
      const out = execFileSync(
        "git",
        ["log", `--since=${iso}`, "--name-only", "--pretty=format:", "--no-merges"],
        { cwd: this.projectRoot, encoding: "utf8", timeout: 20_000 },
      );
      const files = out.split("\n").map((f) => f.trim()).filter(Boolean);
      if (files.length === 0) return false; // nothing committed: the no-work gate owns that
      const buildsSomething = files.some((f) =>
        /\.(cs|unity|prefab|asset|mat|shader|json|png|jpg|fbx|obj|anim|controller)$/i.test(f)
        && !/^docs\//i.test(f),
      );
      return !buildsSomething;
    } catch {
      return false; // unmeasurable is never a refusal
    }
  }

  /** Total capture artifacts under the project's recording roots. */
  private countCaptureFiles(): number {
    let count = 0;
    const stack = [join(this.projectRoot, "Recordings"), join(this.projectRoot, "Assets", "Art", "Prerendered")]
      .filter((r) => existsSync(r));
    let scanned = 0;
    while (stack.length > 0 && scanned < 20_000) {
      const dir = stack.pop()!;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        scanned++;
        if (e.isDirectory()) stack.push(join(dir, e.name));
        else if (/\.(png|jpg|mp4)$/i.test(e.name)) count++;
      }
    }
    return count;
  }

  /**
   * Newest *GDD*.md under docs/ by mtime — the file the draft just wrote.
   * Walks subfolders (bounded depth): audited 2026-09-02, a flat readdir
   * made docs/design/Ashen_GDD.md invisible and the campaign redrafted.
   */
  private findNewestGddPath(): string | undefined {
    const docsDir = join(this.projectRoot, "docs");
    if (!existsSync(docsDir)) return undefined;
    const candidates: Array<{ rel: string; mtime: number }> = [];
    const stack: Array<{ dir: string; depth: number }> = [{ dir: docsDir, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3 && !e.name.startsWith(".") && e.name !== "node_modules") {
            stack.push({ dir: full, depth: depth + 1 });
          }
        } else if (/gdd/i.test(e.name) && e.name.toLowerCase().endsWith(".md")) {
          try {
            candidates.push({
              rel: relative(this.projectRoot, full).split(sep).join("/"),
              mtime: statSync(full).mtimeMs,
            });
          } catch {
            /* vanished mid-scan */
          }
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.rel;
  }

  /**
   * Write a supplied GDD into docs/ so sprint prompts reference a durable,
   * committable path. Sanitizes the source filename; idempotent per CONTENT.
   * Audited 2026-09-02: this was "idempotent per name" (an existence check),
   * so a revised GDD.docx re-shared under the same name left docs/GDD.md
   * holding the previous version — the ladder and the coverage audit used
   * the new text while every sprint prompt pointed agents at the old file.
   * Returns the project-relative path (undefined when the write failed —
   * planning then falls back to the in-memory text).
   */
  private persistSuppliedGdd(gddText: string, sourceName: string): string | undefined {
    try {
      const baseName =
        sourceName
          .replace(/\.[^.]+$/, "")
          .replace(/[^\w-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "Imported_GDD";
      const relPath = `docs/${baseName}.md`;
      const absPath = join(this.projectRoot, relPath);
      let current: string | undefined;
      try {
        current = readFileSync(absPath, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== gddText) {
        mkdirSync(join(this.projectRoot, "docs"), { recursive: true });
        writeFileSync(absPath, gddText, "utf8");
        if (current !== undefined) {
          getLoggerSafe().info("Supplied GDD replaced an older document of the same name in docs/", {
            relPath,
            previousChars: current.length,
            chars: gddText.length,
          });
        }
      }
      return relPath;
    } catch (err) {
      getLoggerSafe().warn("Could not persist supplied GDD into docs/", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private persist(campaign: Campaign): void {
    campaign.updatedAt = Date.now();
    this.storage.save(campaign);
  }

  /** Returns whether the message actually reached the channel. */
  /**
   * The campaign a status surface should describe: the active one on this chat,
   * else any active one on this project (the daemon serves one project, and a
   * Telegram chat and a web chat are different chat ids), else the most recent
   * terminal one. Undefined when this project never had a campaign.
   */
  findForStatus(chatId?: string): Campaign | undefined {
    const active = this.storage.listActive().filter((c) => c.projectRoot === this.projectRoot);
    const onChat = chatId ? active.find((c) => c.chatId === chatId) : undefined;
    if (onChat) return onChat;
    if (active.length > 0) {
      return active.reduce((newest, c) => (c.updatedAt > newest.updatedAt ? c : newest));
    }
    const terminal = this.storage.listRecentTerminal(10).filter((c) => c.projectRoot === this.projectRoot);
    if (terminal.length === 0) return undefined;
    return terminal.reduce((newest, c) => (c.updatedAt > newest.updatedAt ? c : newest));
  }

  /** Measured status of the campaign `findForStatus` picks — see campaign-status.ts. */
  describeStatus(chatId?: string): CampaignStatusSnapshot | undefined {
    const campaign = this.findForStatus(chatId);
    if (!campaign) return undefined;
    return buildCampaignStatus(campaign, {
      maxMilestoneAttempts: this.maxMilestoneAttempts,
      milestoneTimeBoxMs: this.milestoneTimeBoxMs,
      getTask: (taskId) => this.taskManager.getStatus(taskId as TaskId),
      listTasks: (chat) => this.taskManager.listTasks(chat, 20),
    });
  }

  /**
   * `/campaign revive` — the same path as the "kampanya devam" text, so a
   * command-menu tap and a typed phrase cannot drift apart. Returns false when
   * nothing on this chat is revivable (the caller tells the user).
   */
  async reviveByCommand(chatId: string): Promise<boolean> {
    return this.tryHandleRevive(chatId, "kampanya devam");
  }

  private async tell(
    campaign: Pick<Campaign, "chatId"> & Partial<Pick<Campaign, "id">>,
    markdown: string,
  ): Promise<boolean> {
    try {
      await this.messenger(campaign.chatId, markdown);
      return true;
    } catch (err) {
      getLoggerSafe().warn("Campaign message delivery failed", {
        id: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/**
 * The GDD items a coverage-remediation sprint (mcovN) was appended to close,
 * read back from its own prompt — buildCoverageRemediation writes them there
 * verbatim as a "- item" block. Empty for every other milestone, and for a
 * remediation sprint whose list cannot be recovered (the caller then says so
 * rather than inventing gap names).
 */
/**
 * Remove every time-box directive from a prompt — the narrowing blocks and the
 * "exhausted" line — so the one appended next is the only one the sprint reads.
 */
export function stripTimeBoxDirectives(prompt: string): string {
  return prompt
    .replace(/\n\nTIME BOX \([^)]*\):[\s\S]*?beats another broad attempt\./g, "")
    .replace(/\n\nTIME BOX EXHAUSTED \([^)]*\):[^\n]*/g, "");
}

/** A gap the audit phrased as art: it goes first, because everything visible depends on it. */
export function isArtGap(item: string): boolean {
  return /\b(art|sprite|visual|illustration|skin|mascot|background|artwork|animation|vfx|texture|model)/i.test(item);
}

function coverageGapItems(milestone: CampaignMilestone): string[] {
  if (!milestone.id.startsWith("mcov")) return [];
  const items: string[] = [];
  for (const line of milestone.prompt.split("\n")) {
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (items.length > 0) break; // the block ends at its first non-item line
  }
  return items.filter((item) => item.length > 0);
}

function readGddFile(projectRoot: string, gddPath: string): string | undefined {
  try {
    return readFileSync(join(projectRoot, gddPath), "utf8");
  } catch {
    return undefined;
  }
}
