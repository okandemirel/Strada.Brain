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

import { getLoggerSafe } from "../utils/logger.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";

/** Headless compile verdict for the real project root. */
export type RealTreeVerifier = (projectRoot: string) => Promise<{ ok: boolean; detail: string }>;

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
      // A previously submitted fix still running: give it room, verify after.
      if (this.fixTaskId) {
        const fix = this.taskManager.getStatus(this.fixTaskId as TaskId);
        if (fix && (fix as { status?: string }).status === "executing") return;
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
      if (verdict.ok) return;

      getLoggerSafe().warn("Real tree is red — submitting autonomous fix", {
        detail: verdict.detail.slice(0, 300),
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
          `⚠️ The project tree doesn't compile — I'm fixing it autonomously.\n\`\`\`\n${verdict.detail.slice(0, 500)}\n\`\`\``,
        ).catch(() => undefined);
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
