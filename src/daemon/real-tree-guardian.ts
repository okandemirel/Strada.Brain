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
  projectRoot: string;
  /** Channel delivery for "found red / submitted fix / back to green" notes. */
  messenger?: (chatId: string, text: string) => Promise<void>;
  /** Where notes go. Defaults to the CLI local session. */
  chatId?: string;
  /** Poll cadence. Default 15 min — a red tree is caught within one tick. */
  intervalMs?: number;
  /** Test hook: run one tick manually instead of scheduling. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
/** After submitting a fix, verify no sooner than this — the fix needs time. */
const POST_FIX_QUIET_MS = 10 * 60_000;
/** Fix attempts per distinct error fingerprint before escalating to the user. */
const MAX_FIX_ATTEMPTS_PER_FINGERPRINT = 3;
/** Back off this long after escalating; a changed error list resets earlier. */
const ESCALATION_BACKOFF_MS = 6 * 60 * 60_000;

const FIX_TASK_PROMPT = (detail: string, projectRoot: string) =>
  `The REAL project tree at ${projectRoot} does not compile. This is the tree the user opens — ` +
  `it must stay green. Errors:\n${detail}\n\n` +
  `Fix the root cause directly on this tree (you are NOT in a workspace lease — edits land on the real ` +
  `project, which is exactly what is needed here; deletions are allowed and often the point — e.g. a ` +
  `duplicate type left by a salvage merge). Then verify with unity_verify_change and report the verdict.`;

export class RealTreeGuardian {
  private readonly taskManager: TaskManager;
  private readonly verify: RealTreeVerifier;
  private readonly projectRoot: string;
  private readonly messenger?: (chatId: string, text: string) => Promise<void>;
  private readonly chatId: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;
  private fixTaskId: string | undefined;
  private nextVerifyAt = 0;
  /** Fingerprint of the error list the current attempt streak is fixing. */
  private redFingerprint: string | undefined;
  private fixAttempts = 0;
  private escalated = false;

  constructor(options: RealTreeGuardianOptions) {
    this.taskManager = options.taskManager;
    this.verify = options.verify;
    this.projectRoot = options.projectRoot;
    this.messenger = options.messenger;
    this.chatId = options.chatId ?? "cli-local";
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
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
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return;
    if (this.now() < this.nextVerifyAt) return;
    // Never compete with sprint work for the machine or the project.
    if (this.taskManager.hasActiveForegroundTasks?.()) return;

    this.tickInFlight = true;
    try {
      // A previously submitted fix still in flight: give it room, verify after.
      // In flight means ANY active status — a daemon task legitimately queues
      // as `pending` behind foreground work; reading that as "did not complete"
      // duplicated the fix task every tick (measured 2026-08-28 02:17).
      if (this.fixTaskId) {
        const fix = this.taskManager.getStatus(this.fixTaskId as TaskId);
        if (fix && ACTIVE_STATUSES.has(fix.status)) return;
        const settledOk = fix && (fix as { status?: string }).status === "completed";
        const finishedId = this.fixTaskId;
        this.fixTaskId = undefined;
        if (!settledOk) {
          // The fix failed/blocked — fall through and re-diagnose from the
          // CURRENT error list rather than resubmitting the same prompt.
          getLoggerSafe().warn("Real-tree fix task did not complete; re-diagnosing", { fixTaskId: finishedId });
        }
      }

      const verdict = await this.verify(this.projectRoot);
      if (verdict.ran === false) return; // the verifier could not run — no signal
      if (verdict.ok) {
        this.redFingerprint = undefined;
        this.fixAttempts = 0;
        this.escalated = false;
        return;
      }

      // Same error list as the failed attempts before? Count the streak and
      // stop feeding fix tasks that keep not fixing it — escalate instead.
      const fingerprint = createHash("sha256").update(verdict.detail).digest("hex").slice(0, 16);
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
        },
      );
      this.fixTaskId = task.id;
      this.nextVerifyAt = this.now() + POST_FIX_QUIET_MS;
      if (this.messenger) {
        await this.messenger(
          this.chatId,
          `⚠️ The project tree doesn't compile — I'm fixing it autonomously (attempt ${this.fixAttempts}/${MAX_FIX_ATTEMPTS_PER_FINGERPRINT}).\n\`\`\`\n${verdict.detail.slice(0, 500)}\n\`\`\``,
        ).catch(() => undefined);
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
