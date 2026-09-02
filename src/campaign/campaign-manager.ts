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
import { allProvidersCoolingDownMs } from "../agents/providers/provider-outage.js";
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
      campaign.autoReviveAt = undefined;
      this.persist(campaign);
      await this.tell(campaign, "Reviving the campaign — replanning the milestone ladder from the GDD.");
      void this.planAndLaunch(campaign.id);
      return true;
    }

    await this.reviveAtCurrentMilestone(campaign, milestone);
    return true;
  }

  /** Reset the current milestone's budget and resubmit it (revive core). */
  private async reviveAtCurrentMilestone(campaign: Campaign, milestone: CampaignMilestone): Promise<void> {
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
            // Failed before the ladder existed (planning outage): replan from
            // the GDD, as tryHandleRevive does. Returning here silently was
            // how an armed pre-ladder revival no-oped (audited 2026-09-02).
            fresh.state = "planning";
            fresh.lastError = undefined;
            fresh.autoReviveAt = undefined;
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
      // A planning failure caused by a full provider outage is a scheduled
      // wait, not a defeat — park with a self-revival appointment exactly as
      // the milestone terminal path does. Audited 2026-09-02: this catch
      // armed nothing, so a quota wall hit before the ladder existed left the
      // campaign dead until a human typed "kampanya devam" (and that revive
      // re-entered the same unarmed catch while the wall persisted). The
      // planner's contract explicitly promised the caller would park.
      const outageWaitMs = allProvidersCoolingDownMs();
      if (outageWaitMs > 0 || /cooldown|quota|rate.?limit/i.test(campaign.lastError)) {
        const delayMs = Math.max(outageWaitMs, 60_000) + 60_000;
        campaign.autoReviveAt = Date.now() + delayMs;
        this.persist(campaign);
        this.scheduleAutoRevive(campaign.id, delayMs);
        await this.tell(
          campaign,
          `⏸️ Campaign paused by a provider outage before the milestone ladder could be planned.\n` +
            `Cause: ${campaign.lastError}\n` +
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
    milestone.status = "running";
    milestone.startedAtMs ??= Date.now();
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
      if (!promiseDead) {
        const waitMs = Math.min(Math.max(promisedMs + 60_000, 60_000), 12 * 60 * 60_000);
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

    if (campaign.draftAttempts >= this.maxDraftAttempts) {
      campaign.state = "failed";
      campaign.lastError = `GDD draft ${status}: ${output.slice(0, 200)}`;
      this.persist(campaign);
      await this.tell(campaign, `GDD drafting ${status} — campaign failed. Cause: ${campaign.lastError}`);
      return;
    }
    // An outage-caused settle is not the draft's failure and must not spend
    // a revision round (the same counter the designer's feedback spends).
    const outageCaused =
      /provider|cooldown|quota|rate.?limit/i.test(output) && allProvidersCoolingDownMs() > 0;
    if (outageCaused) {
      getLoggerSafe().info("GDD draft resubmitted without charging a revision round — provider outage", {
        id: campaign.id,
      });
    } else {
      campaign.draftAttempts += 1;
    }
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
    if (status === TaskStatus.completed && /captur/i.test(milestone.prompt)) {
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
      milestone.status = "green";
      milestone.resultExcerpt = output.slice(-500);
      milestone.commitNote = commitNote.trim() || undefined;
      try {
        const tip = milestone.taskId
          ? this.taskManager.findLatestLineageTask(milestone.taskId as TaskId)
          : null;
        const verdict = (tip as { verification?: { testsGreen?: boolean; detail: string } } | null)?.verification;
        milestone.testVerdict = verdict?.testsGreen === true ? verdict.detail : undefined;
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
      if (isLast && !milestone.testVerdict && !milestone.deliveryVerificationBounced) {
        // DELIVERY GATE: "the whole game runs" was only ever a sentence in the
        // planner's prompt — nothing in code required the final sprint to
        // have RUN the suite. A milestone whose task printed no recognizable
        // test result carries no verdict at all and sailed through
        // (audited 2026-09-01). One bounce, then the ladder proceeds so an
        // honest report can still be delivered.
        milestone.deliveryVerificationBounced = true;
        milestone.prompt +=
          "\n\nDELIVERY VERIFICATION REQUIRED: this is the final sprint, and no test run was observed in the " +
          "last attempt. Run the FULL PlayMode suite UNFILTERED against the assembled scene, capture a frame of " +
          "the running game, and report the suite's actual pass/fail counts. Delivery is not declared on a sprint " +
          "whose tests were never seen to run.";
        this.persist(campaign);
        getLoggerSafe().warn("Delivery blocked: final milestone has no observed test verdict", {
          id: campaign.id,
          milestone: milestone.id,
        });
        this.submitCurrentMilestone(campaign, { countAttempt: false });
        return;
      }
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

    // TIME-BOX: bounces and deferrals deliberately do not burn attempts, so a
    // sprint that keeps almost-finishing can spin indefinitely (measured
    // 2026-08-31: m6 ran 22h at attempts=1).
    if (await this.escalateIfPastTimeBox(campaign, milestone)) return;

    const canRetry = milestone.attempts < this.maxMilestoneAttempts;
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
    // An outage-caused settle is not the sprint's failure: the run never got
    // to work. Charging it an attempt (measured 2026-09-01 16:16: attempts
    // 1→2 during a four-account quota wall) spends the milestone's budget on
    // the provider's downtime and pushes a healthy sprint toward a stop.
    const outageCaused =
      /provider|cooldown|quota|rate.?limit/i.test(output) && allProvidersCoolingDownMs() > 0;
    if (canRetry && outageCaused) {
      getLoggerSafe().info("Milestone resubmitted without charging an attempt — provider outage", {
        id: campaign.id,
        milestone: milestone.id,
      });
      this.submitCurrentMilestone(campaign, { countAttempt: false });
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
      milestone.prompt = milestone.prompt.replace(
        /\n\nThe previous attempt ended [\s\S]*?Fix the root cause, do not repeat it\./g,
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
          `Cause: ${campaign.lastError}\n` +
          `Self-revival armed for ${new Date(campaign.autoReviveAt).toLocaleTimeString()} (when the provider chain recovers). Reply **kampanya devam** to revive sooner.`,
      );
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
        campaign.coverageAuditNote = undefined; // genuinely audited clean
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

  private buildDeliveryReport(campaign: Campaign): string {
    // EVIDENCE, not stored booleans. The report used to render only
    // milestone.status — while the manager held commit hashes, capture
    // counts, test verdicts and every bounce/escalation and threw them away
    // (audited 2026-09-01). A green reached by spending its evidence bounce
    // must not read like a clean one.
    const caveats: string[] = [];
    const lines = [
      `🏁 **Campaign delivery — game build complete**`,
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
            (m.deliveryVerificationBounced ? " (its one delivery-verification bounce was spent)" : ""),
        );
      }
      if (m.visualEvidenceBounced) { marks.push("visual-evidence bounce spent"); caveats.push(`${m.title}: needed a second attempt to produce a captured frame`); }
      if (m.noWorkBounced) { marks.push("no-work bounce spent"); caveats.push(`${m.title}: an attempt left the repository untouched`); }
      if ((m.timeBoxEscalations ?? 0) > 0) { marks.push(`scope narrowed ×${m.timeBoxEscalations}`); caveats.push(`${m.title}: ran past its time box and was narrowed to a smaller increment — remaining scope is in its final report`); }
      if (m.attempts > 1) marks.push(`${m.attempts} attempts`);
      lines.push(`• ${m.status === "green" ? "✅" : "❌"} ${m.title}${marks.length > 0 ? ` — ${marks.join("; ")}` : ""}`);
    }
    const frames = this.countCaptureFiles();
    lines.push("", `Captured frames on disk: ${frames}`);
    if (campaign.coverageAuditNote) {
      lines.push("", `⚠️ ${campaign.coverageAuditNote} — delivered WITHOUT a clean GDD-coverage check.`);
    }
    if (caveats.length > 0) {
      lines.push("", "**How these greens were reached:**", ...caveats.map((c) => `- ${c}`));
    }
    return lines.join("\n");
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
