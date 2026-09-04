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
import { join, relative, sep } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";
import { allProvidersCoolingDownMs, describeProviderOutage } from "../agents/providers/provider-outage.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES, TaskStatus } from "../tasks/types.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { GDD_AUDIT_FULL_CHARS } from "./campaign-planner.js";
import type { CampaignStorage } from "./campaign-storage.js";
import { detectCampaignIntent } from "./campaign-intake.js";
import { assessSceneHygiene, renderSceneHygiene } from "./scene-hygiene.js";
import {
  extractLookDescription,
  judgeVisualConformance,
  renderVisualConformance,
  selectGameplayFrame,
} from "./visual-conformance.js";
import { extractCoreLoop, readUnityVersion, renderHowToRun } from "./how-to-run.js";
import { isTerminalFailureReport } from "../agents/autonomy/verifier-pipeline.js";
import { assessBuiltAsSpecified } from "../agents/autonomy/built-as-specified.js";
import { describeDimensionality } from "../agents/autonomy/gdd-dimensionality.js";
import type { Campaign, CampaignMilestone } from "./types.js";
import { generateCampaignId } from "./types.js";

/** The channel-agnostic way back to the conversation (approval gate, reports). */
export type CampaignMessenger = (chatId: string, markdown: string) => Promise<void>;

export interface CampaignContext {
  chatId: string;
  channelType: string;
  userId: string;
  conversationId?: string;
}

export interface CampaignManagerOptions {
  storage: CampaignStorage;
  planner: CampaignPlanner;
  /**
   * A provider that claims vision on its OWN capabilities (never a fallback
   * chain — see ProviderManager.getVisionProvider). Absent means the look
   * check is reported as not checked, never as passed.
   */
  visionProvider?: { provider: import("../agents/providers/provider.interface.js").IAIProvider; name: string } | null;
  taskManager: TaskManager;
  messenger: CampaignMessenger;
  projectRoot: string;
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

export class CampaignManager {
  private readonly storage: CampaignStorage;
  private readonly planner: CampaignPlanner;
  private readonly visionProvider: { provider: import("../agents/providers/provider.interface.js").IAIProvider; name: string } | null;
  private readonly taskManager: TaskManager;
  private readonly messenger: CampaignMessenger;
  private readonly projectRoot: string;
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
  private cancelLineageRootOf(taskId: string): void {
    try {
      const manager = this.taskManager as unknown as {
        findLineageRootId?: (id: string) => string | null;
        getStatus?: (id: string) => { id: string; status?: string; parentId?: string } | null;
        cancel?: (id: string) => void;
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
        manager.cancel?.(rootId);
      }
    } catch { /* unreadable lineage */ }
  }

  private cancelLiveLineages(campaign: Campaign, reason: string): void {
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
          this.cancelLineageRootOf(task.id);
          this.taskManager.cancel(task.id as TaskId);
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
      let tipId: string | undefined;
      try {
        tipId = this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)?.id;
      } catch { continue; }
      if (!tipId) continue;
      try {
        this.taskManager.cancel(tipId as TaskId);
        getLoggerSafe().info("Cancelled a live lineage of a terminal campaign", {
          id: campaign.id,
          milestone: milestone.id,
          taskId: tipId,
          reason,
        });
      } catch { /* already settled */ }
    }
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
      try { this.taskManager.cancel(tipId as TaskId); } catch { /* already settled */ }
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
    milestone.startedAtMs = undefined;
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

  private scheduleAutoRevive(campaignId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const fresh = this.storage.get(campaignId);
          if (!fresh || fresh.state !== "failed" || !fresh.autoReviveAt) return;
          const stillCooling = allProvidersCoolingDownMs();
          if (stillCooling > 0) {
            // Horizon moved (another quota hit while parked) — follow it.
            fresh.autoReviveAt = Date.now() + stillCooling + 60_000;
            this.persist(fresh);
            this.scheduleAutoRevive(campaignId, stillCooling + 60_000);
            return;
          }
          if (
            this.storage.hasActiveForChat(fresh.chatId) ||
            this.storage.hasActiveForProject(this.projectRoot)
          ) {
            return; // someone else already continued the work
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
      this.cancelLiveLineages(campaign, `campaign already ${campaign.state}`);
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
      if (await this.tell(campaign, this.buildDeliveryReport(campaign))) {
        campaign.deliveryReported = true;
        this.persist(campaign);
      }
    }
    // Self-revival appointments are setTimeout-backed and die with the
    // process — re-arm them from the persisted timestamps (overdue ones fire
    // on a short delay so boot recovery settles first).
    for (const campaign of this.storage.listAwaitingAutoRevive()) {
      const dueInMs = Math.max((campaign.autoReviveAt ?? 0) - Date.now(), 120_000);
      getLoggerSafe().info("Re-arming campaign self-revival after restart", {
        id: campaign.id,
        dueInMs,
      });
      this.scheduleAutoRevive(campaign.id, dueInMs);
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
        // Read the PLANNER's wording, once, before anything is appended.
        visualGateArmed: /captur/i.test(m.prompt),
      }));
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

      await this.tell(
        campaign,
        `Milestone ladder ready (${campaign.milestones.length} sprints):\n${campaign.milestones
          .map((m) => `• ${m.title}`)
          .join("\n")}${styleSummary}\n\nSprint 1 starts now.`,
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
        this.scheduleAutoRevive(campaign.id, delayMs);
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
          this.taskManager.cancel(previousId as TaskId);
          getLoggerSafe().info("Cancelled the milestone's previous lineage before resubmitting", {
            id: campaign.id,
            milestone: milestone.id,
            taskId: previousId,
          });
        }
      } catch { /* already settled */ }
    }
    // THE FINAL SPRINT OWNS BUILD HYGIENE. The planner is told this too, but
    // a planner instruction is a suggestion an LLM may drop; this append is
    // deterministic, so the sprint that delivers ALWAYS carries the
    // requirement. Measured 2026-09-03: the delivered tree left 14 scenes
    // enabled in Build Settings and the report named none of them.
    if (campaign.currentMilestone === campaign.milestones.length - 1) {
      if (!milestone.prompt.includes("BUILD HYGIENE")) {
        milestone.prompt +=
          "\n\nBUILD HYGIENE (final sprint): when you are done, Build Settings must list EXACTLY ONE " +
          "enabled scene — the entry scene a person opens to play the game. Every verification or " +
          "scaffolding scene this campaign created along the way (InitTestScene*, *Verification, " +
          "*Verified, *Showcase, *Boundary, Assembled*) must be deleted or disabled in Build Settings. " +
          "Your report must name the entry scene and list every scene you deleted or disabled.";
      }
      this.attachStructureMeasurement(campaign, milestone);
    }
    milestone.status = "running";
    milestone.startedAtMs ??= Date.now();
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
        parentId: prevTaskId,
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
    const executorWillRetry =
      /Reaped:|Auto-retry \d+\/\d+|provider_unavailable|All providers (failed|are in cooldown)/i.test(output);
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
      this.scheduleAutoRevive(campaign.id, delayMs);
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

    // A reaped task ("Reaped: no progress…" / "Auto-retry N/M in ~Xs") is one
    // the executor's keep-alive WILL retry — but its backoff grows past this
    // grace window (measured live: retry at +120s vs grace 90s), so reacting
    // now double-submits the sprint. Wait one keep-alive horizon and look
    // again; if the retry landed, the lineage check above adopts it.
    // Provider-fleet outages join the defer set: an "all providers in
    // cooldown" block has a KNOWN expiry the keep-alive waits out — burning a
    // campaign attempt on it killed the campaign twice in four minutes
    // (measured live 2026-08-28 20:04-20:08).
    const executorWillRetry =
      /Reaped:|Auto-retry \d+\/\d+|provider_unavailable|All providers (failed|are in cooldown)/i.test(output);
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
        try { this.taskManager.cancel(tipId as TaskId); } catch { /* already settled */ }
      }
      const hours = Math.round(elapsedMs / 3_600_000);
      if (milestone.attempts < this.maxMilestoneAttempts) {
        milestone.startedAtMs = Date.now();
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
        this.taskManager.cancel(tipId as TaskId);
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
          };
        } | null)?.verification;
        milestone.testVerdict = verdict?.testsGreen === true ? verdict.detail : undefined;
        milestone.testVerdictUnfiltered = verdict?.testsGreen === true ? verdict.unfiltered : undefined;
        // Red names are kept even though the milestone is green: a sprint can
        // land green after a red run, and "which tests were red on the way"
        // is what a reader needs (audited 2026-09-03).
        milestone.testFailures = verdict?.failedTests;
        milestone.testFailuresOmitted = verdict?.failedTestsOmitted;
      } catch { /* evidence capture is best-effort */ }
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
      const deliveryProofMissing = !milestone.testVerdict || milestone.testVerdictUnfiltered !== true;
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
        const directive =
          "\n\nDELIVERY VERIFICATION REQUIRED: this is the final sprint, and " +
          (observedButFiltered
            ? "the only green test run observed was FILTERED — a subset you chose. "
            : "no test run was observed in the last attempt. ") +
          "Run the FULL PlayMode suite UNFILTERED against the assembled scene, capture a frame of " +
          "the running game, and report the suite's actual pass/fail counts. Delivery is not declared on a sprint " +
          "whose whole suite was never seen to pass.\n" +
          // Measured live 2026-09-03 23:30: the sprint answered this directive
          // with a JSON INVENTORY (module counts, prefab counts, a scene list)
          // and changed nothing. "Report the counts" was read as "produce a
          // report". The verb has to be unmistakable.
          "DO NOT AUDIT. An inventory of modules, prefabs, scenes or tests is not work and will be " +
          "rejected: run the tools, change the code, and let the suite's own output be your report.";
        // SAY EVERYTHING THAT IS WRONG, NOT ONE THING AT A TIME. The
        // structural check runs only after this gate passes, so a sprint stuck
        // here never learns its scenes render nothing — measured live
        // 2026-09-04 04:05: while bounced for a missing verdict, the sprint
        // ADDED two more CreatePrimitive scripts (5 → 7), moving away from the
        // requirement it had not been told about.
        const structureNow = this.measureDeliveryStructure(campaign);
        const combined = structureNow.refusal
          ? `${directive}\n\nALSO, ALREADY MEASURED: ${structureNow.refusal}`
          : directive;
        if (!milestone.prompt.includes("DELIVERY VERIFICATION REQUIRED")) milestone.prompt += combined;
        this.persist(campaign);
        getLoggerSafe().warn("Delivery blocked: final milestone has no observed test verdict", {
          id: campaign.id,
          milestone: milestone.id,
          bounce: milestone.deliveryVerificationBounces,
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
            "delivery. Leave EXACTLY ONE obvious entry scene enabled in Build Settings — the scene that " +
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
          const frame = selectGameplayFrame(this.projectRoot, milestone.startedAtMs ?? 0);
          const verdict = await judgeVisualConformance({ look, frame, visionProvider: this.visionProvider });
          milestone.visualConformance = renderVisualConformance(verdict, frame);
        } catch (err) {
          milestone.visualConformance =
            `**Does it look like the GDD?**\n- ⚠️ visual conformance not checked — ${err instanceof Error ? err.message : String(err)}.`;
        }
        // Coverage gate: "done" is measured against the GDD, not against the
        // ladder having run out. When scheduled items are missing, a
        // remediation sprint is appended instead of delivering short.
        const remediation = await this.buildCoverageRemediation(campaign);
        if (remediation) {
          milestone.status = "green";
          campaign.milestones.push(remediation);
          campaign.currentMilestone += 1;
          this.persist(campaign);
          await this.tell(
            campaign,
            `✅ ${milestone.title} — green.${commitNote}\n⚠️ Coverage audit against the GDD found gaps — appending **${remediation.title}** before delivery.`,
          );
          const id = campaign.id;
          this.resubmitSoon(id);
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
        if (await this.tell(campaign, `${this.buildDeliveryReport(campaign)}${commitNote}`)) {
          campaign.deliveryReported = true;
          this.persist(campaign);
        }
        return;
      }
      campaign.currentMilestone += 1;
      this.persist(campaign);
      await this.tell(
        campaign,
        `✅ ${milestone.title} — green.${commitNote} Sprint ${campaign.currentMilestone + 1}/${campaign.milestones.length} starts now.`,
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
    if (await this.escalateIfPastTimeBox(campaign, milestone)) return;

    const canRetry = milestone.attempts < this.maxMilestoneAttempts;
    // An outage-caused settle is not the sprint's failure: the run never got
    // to work. Charging it an attempt (measured 2026-09-01 16:16: attempts
    // 1→2 during a four-account quota wall) spends the milestone's budget on
    // the provider's downtime and pushes a healthy sprint toward a stop.
    // Checked BEFORE the blocked-nudge branch: an outage surfaces as
    // `blocked:provider_unavailable`, and that branch charged it (measured
    // 2026-09-02 02:36: m7 "blocked after 2 attempts" while all four
    // accounts were on quota walls).
    const outageCaused =
      /provider|cooldown|quota|rate.?limit/i.test(output) && allProvidersCoolingDownMs() > 0;
    // A graceful shutdown is the OPERATOR stopping the process, not the sprint
    // failing: the executor aborts in-flight runs with "shutting down" and the
    // work done so far is kept. Charging it ended a campaign on a routine
    // deploy — measured 2026-09-03 06:45: Sprint 7 "blocked after 2 attempts"
    // whose cause was a daemon restart, with no self-revival armed because it
    // was not an outage.
    const shutdownCaused = /shutting down|shutdown|durduruldu \(shutting/i.test(output);
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
      const cleaned = output
        .replace(/Reaped:[^.]*\./g, "")
        .replace(/Auto-retry \d+\/\d+ in ~\d+s\.?/g, "")
        .replace(/Transient failure —\s*/g, "")
        .trim();
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
      milestone.prompt += `\n\nThe previous attempt ended ${status}: ${(cleaned || output).slice(0, 400)}. Fix the root cause, do not repeat it — and do NOT spend this attempt auditing prior attempts: continue the sprint's actual work from the first unmet requirement.`;
      this.submitCurrentMilestone(campaign, { countAttempt: opts.countAttempt });
      return;
    }

    milestone.status = "failed";
    campaign.state = "failed";
    campaign.lastError = `${milestone.title} ${status} after ${milestone.attempts} attempts: ${output.slice(0, 200)}`;

    // A stop caused by a full provider outage is a scheduled wait, not a
    // defeat — park with a self-revival at the chain's recovery horizon.
    const outageWaitMs = allProvidersCoolingDownMs();
    if (outageWaitMs > 0 || /provider|cooldown|quota/i.test(output)) {
      const delayMs = Math.max(outageWaitMs, 60_000) + 60_000;
      campaign.autoReviveAt = Date.now() + delayMs;
      this.persist(campaign);
      this.scheduleAutoRevive(campaign.id, delayMs);
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
    const plannedMilestones = campaign.milestones.filter((m) => !m.id.startsWith("mcov"));
    if (
      milestone.id.startsWith("mcov") &&
      plannedMilestones.length > 0 &&
      plannedMilestones.every((m) => m.status === "green")
    ) {
      campaign.state = "done";
      campaign.deliveryReported = false;
      this.persist(campaign);
      getLoggerSafe().warn("Delivering with unclosed GDD gaps — remediation sprint spent its attempts", {
        id: campaign.id,
        milestone: milestone.id,
        attempts: milestone.attempts,
      });
      if (await this.tell(campaign, this.buildDeliveryReport(campaign))) {
        campaign.deliveryReported = true;
        this.persist(campaign);
      }
      return;
    }

    this.persist(campaign);
    await this.tell(
      campaign,
      `❌ Campaign stopped: **${milestone.title}** ended ${status} after ${milestone.attempts} attempts.\nCause: ${campaign.lastError}\nReply **kampanya devam** to revive it with a fresh attempt budget.`,
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
      const dirty = git(["status", "--porcelain"], 60_000)
        .split("\n")
        .filter((line) => {
          const path = line.slice(3).replace(/^"/, "");
          return line.trim() !== "" && !path.startsWith(".strada/") && !path.startsWith(".strada\\");
        })
        .join("\n")
        .trim();
      if (dirty === "") return "";
      git(["add", "-A", "--", ".", ":(exclude).strada"]);
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

  private freshCaptureEvidence(milestone: CampaignMilestone): { found: boolean } {
    const sinceMs = (() => {
      try {
        const rootId = milestone.taskId ? this.taskManager.findLineageRootId(milestone.taskId as TaskId) : null;
        const root = rootId ? this.taskManager.getStatus(rootId) : null;
        return root?.createdAt ?? Date.now() - 6 * 60 * 60_000;
      } catch {
        return Date.now() - 6 * 60 * 60_000;
      }
    })();
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
  private async buildCoverageRemediation(campaign: Campaign): Promise<CampaignMilestone | undefined> {
    const priorRounds = campaign.milestones.filter((m) => m.id.startsWith("mcov")).length;
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
      const gddRef = campaign.gddPath ?? "the GDD";
      return {
        id: `mcov${priorRounds + 1}`,
        title: `Coverage completion ${priorRounds + 1} — close the GDD gaps`,
        prompt: [
          `The build's milestone ladder finished, but auditing it against ${gddRef} found these scheduled items undelivered:`,
          ...missing.map((item) => `- ${item}`),
          "",
          `Implement each item exactly as ${gddRef} specifies it, following the project's existing module pattern.`,
          "Verification bar per item: headless compile green, the relevant PlayMode tests green and unfiltered, and a captured frame proving the bound visual renders (the project's style.json holds the derived art direction — generators read it).",
          "Commit per logical unit. End with a summary naming each item and the evidence it is done.",
          "This is an autonomous campaign sprint — do not ask the user questions; make the strong choice and continue.",
        ].join("\n"),
        status: "pending",
        attempts: 0,
      };
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
  private static readonly STRUCTURE_OPEN = "<<MEASURED NOW — what the shipped scenes render>>";
  private static readonly STRUCTURE_CLOSE = "<</MEASURED NOW>>";
  /** How much of the measurement the prompt carries before it says it trimmed. */
  private static readonly STRUCTURE_MAX_CHARS = 2_600;

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
    const stripped = milestone.prompt.replace(
      new RegExp(`\\n*${CampaignManager.escapeRegExp(open)}[\\s\\S]*?${CampaignManager.escapeRegExp(close)}`, "g"),
      "",
    );
    let structure: { refusal?: string; lines: string[] };
    try {
      structure = this.measureDeliveryStructure(campaign);
    } catch {
      // measureDeliveryStructure already degrades to a disclosure; a throw
      // here must not cost the sprint its prompt.
      milestone.prompt = stripped;
      return;
    }
    const body = [structure.refusal ? `REFUSED: ${structure.refusal}` : undefined, ...structure.lines]
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
      "entry scene, place the named prefabs in it, bind real materials/meshes/sprites to their " +
      "renderers instead of engine primitives, save the scene, and let a captured frame and the " +
      "unfiltered suite be your report.\n" +
      `${close}`;
  }

  private measureDeliveryStructure(campaign: Campaign): { refusal?: string; lines: string[] } {
    try {
      const report = assessBuiltAsSpecified(this.projectRoot);
      // The GDD's own dimensionality against the scenes (audited 2026-09-03):
      // it asked for "plump, glossy 3D-feel pigs" and nothing ever checked.
      // DELIVERY is judged against the whole GDD, so the whole text is read.
      const gddText =
        campaign.gddText ?? (campaign.gddPath ? readGddFile(this.projectRoot, campaign.gddPath) : undefined);
      const lines = [...report.disclosures, ...describeDimensionality(gddText, report).lines];
      // No silent caps: when the unmeasured list is trimmed, the trim says so.
      const shown = report.incomplete.slice(0, 5);
      for (const note of shown) lines.push(`NOT measured: ${note}`);
      if (report.incomplete.length > shown.length) {
        lines.push(`NOT measured: +${report.incomplete.length - shown.length} further item(s), same scan`);
      }
      return { refusal: report.refusal, lines };
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
    const lines = [
      unfinished.length === 0
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
