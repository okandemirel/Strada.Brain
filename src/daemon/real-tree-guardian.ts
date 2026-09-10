/**
 * Real-Tree Guardian — the autonomous detect-and-fix loop for the PROJECT,
 * not for leases.
 *
 * Measured 2026-08-27 (user-reported): the real PixelFlow tree sat RED for
 * ~25 hours — a salvage merge had landed two parallel Rocket implementations
 * (CS0101) and a broken EditMode test. Every verification loop in the system
 * runs against workspace leases, so nothing ever looked at the tree the user
 * actually opens. The user's requirement, verbatim: "errorler varmış — detect
 * edip çözen otonom bir sistem şart."
 *
 * The guardian is deliberately small: on a slow interval, when no foreground
 * task is executing (it never competes with sprint work for Unity/CPU), it
 * compiles the REAL project root headlessly. On red, it submits ONE fix task
 * with the error list — with workspacePolicy "none", because lease commits
 * never delete files, and the canonical red state (a duplicated type) can
 * only be fixed by a deletion. It then waits for the fix to settle before
 * verifying again, so a red tree never spawns a storm of fix tasks.
 */

import { createHash } from "node:crypto";
import { getLoggerSafe } from "../utils/logger.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES } from "../tasks/types.js";

/**
 * Headless compile verdict for the real project root. `ran: false` means the
 * verifier itself could not run (tool unregistered, bridge down) — which says
 * nothing about the tree and must not trigger a fix.
 */
export type RealTreeVerifier = (
  projectRoot: string,
) => Promise<{ ok: boolean; detail: string; ran?: boolean }>;

export interface RealTreeGuardianOptions {
  taskManager: TaskManager;
  verify: RealTreeVerifier;
  /**
   * The second rung: play the game (unity_playthrough) once the tree
   * compiles. Optional — a project without the tool keeps the compile-only
   * guardian. Runs only after a write-back changed something, at most once
   * per PLAY_MIN_INTERVAL_MS: a headless play-through is minutes of Unity.
   */
  play?: RealTreeVerifier;
  projectRoot: string;
  /** Channel delivery for "found red / submitted fix / back to green" notes. */
  messenger?: (chatId: string, text: string) => Promise<void>;
  /** Where notes go. Defaults to the CLI local session. */
  chatId?: string;
  /** Poll cadence. Default 15 min — a red tree is caught within one tick. */
  intervalMs?: number;
  /** Test hook: run one tick manually instead of scheduling. */
  now?: () => number;
  /** Delay of the boot check (default 2 min). */
  readonly firstCheckDelayMs?: number;
  /** Delay of the after-write-back check (default 5 s). */
  readonly writeBackCheckDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
/** The boot look: after salvage has had its say, before the first sprint turn lands. */
const DEFAULT_FIRST_CHECK_DELAY_MS = 2 * 60_000;
/** The write-back look: right after the files land. */
const DEFAULT_WRITE_BACK_CHECK_DELAY_MS = 5_000;
/** After submitting a fix, verify no sooner than this — the fix needs time. */
const POST_FIX_QUIET_MS = 10 * 60_000;
/** Fix attempts per distinct error fingerprint before escalating to the user. */
const MAX_FIX_ATTEMPTS_PER_FINGERPRINT = 3;
/**
 * Consecutive fix attempts that fail to BEAT the fewest errors seen this
 * episode, before escalating.
 *
 * Measured live 2026-09-04 22:00–22:27, on the user's project:
 *   25 → 40 → 40 → 37 → 40 → 31 → 10 → 22 → 37 → 37
 * Ten rounds, no escalation. The streak counter keys on a hash of the error
 * TEXT, so every round that changed which errors exist reset it to zero — and
 * a thrashing repair changes the text every round by definition. The guard
 * fired only on a byte-identical error list, which is the one case a
 * thrashing repair never produces.
 */
const MAX_ATTEMPTS_WITHOUT_PROGRESS = 3;
/** Back off this long after escalating; a changed error list resets earlier. */
const ESCALATION_BACKOFF_MS = 6 * 60 * 60_000;
/**
 * Consecutive ticks whose verifier could not run before the user is told the
 * guardian is blind. 4 ticks at the default 15-min cadence is one hour.
 */
const BLIND_TICKS_BEFORE_ESCALATION = 4;
/**
 * How often a steady GREEN tree is noted, so "alive and green" can be told
 * from "not running at all".
 *
 * Audited 2026-09-05: the green branch returned silently. Two hours after a
 * restart the log held one "Real-tree guardian started" and nothing else, and
 * nothing in it could distinguish a healthy tree from a guardian that never
 * ticked — the exact ambiguity this file already fixed once for the BLIND
 * case, left open for the green one.
 */
const GREEN_HEARTBEAT_MS = 60 * 60_000;
/**
 * Least time between two play-throughs of the real tree. The compile rung is
 * seconds; the play rung boots Unity, loads the entry scene and plays a
 * session (minutes), so it runs only when something changed since the last
 * one and never more often than this.
 */
const PLAY_MIN_INTERVAL_MS = 20 * 60_000;
/**
 * How long ONE fix task may stay in flight before the guardian takes the tree
 * back.
 *
 * Measured live 2026-09-05 09:00–09:50, with a single owner and the
 * convergence guard already in place: one fix task ran 35+ minutes and drove
 * the compile-error count 13 → 4 → 22 → 4 → 17 inside itself. The guard never
 * bit, because it counts the GUARDIAN's rounds and the guardian was waiting
 * for that one task the whole time. Bounding how many fix tasks are submitted
 * says nothing about what one of them does for an hour.
 */
const MAX_FIX_TASK_RUNTIME_MS = 45 * 60_000;

/**
 * The verifier's verdict, reduced to what a fixer can act on.
 *
 * The verdict is the compile tool's whole JSON payload. Measured 2026-09-08
 * 13:42: 10 333 characters for ONE `error CS1061` — twenty entries of which
 * seventeen were stack frames, asmdef notes and reload chatter, plus a warning
 * with a CS code that the count had taken for an error. The fix task read it
 * as "7 errors", decomposed into a node per Rocket file, and spent 25 minutes
 * on grep/scene analysis looking for errors that were not there.
 *
 * Non-JSON (or JSON without a diagnostics list, or with no error in it) is
 * returned untouched — nothing is hidden that could have been the cause.
 */
export function compactCompileDetail(detail: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return detail;
  }
  const root = parsed as { reason?: unknown; compile?: { diagnostics?: { entries?: unknown } } } | null;
  const entries = root?.compile?.diagnostics?.entries;
  if (!Array.isArray(entries)) return detail;
  const messageOf = (entry: unknown): string =>
    String((entry as { message?: unknown })?.message ?? "").trim();
  const typeOf = (entry: unknown): string =>
    String((entry as { type?: unknown })?.type ?? "").toLowerCase();
  const isWarningLine = (message: string): boolean =>
    /\bwarning\s+(?:CS|BC|NU)\d{4}\b/i.test(message) && !/\berror\b/i.test(message);
  const isErrorEntry = (entry: unknown): boolean => {
    const message = messageOf(entry);
    if (isWarningLine(message)) return false;
    return ["error", "exception", "assert"].includes(typeOf(entry)) || /\berror\s+(?:CS|BC|NU)\d{4}\b/i.test(message);
  };
  const distinct = (messages: string[]): string[] => {
    const seen = new Set<string>();
    return messages.filter((message) => {
      const key = message.replace(/\s+/g, " ").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const errors = distinct(entries.filter(isErrorEntry).map(messageOf));
  if (errors.length === 0) return detail;
  const warnings = distinct(
    entries.filter((entry) => typeOf(entry) === "warning" || isWarningLine(messageOf(entry))).map(messageOf),
  );
  const reason = typeof root?.reason === "string" ? root.reason : `Compile failed with ${errors.length} error(s).`;
  const lines = [reason, `${errors.length} distinct error(s):`, ...errors.slice(0, 40).map((m) => `- ${m}`)];
  if (warnings.length > 0) {
    lines.push(
      `${warnings.length} warning(s) — not errors; the tree is red because of the errors above:`,
      ...warnings.slice(0, 10).map((m) => `- ${m}`),
    );
  }
  return lines.join("\n");
}

/**
 * The fix task for a tree that compiles but cannot be played. The guardian
 * used to check only compilation, so "green suite, empty screen" — the
 * failure mode the whole system is written against — was invisible to the
 * one component that looks at the real tree (audited 2026-09-10).
 */
const PLAY_FIX_TASK_PROMPT = (detail: string, projectRoot: string) =>
  `The REAL project tree at ${projectRoot} compiles but CANNOT BE PLAYED by the framework. ` +
  `unity_playthrough said:\n\n${detail.slice(0, 1500)}\n\n` +
  `Work directly in the real tree (no workspace lease is used for this task). Fix what the verdict names — ` +
  `a Strada.Core.Play.IPlaythroughDriver that is not registered, a bootstrapper that never publishes its ` +
  `services, a session that never ends, a screen that never changes — then run unity_playthrough again and ` +
  `report its verdict VERBATIM. Do not touch art and do not audit; a verdict that is not ok is not done.`;

const FIX_TASK_PROMPT = (detail: string, projectRoot: string) =>
  `The REAL project tree at ${projectRoot} does not compile. This is the tree the user opens — ` +
  `it must stay green. Errors:\n${compactCompileDetail(detail)}\n\n` +
  `Fix the root cause directly on this tree (you are NOT in a workspace lease — edits land on the real ` +
  `project, which is exactly what is needed here; deletions are allowed and often the point — e.g. a ` +
  `duplicate type left by a salvage merge). Then verify with unity_verify_change and report the verdict.`;

/**
 * How many errors the verifier counted, or undefined when it named none.
 *
 * Reads the JSON field first and the prose second, the same two shapes
 * stage-runtime already reconciles. Undefined is NOT zero: a verdict that
 * names no count says nothing about whether the repair is progressing, so the
 * caller falls back to the fingerprint rule rather than inventing progress.
 */
export function countCompileErrors(detail: string): number | undefined {
  if (typeof detail !== "string" || detail.length === 0) return undefined;
  const json = /"compileErrors"\s*:\s*(\d+)/i.exec(detail)?.[1];
  const prose = /(\d+)\s*(?:error\(s\)|errors?\b)/i.exec(detail)?.[1];
  const raw = json ?? prose;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * What the guardian last saw, for the channels (`/guardian`, the web portal's
 * campaign card). Every field is a measurement the guardian already took —
 * nothing here is computed on demand, so a snapshot of a guardian that has
 * never ticked says `unknown`, never `green`.
 */
export interface RealTreeGuardianSnapshot {
  readonly projectRoot: string;
  /** `unknown` until the first verdict; `blind` when the verifier could not run. */
  readonly lastVerdict: "unknown" | "green" | "red" | "blind";
  /** Epoch ms of the last verifier answer; 0 = never. */
  readonly lastCheckedAt: number;
  /** Errors the verifier counted in the last red verdict; undefined when it named none. */
  readonly lastErrorCount?: number;
  /** Compact excerpt of the last non-green verdict (≤300 chars). */
  readonly lastDetail: string;
  /** The in-flight autonomous fix task, if any. */
  readonly fixTaskId?: string;
  readonly fixTaskStartedAt: number;
  readonly fixAttempts: number;
  readonly maxFixAttempts: number;
  readonly bestErrorCount?: number;
  readonly attemptsWithoutProgress: number;
  readonly escalated: boolean;
  readonly blindStreak: number;
  /** Epoch ms before which the guardian will not verify again; 0 = no hold. */
  readonly nextVerifyAt: number;
  /** The play rung: `unknown` until the first play-through, `blind` when the tool could not run. */
  readonly lastPlayVerdict: "unknown" | "ok" | "failed" | "blind";
  readonly lastPlayDetail: string;
  readonly lastPlayedAt: number;
  readonly playFixAttempts: number;
}

export class RealTreeGuardian {
  private readonly taskManager: TaskManager;
  private readonly verify: RealTreeVerifier;
  private readonly projectRoot: string;
  private readonly messenger?: (chatId: string, text: string) => Promise<void>;
  private readonly chatId: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingCheck: ReturnType<typeof setTimeout> | undefined;
  private readonly firstCheckDelayMs: number;
  private readonly writeBackCheckDelayMs: number;
  private tickInFlight = false;
  private fixTaskId: string | undefined;
  /** When the in-flight fix task was submitted; 0 = none. */
  private fixTaskStartedAt = 0;
  private nextVerifyAt = 0;
  /** Fingerprint of the error list the current attempt streak is fixing. */
  private redFingerprint: string | undefined;
  private fixAttempts = 0;
  /** Fewest errors seen since the tree last went green; Infinity = none yet. */
  private bestErrorCount = Number.POSITIVE_INFINITY;
  /** Consecutive attempts that did not beat bestErrorCount. */
  private attemptsWithoutProgress = 0;
  private escalated = false;
  /** Consecutive ticks whose verifier could not run (no verdict either way). */
  private blindStreak = 0;
  private blindReported = false;
  /** When a steady-green tick was last noted; 0 = never, and the first is always noted. */
  private lastGreenNoteAt = 0;
  /** True while the last verdict was red, so the recovery can be announced. */
  private wasRed = false;
  private lastVerdict: RealTreeGuardianSnapshot["lastVerdict"] = "unknown";
  private readonly play: RealTreeVerifier | undefined;
  private lastPlayVerdict: RealTreeGuardianSnapshot["lastPlayVerdict"] = "unknown";
  private lastPlayDetail = "";
  private lastPlayedAt = 0;
  /** Something reached the tree since the last play-through (true at boot: never played). */
  private playDirty = true;
  private playFingerprint: string | undefined;
  private playFixAttempts = 0;
  private lastCheckedAt = 0;
  private lastErrorCount: number | undefined;
  private lastDetail = "";

  constructor(options: RealTreeGuardianOptions) {
    this.taskManager = options.taskManager;
    this.verify = options.verify;
    this.play = options.play;
    this.projectRoot = options.projectRoot;
    this.messenger = options.messenger;
    this.chatId = options.chatId ?? "cli-local";
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.firstCheckDelayMs = options.firstCheckDelayMs ?? DEFAULT_FIRST_CHECK_DELAY_MS;
    this.writeBackCheckDelayMs = options.writeBackCheckDelayMs ?? DEFAULT_WRITE_BACK_CHECK_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        getLoggerSafe().warn("Real-tree guardian tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    this.timer.unref?.();
    // Boot salvage may have written a crashed owner's work into the project;
    // look soon, and look even though the campaign has already resubmitted.
    this.checkSoon("boot", this.firstCheckDelayMs);
  }

  /**
   * A lease was just written back into the project: verify it soon, even
   * while sprint work runs. Measured 2026-09-08: an 8-line edit committed by
   * a graceful shutdown at 09:28 broke the real tree (7 errors); the sprint
   * ran nearly continuously, the foreground guard skipped every tick, and the
   * first verdict came at 13:05 — every lease seeded in between started red.
   */
  noteWriteBack(source: string): void {
    this.playDirty = true;
    this.checkSoon(source, this.writeBackCheckDelayMs);
  }

  private checkSoon(source: string, delayMs: number): void {
    if (this.pendingCheck) clearTimeout(this.pendingCheck);
    this.pendingCheck = setTimeout(() => {
      this.pendingCheck = undefined;
      this.nextVerifyAt = 0;
      void this.tick({ ignoreForeground: true }).catch((err) => {
        getLoggerSafe().warn("Real-tree guardian write-back check failed", {
          source,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);
    this.pendingCheck.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.pendingCheck) {
      clearTimeout(this.pendingCheck);
      this.pendingCheck = undefined;
    }
  }

  async tick(opts: { readonly ignoreForeground?: boolean } = {}): Promise<void> {
    if (this.tickInFlight) return;
    if (this.now() < this.nextVerifyAt) return;
    // Never compete with sprint work for the machine or the project — except
    // for the one look a write-back or a boot salvage earns (noteWriteBack).
    if (!opts.ignoreForeground && this.taskManager.hasActiveForegroundTasks?.()) return;

    this.tickInFlight = true;
    try {
      // A previously submitted fix still in flight: give it room, verify after.
      // In flight means ANY active status — a daemon task legitimately queues
      // as `pending` behind foreground work; reading that as "did not complete"
      // duplicated the fix task every tick (measured 2026-08-28 02:17).
      if (this.fixTaskId) {
        const fix = this.taskManager.getStatus(this.fixTaskId as TaskId);
        if (fix && ACTIVE_STATUSES.has(fix.status)) {
          const ranForMs = this.now() - this.fixTaskStartedAt;
          if (this.fixTaskStartedAt > 0 && ranForMs > MAX_FIX_TASK_RUNTIME_MS) {
            // Take the tree back. The task is looping inside itself and the
            // guardian cannot see it: from out here a 45-minute fix and a
            // 45-minute thrash look identical, and only one of them is worth
            // waiting for. Cancelling counts as an attempt that did not
            // improve anything, so the convergence guard can finally reach it.
            getLoggerSafe().warn("Real-tree fix task overran its budget — cancelling and re-diagnosing", {
              fixTaskId: this.fixTaskId,
              ranForMinutes: Math.round(ranForMs / 60_000),
            });
            try {
              this.taskManager.cancel(this.fixTaskId as TaskId);
            } catch {
              /* already settled */
            }
            this.fixTaskId = undefined;
            this.fixTaskStartedAt = 0;
            this.attemptsWithoutProgress += 1;
          } else {
            return;
          }
        }
        if (this.fixTaskId) {
          const settledOk = fix && (fix as { status?: string }).status === "completed";
          const finishedId = this.fixTaskId;
          this.fixTaskId = undefined;
          this.fixTaskStartedAt = 0;
          if (!settledOk) {
            // The fix failed/blocked — fall through and re-diagnose from the
            // CURRENT error list rather than resubmitting the same prompt.
            getLoggerSafe().warn("Real-tree fix task did not complete; re-diagnosing", { fixTaskId: finishedId });
          }
        }
      }

      const verdict = await this.verify(this.projectRoot);
      this.lastCheckedAt = this.now();
      if (verdict.ran === false) {
        this.lastVerdict = "blind";
        this.lastDetail = verdict.detail.slice(0, 300);
        // The verifier could not run — no signal about the tree, so no fix.
        // Audited 2026-09-02: this returned bare, discarding `detail`, so a
        // guardian whose verifier was permanently unavailable was
        // indistinguishable from a green tree for days. The absence of a
        // verdict is itself reported.
        await this.noteBlindTick(verdict.detail);
        return;
      }
      this.blindStreak = 0;
      this.blindReported = false;
      if (verdict.ok) {
        this.lastVerdict = "green";
        this.lastErrorCount = 0;
        this.lastDetail = "";
        const recovered = this.wasRed;
        this.redFingerprint = undefined;
        this.fixAttempts = 0;
        this.bestErrorCount = Number.POSITIVE_INFINITY;
        this.attemptsWithoutProgress = 0;
        this.escalated = false;
        this.wasRed = false;
        // SILENCE IS NOT A STATUS. Announce the recovery once, then note a
        // steady green at most hourly: without this, a green tick wrote
        // nothing and a dead guardian looked exactly like a healthy tree.
        const now = this.now();
        if (recovered) {
          getLoggerSafe().info("Real tree is back to green", { projectRoot: this.projectRoot });
          if (this.messenger) {
            await this.messenger(this.chatId, "✅ The project tree compiles again.").catch(() => undefined);
          }
          this.lastGreenNoteAt = now;
        } else if (this.lastGreenNoteAt === 0 || now - this.lastGreenNoteAt >= GREEN_HEARTBEAT_MS) {
          getLoggerSafe().info("Real-tree guardian: tree is green", { projectRoot: this.projectRoot });
          this.lastGreenNoteAt = now;
        }
        await this.maybePlay();
        return;
      }
      this.wasRed = true;

      // Same error list as the failed attempts before? Count the streak and
      // stop feeding fix tasks that keep not fixing it — escalate instead.
      const fingerprint = createHash("sha256").update(verdict.detail).digest("hex").slice(0, 16);

      // ESCALATE ON LACK OF PROGRESS, not on identity of the error text. A
      // repair that keeps changing WHICH errors exist resets a text-keyed
      // streak every round and can loop on the user's project forever — the
      // measured 25 → 40 → 37 → 31 → 10 → 22 → 37 sequence never repeated a
      // list, so the fingerprint guard never fired.
      const errors = countCompileErrors(verdict.detail);
      this.lastVerdict = "red";
      this.lastErrorCount = errors;
      this.lastDetail = compactCompileDetail(verdict.detail).slice(0, 300);
      if (errors !== undefined) {
        if (errors < this.bestErrorCount) {
          this.bestErrorCount = errors;
          this.attemptsWithoutProgress = 0;
        } else {
          this.attemptsWithoutProgress += 1;
        }
        if (this.attemptsWithoutProgress >= MAX_ATTEMPTS_WITHOUT_PROGRESS) {
          if (!this.escalated) {
            this.escalated = true;
            getLoggerSafe().warn("Real-tree guardian escalating: autonomous repair is not converging", {
              errors,
              best: this.bestErrorCount,
              attemptsWithoutProgress: this.attemptsWithoutProgress,
            });
            if (this.messenger) {
              await this.messenger(
                this.chatId,
                `❌ Autonomous repair is NOT converging — ${this.attemptsWithoutProgress} attempts in a row failed to get below ` +
                  `${this.bestErrorCount} error(s), and the tree is at ${errors}. Stopping so a person can look.\n` +
                  `\`\`\`\n${verdict.detail.slice(0, 500)}\n\`\`\``,
              ).catch(() => undefined);
            }
          }
          this.nextVerifyAt = this.now() + ESCALATION_BACKOFF_MS;
          return;
        }
      }

      if (fingerprint === this.redFingerprint) {
        if (this.fixAttempts >= MAX_FIX_ATTEMPTS_PER_FINGERPRINT) {
          if (!this.escalated) {
            this.escalated = true;
            getLoggerSafe().warn("Real-tree guardian escalating: same errors after max fix attempts", {
              attempts: this.fixAttempts,
              fingerprint,
            });
            if (this.messenger) {
              await this.messenger(
                this.chatId,
                `❌ The project tree stayed red after ${this.fixAttempts} autonomous fix attempts — the same errors persist and this needs a person.\n\`\`\`\n${verdict.detail.slice(0, 500)}\n\`\`\``,
              ).catch(() => undefined);
            }
          }
          this.nextVerifyAt = this.now() + ESCALATION_BACKOFF_MS;
          return;
        }
      } else {
        this.redFingerprint = fingerprint;
        this.fixAttempts = 0;
        this.escalated = false;
      }
      this.fixAttempts += 1;

      getLoggerSafe().warn("Real tree is red — submitting autonomous fix", {
        detail: verdict.detail.slice(0, 300),
        attempt: this.fixAttempts,
        fingerprint,
      });
      const task = this.taskManager.submit(
        this.chatId,
        "daemon",
        FIX_TASK_PROMPT(verdict.detail, this.projectRoot),
        {
          origin: "daemon",
          triggerName: "real-tree-guardian",
          workspacePolicy: "none",
          // One agent fixes N named errors; a supervisor plan here burned an hour on node 1 (2026-09-09).
          supervisorMode: "off",
        },
      );
      this.fixTaskId = task.id;
      this.fixTaskStartedAt = this.now();
      this.nextVerifyAt = this.now() + POST_FIX_QUIET_MS;
      if (this.messenger) {
        await this.messenger(
          this.chatId,
          `⚠️ The project tree doesn't compile — I'm fixing it autonomously (attempt ${this.fixAttempts}/${MAX_FIX_ATTEMPTS_PER_FINGERPRINT}).\n\`\`\`\n${compactCompileDetail(verdict.detail).slice(0, 500)}\n\`\`\``,
        ).catch(() => undefined);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Record a tick whose verifier could not run. Logs the verifier's own
   * reason on the first blind tick and every BLIND_TICKS_BEFORE_ESCALATION
   * after, and tells the user once per streak when the guardian has been
   * blind that long — so "not watching" never reads like "green".
   */
  /** The guardian's last measurements, for status surfaces. Read-only; never triggers a tick. */
  /**
   * The play rung. Only on a compiling tree, only after something changed
   * since the last play-through, never more often than PLAY_MIN_INTERVAL_MS.
   * A failed play-through is a red tree of its own kind: one fix task per
   * fingerprint, the same attempt cap, the same quiet period.
   */
  private async maybePlay(): Promise<void> {
    if (!this.play || !this.playDirty || this.fixTaskId) return;
    const now = this.now();
    if (this.lastPlayedAt > 0 && now - this.lastPlayedAt < PLAY_MIN_INTERVAL_MS) return;
    this.lastPlayedAt = now;
    this.playDirty = false;
    const verdict = await this.play(this.projectRoot);
    if (verdict.ran === false) {
      this.lastPlayVerdict = "blind";
      this.lastPlayDetail = verdict.detail.slice(0, 300);
      getLoggerSafe().warn("Real-tree guardian: play-through could not run", { detail: this.lastPlayDetail });
      return;
    }
    if (verdict.ok) {
      const recovered = this.lastPlayVerdict === "failed";
      this.lastPlayVerdict = "ok";
      this.lastPlayDetail = "";
      this.playFingerprint = undefined;
      this.playFixAttempts = 0;
      getLoggerSafe().info("Real-tree guardian: the game plays", { projectRoot: this.projectRoot });
      if (recovered && this.messenger) {
        await this.messenger(this.chatId, "✅ The real tree plays again — unity_playthrough is ok.").catch(() => undefined);
      }
      return;
    }
    this.lastPlayVerdict = "failed";
    this.lastPlayDetail = verdict.detail.slice(0, 300);
    const fingerprint = createHash("sha256").update(verdict.detail).digest("hex").slice(0, 16);
    if (fingerprint === this.playFingerprint) {
      if (this.playFixAttempts >= MAX_FIX_ATTEMPTS_PER_FINGERPRINT) {
        if (!this.escalated) {
          this.escalated = true;
          getLoggerSafe().warn("Real-tree guardian escalating: the game still cannot be played after max fix attempts", {
            attempts: this.playFixAttempts,
            fingerprint,
          });
          if (this.messenger) {
            await this.messenger(
              this.chatId,
              `❌ The real tree compiles but still cannot be played after ${this.playFixAttempts} autonomous fix attempts — this needs a person.\n\`\`\`\n${verdict.detail.slice(0, 500)}\n\`\`\``,
            ).catch(() => undefined);
          }
        }
        this.nextVerifyAt = now + ESCALATION_BACKOFF_MS;
        return;
      }
    } else {
      this.playFingerprint = fingerprint;
      this.playFixAttempts = 0;
    }
    this.playFixAttempts += 1;
    getLoggerSafe().warn("Real tree compiles but cannot be played — submitting autonomous fix", {
      detail: this.lastPlayDetail,
      attempt: this.playFixAttempts,
      fingerprint,
    });
    const task = this.taskManager.submit(
      this.chatId,
      "daemon",
      PLAY_FIX_TASK_PROMPT(verdict.detail, this.projectRoot),
      { origin: "daemon", triggerName: "real-tree-guardian", workspacePolicy: "none", supervisorMode: "off" },
    );
    this.fixTaskId = task.id;
    this.fixTaskStartedAt = now;
    this.playDirty = true; // the fix will write back; play again after it
    this.nextVerifyAt = now + POST_FIX_QUIET_MS;
    if (this.messenger) {
      await this.messenger(
        this.chatId,
        `⚠️ The project compiles but cannot be played — I'm fixing it autonomously (attempt ${this.playFixAttempts}/${MAX_FIX_ATTEMPTS_PER_FINGERPRINT}).\n\`\`\`\n${verdict.detail.slice(0, 500)}\n\`\`\``,
      ).catch(() => undefined);
    }
  }

  snapshot(): RealTreeGuardianSnapshot {
    return {
      lastPlayVerdict: this.lastPlayVerdict,
      lastPlayDetail: this.lastPlayDetail,
      lastPlayedAt: this.lastPlayedAt,
      playFixAttempts: this.playFixAttempts,
      projectRoot: this.projectRoot,
      lastVerdict: this.lastVerdict,
      lastCheckedAt: this.lastCheckedAt,
      lastErrorCount: this.lastErrorCount,
      lastDetail: this.lastDetail,
      fixTaskId: this.fixTaskId,
      fixTaskStartedAt: this.fixTaskStartedAt,
      fixAttempts: this.fixAttempts,
      maxFixAttempts: MAX_FIX_ATTEMPTS_PER_FINGERPRINT,
      bestErrorCount: Number.isFinite(this.bestErrorCount) ? this.bestErrorCount : undefined,
      attemptsWithoutProgress: this.attemptsWithoutProgress,
      escalated: this.escalated,
      blindStreak: this.blindStreak,
      nextVerifyAt: this.nextVerifyAt,
    };
  }

  private async noteBlindTick(detail: string): Promise<void> {
    this.blindStreak += 1;
    const streak = this.blindStreak;
    if (streak === 1 || streak % BLIND_TICKS_BEFORE_ESCALATION === 0) {
      getLoggerSafe().warn("Real-tree guardian could not verify the tree (verifier did not run)", {
        detail: detail.slice(0, 300),
        consecutive: streak,
      });
    }
    if (streak >= BLIND_TICKS_BEFORE_ESCALATION && !this.blindReported && this.messenger) {
      this.blindReported = true;
      const minutes = Math.round((streak * this.intervalMs) / 60_000);
      await this.messenger(
        this.chatId,
        `⚠️ The real-tree guardian has not been able to verify the project tree for ${streak} consecutive checks (~${minutes} min) — it is NOT watching the tree right now. Reason: ${detail.slice(0, 300)}`,
      ).catch(() => undefined);
    }
  }
}
