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
import { join } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES, TaskStatus } from "../tasks/types.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import type { CampaignStorage } from "./campaign-storage.js";
import { detectCampaignIntent } from "./campaign-intake.js";
import { isTerminalFailureReport } from "../agents/autonomy/verifier-pipeline.js";
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
  taskManager: TaskManager;
  messenger: CampaignMessenger;
  projectRoot: string;
  /** Auto-retry budget per milestone before the campaign fails loudly. */
  maxMilestoneAttempts?: number;
  /** GDD revision rounds at the approval gate before cancelling. */
  maxDraftAttempts?: number;
  /** Grace before reacting to a bad settlement (tests shrink it). */
  retryAdoptionGraceMs?: number;
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
  private readonly taskManager: TaskManager;
  private readonly messenger: CampaignMessenger;
  private readonly projectRoot: string;
  private readonly maxMilestoneAttempts: number;
  private readonly maxDraftAttempts: number;
  private readonly retryAdoptionGraceMs: number;
  private readonly styleAnalysis?: import("../agents/style/style-analysis.js").StyleAnalysis;
  private eventsAttached = false;

  constructor(options: CampaignManagerOptions) {
    this.storage = options.storage;
    this.planner = options.planner;
    this.taskManager = options.taskManager;
    this.messenger = options.messenger;
    this.projectRoot = options.projectRoot;
    this.maxMilestoneAttempts = options.maxMilestoneAttempts ?? 2;
    this.maxDraftAttempts = options.maxDraftAttempts ?? 3;
    this.retryAdoptionGraceMs = options.retryAdoptionGraceMs ?? RETRY_ADOPTION_GRACE_MS;
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
      // Failed before/during planning — replan from the GDD.
      campaign.state = "planning";
      campaign.lastError = undefined;
      this.persist(campaign);
      await this.tell(campaign, "Reviving the campaign — replanning the milestone ladder from the GDD.");
      void this.planAndLaunch(campaign.id);
      return true;
    }

    milestone.attempts = 0;
    milestone.status = "pending";
    campaign.state = "executing";
    campaign.lastError = undefined;
    this.persist(campaign);
    await this.tell(
      campaign,
      `Reviving the campaign at **${milestone.title}** (sprint ${campaign.currentMilestone + 1}/${campaign.milestones.length}) with a fresh attempt budget.`,
    );
    this.submitCurrentMilestone(campaign);
    return true;
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
        } else if (task && task.status === TaskStatus.completed && campaign.state === "executing") {
          // Landed while we were down; the settlement event is gone. Judge it.
          const milestone = campaign.milestones[campaign.currentMilestone];
          if (milestone) {
            await this.onMilestoneOutcome(campaign, milestone, task.status, task.result ?? "", {
              countAttempt: false,
            });
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

      const ladder = await this.planner.planMilestones(textForPlanning, gddPath);
      campaign.milestones = ladder.milestones.map((m, i) => ({
        id: `m${i + 1}`,
        title: m.title,
        prompt: m.prompt,
        status: "pending",
        attempts: 0,
      }));
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
      this.persist(campaign);
      await this.tell(campaign, `Campaign could not plan the milestone ladder: ${campaign.lastError}`);
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
      campaign.state = "done";
      this.persist(campaign);
      return;
    }
    milestone.status = "running";
    if (opts?.countAttempt !== false) {
      milestone.attempts += 1;
    }
    campaign.state = "executing";
    const task = this.taskManager.submit(campaign.chatId, campaign.channelType, milestone.prompt, {
      userId: campaign.userId,
      conversationId: campaign.conversationId,
    });
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
      const gddPath = this.findNewestGddPath();
      if (!gddPath) {
        // The draft "completed" without producing the document — redo it with
        // the gap named, instead of gating on air.
        this.submitDraft(
          campaign,
          "The previous draft never wrote the GDD file under docs/. Write the file this time.",
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
    if (campaign.draftAttempts >= this.maxDraftAttempts) {
      campaign.state = "failed";
      campaign.lastError = `GDD draft ${status}: ${output.slice(0, 200)}`;
      this.persist(campaign);
      await this.tell(campaign, `GDD drafting ${status} — campaign failed. Cause: ${campaign.lastError}`);
      return;
    }
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
      await this.onMilestoneOutcome(campaign, milestone, status, output, { countAttempt: true });
      return;
    }

    // A block/failure may be the executor's own keep-alive parking the task
    // while it schedules a retry under a new id. React after a grace window,
    // against whatever the lineage says by then — not against this snapshot.
    const campaignId = campaign.id;
    const milestoneId = milestone.id;
    setTimeout(() => {
      void this.reconcileMilestoneAfterSettle(campaignId, milestoneId, status, output);
    }, this.retryAdoptionGraceMs);
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
    await this.onMilestoneOutcome(campaign, milestone, status, output, { countAttempt: true });
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
    if (status === TaskStatus.completed && isTerminalFailureReport(output)) {
      getLoggerSafe().warn("Milestone task completed with a terminal failure report — treating as failed", {
        id: campaign.id,
        milestone: milestone.id,
      });
      status = TaskStatus.failed;
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
      milestone.status = "green";
      milestone.resultExcerpt = output.slice(-500);
      const isLast = campaign.currentMilestone >= campaign.milestones.length - 1;
      if (isLast) {
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
          setTimeout(() => {
            const fresh = this.storage.get(id);
            if (!fresh || fresh.state !== "executing") return;
            this.submitCurrentMilestone(fresh);
          }, 0);
          return;
        }
        campaign.state = "done";
        this.persist(campaign);
        await this.tell(campaign, `${this.buildDeliveryReport(campaign)}${commitNote}`);
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
      setTimeout(() => {
        const fresh = this.storage.get(id);
        if (!fresh || fresh.state !== "executing") return;
        this.submitCurrentMilestone(fresh);
      }, 0);
      return;
    }

    const canRetry = milestone.attempts < this.maxMilestoneAttempts;
    if (canRetry && status === TaskStatus.blocked) {
      // Autonomous campaign context: a block is usually the agent asking a
      // person it was told not to need. Nudge with the mandate repeated.
      milestone.prompt +=
        "\n\nREMINDER: this is an autonomous campaign sprint — do not ask the user questions; make the strong choice and continue.";
      this.submitCurrentMilestone(campaign, { countAttempt: opts.countAttempt });
      return;
    }
    if (canRetry) {
      milestone.prompt += `\n\nThe previous attempt ended ${status}: ${output.slice(0, 400)}. Fix the root cause, do not repeat it.`;
      this.submitCurrentMilestone(campaign, { countAttempt: opts.countAttempt });
      return;
    }

    milestone.status = "failed";
    campaign.state = "failed";
    campaign.lastError = `${milestone.title} ${status} after ${milestone.attempts} attempts: ${output.slice(0, 200)}`;
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
    if (priorRounds >= CampaignManager.MAX_COVERAGE_ROUNDS) return undefined;
    const gddText =
      campaign.gddText ?? (campaign.gddPath ? readGddFile(this.projectRoot, campaign.gddPath) : undefined);
    if (!gddText) return undefined;
    try {
      const missing = await this.planner.auditCoverage(gddText, campaign.milestones);
      if (missing.length === 0) return undefined;
      const gddRef = campaign.gddPath ?? "the GDD";
      return {
        id: `mcov${priorRounds + 1}`,
        title: `Coverage completion ${priorRounds + 1} — close the GDD gaps`,
        prompt: [
          `The build's milestone ladder finished, but auditing it against ${gddRef} found these scheduled items undelivered:`,
          ...missing.map((item) => `- ${item}`),
          "",
          `Implement each item exactly as ${gddRef} specifies it, following the project's existing module pattern.`,
          "Verification bar per item: headless compile green, the relevant PlayMode tests green and unfiltered, and a bound visual where the item is a game element.",
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
      return undefined;
    }
  }

  private buildDeliveryReport(campaign: Campaign): string {
    const lines = [
      `🏁 **Campaign delivery — game build complete**`,
      `GDD: \`${campaign.gddPath ?? "n/a"}\``,
      ``,
      ...campaign.milestones.map((m) => `• ${m.status === "green" ? "✅" : "❌"} ${m.title}`),
    ];
    return lines.join("\n");
  }

  /** Newest *GDD*.md under docs/ by mtime — the file the draft just wrote. */
  private findNewestGddPath(): string | undefined {
    const docsDir = join(this.projectRoot, "docs");
    if (!existsSync(docsDir)) return undefined;
    const candidates = readdirSync(docsDir)
      .filter((f) => /gdd/i.test(f) && f.toLowerCase().endsWith(".md"))
      .map((f) => ({ f, mtime: statSync(join(docsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0] ? `docs/${candidates[0].f}` : undefined;
  }

  /**
   * Write a supplied GDD into docs/ so sprint prompts reference a durable,
   * committable path. Sanitizes the source filename; idempotent per name.
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
      if (!existsSync(absPath)) {
        mkdirSync(join(this.projectRoot, "docs"), { recursive: true });
        writeFileSync(absPath, gddText, "utf8");
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

  private async tell(campaign: Pick<Campaign, "chatId"> & Partial<Pick<Campaign, "id">>, markdown: string): Promise<void> {
    try {
      await this.messenger(campaign.chatId, markdown);
    } catch (err) {
      getLoggerSafe().warn("Campaign message delivery failed", {
        id: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function readGddFile(projectRoot: string, gddPath: string): string | undefined {
  try {
    return readFileSync(join(projectRoot, gddPath), "utf8");
  } catch {
    return undefined;
  }
}
