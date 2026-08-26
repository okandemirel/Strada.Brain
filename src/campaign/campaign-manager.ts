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
import { join } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES, TaskStatus } from "../tasks/types.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import type { CampaignStorage } from "./campaign-storage.js";
import { detectCampaignIntent } from "./campaign-intake.js";
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
  /** Submission budget per milestone (first try + retries) before the campaign fails loudly. */
  maxMilestoneAttempts?: number;
  /** GDD revision rounds at the approval gate before cancelling. */
  maxDraftAttempts?: number;
}

const APPROVE_RE = /^(evet|onay|onaylıyorum|yes|ok|okay|approve[ds]?|lgtm|devam|go ahead|go)[.!\s]*$/i;

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
  private eventsAttached = false;

  constructor(options: CampaignManagerOptions) {
    this.storage = options.storage;
    this.planner = options.planner;
    this.taskManager = options.taskManager;
    this.messenger = options.messenger;
    this.projectRoot = options.projectRoot;
    this.maxMilestoneAttempts = options.maxMilestoneAttempts ?? 2;
    this.maxDraftAttempts = options.maxDraftAttempts ?? 3;
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

    const intent = detectCampaignIntent(msg);
    if (!intent) return false;
    if (this.storage.hasActiveForChat(msg.chatId)) return false; // one build per chat

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
        const taskId =
          campaign.state === "drafting-gdd"
            ? campaign.draftTaskId
            : campaign.milestones[campaign.currentMilestone]?.taskId;
        const task = taskId ? this.taskManager.getStatus(taskId as TaskId) : null;
        if (task && ACTIVE_STATUSES.has(task.status)) return; // still in flight
        // The process died mid-task; the settlement events will never come.
        getLoggerSafe().info("Campaign resuming after restart", {
          id: campaign.id,
          state: campaign.state,
        });
        if (campaign.state === "drafting-gdd") {
          this.submitDraft(campaign);
        } else {
          this.submitCurrentMilestone(campaign);
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
          .join("\n")}\n\nSprint 1 starts now.`,
      );
      this.submitCurrentMilestone(campaign);
    } catch (err) {
      campaign.state = "failed";
      campaign.lastError = err instanceof Error ? err.message : String(err);
      this.persist(campaign);
      await this.tell(campaign, `Campaign could not plan the milestone ladder: ${campaign.lastError}`);
    }
  }

  private submitCurrentMilestone(campaign: Campaign): void {
    const milestone = campaign.milestones[campaign.currentMilestone];
    if (!milestone) {
      campaign.state = "done";
      this.persist(campaign);
      return;
    }
    milestone.status = "running";
    milestone.attempts += 1;
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

  private async handleTaskSettled(taskId: string, status: TaskStatus, output: string): Promise<void> {
    // Correlate by scanning active campaigns — the active set is tiny
    // (typically one), so this stays cheap.
    for (const campaign of this.storage.listActive()) {
      if (campaign.state === "drafting-gdd" && campaign.draftTaskId === taskId) {
        await this.onDraftSettled(campaign, status, output);
        return;
      }
      if (campaign.state === "executing") {
        const milestone = campaign.milestones[campaign.currentMilestone];
        if (milestone?.taskId === taskId) {
          await this.onMilestoneSettled(campaign, milestone, status, output);
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
      milestone.status = "green";
      milestone.resultExcerpt = output.slice(-500);
      const isLast = campaign.currentMilestone >= campaign.milestones.length - 1;
      if (isLast) {
        campaign.state = "done";
        this.persist(campaign);
        await this.tell(campaign, this.buildDeliveryReport(campaign));
        return;
      }
      campaign.currentMilestone += 1;
      this.persist(campaign);
      await this.tell(
        campaign,
        `✅ ${milestone.title} — green. Sprint ${campaign.currentMilestone + 1}/${campaign.milestones.length} starts now.`,
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
      this.submitCurrentMilestone(campaign);
      return;
    }
    if (canRetry) {
      milestone.prompt += `\n\nThe previous attempt ended ${status}: ${output.slice(0, 400)}. Fix the root cause, do not repeat it.`;
      this.submitCurrentMilestone(campaign);
      return;
    }

    milestone.status = "failed";
    campaign.state = "failed";
    campaign.lastError = `${milestone.title} ${status} after ${milestone.attempts} attempts: ${output.slice(0, 200)}`;
    this.persist(campaign);
    await this.tell(
      campaign,
      `❌ Campaign stopped: **${milestone.title}** ended ${status} after ${milestone.attempts} attempts.\nCause: ${campaign.lastError}\nThe repo holds everything up to the last green sprint.`,
    );
  }

  // ===========================================================================
  // INTERNAL — helpers
  // ===========================================================================

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
