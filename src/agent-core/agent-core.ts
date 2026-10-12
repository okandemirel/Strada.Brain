/**
 * Agent Core
 *
 * The autonomous reasoning engine. Runs as part of HeartbeatLoop.tick().
 * Observes environment -> scores priorities -> reasons with LLM -> acts.
 *
 * Safety: tickInFlight guard, rate limiting, budget floor, priority threshold.
 */

import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { TaskId } from "../tasks/types.js";
import { DAEMON_RUN_CHANNEL } from "../tasks/types.js";
import { getLogger } from "../utils/logger.js";
import { allProvidersCoolingDownMs } from "../agents/providers/provider-outage.js";
import { ObservationEngine } from "./observation-engine.js";
import { createObservation, type AgentObservation } from "./observation-types.js";
import { PriorityScorer } from "./priority-scorer.js";
import { buildReasoningPrompt, parseReasoningResponse } from "./reasoning-prompt.js";
import type { ActionDecision, AgentCoreConfig, BudgetTrackerRef, InstinctRetrieverRef } from "./agent-core-types.js";
import { DEFAULT_AGENT_CORE_CONFIG } from "./agent-core-types.js";
import type { ProviderRouter } from "./routing/provider-router.js";
import { TaskClassifier } from "./routing/task-classifier.js";

const FOREGROUND_DECISION_DEFER_MINUTES = 5;
/**
 * audited 2026-09-02: ObservationEngine.collect() is destructive (it drains injections and
 * advances every one-shot observer's latch), so a tick that collects and then aborts before
 * acting would lose the batch for good — a broken build reported once stayed unreported until
 * the build turned green and broke again. An unacted batch is re-queued via defer(); one
 * minute clears the engine's 60s dedup window so the re-queued item is not suppressed.
 */
const UNACTED_BATCH_RECHECK_MINUTES = 1;
/** Unreadable reasoning rounds an observation absorbs before it is left alone. */
const MAX_UNPARSED_ROUNDS = 3;
/** …and how long it is held once that happens. */
const UNPARSED_COOLDOWN_MINUTES = 60;
/**
 * audited 2026-09-02: the `adjust` action wrote priorityThreshold straight from LLM output
 * (clamped only to 0-100) with no ceiling and no way back except another `adjust` — one
 * turn could silence every observation below 100 for the life of the process, and each
 * silenced batch was drained and destroyed. The override is now capped below the score of a
 * failed task outcome (70 + 5 severity + 5 actionable = 80), expires, and a dropped
 * actionable batch is deferred so it is re-evaluated once the threshold has relaxed.
 */
const LLM_PRIORITY_THRESHOLD_CEILING = 80;
const PRIORITY_THRESHOLD_OVERRIDE_TTL_MS = 30 * 60_000;
const BELOW_THRESHOLD_RECHECK_MINUTES = 5;
/** Messages decided before anyone has written to the daemon: the newest few are kept. */
const MAX_HELD_FOR_OPERATOR = 10;

export class AgentCore {
  /**
   * The daemon's own task identity (its submissions and their outcomes). NOT a chat a person
   * reads: no channel claims it, so a message sent to it is buffered for a socket that never
   * connects (web) or refused (Telegram). Human-visible output goes to {@link operatorChatId}.
   */
  static readonly AGENT_CHAT_ID = "agent-core";
  static readonly AGENT_CHANNEL_TYPE = DAEMON_RUN_CHANNEL;

  private tickInFlight = false;
  private lastReasoningMs = Date.now(); // Init to now to prevent immediate LLM call on restart
  private readonly config: AgentCoreConfig;
  private readonly logger = getLogger();
  /** Unreadable-reasoning rounds charged to each observation (Codex H#15). */
  private readonly unparsedRounds = new Map<string, number>();
  /** Said once per process, not once per round. */
  private unparsedReported = false;
  /**
   * The chat the user last wrote from — where notify/escalate go, as the NotificationRouter and
   * DigestReporter bind theirs (audit agent-core-goals#2: they went to "agent-core", which no
   * channel owns, and the user never saw a question asked of them).
   */
  private operatorChatId?: string;
  /** Decided while no chat was known; delivered on the first tick that has one. */
  private readonly heldForOperator: string[] = [];
  /** Maps submitted task IDs to the instinct IDs that informed the decision */
  private readonly taskInstinctMap = new Map<TaskId, { instinctIds: string[]; createdAt: number }>();
  /** Multi-provider routing: selects best provider per task. */
  private readonly providerRouter?: ProviderRouter;
  private readonly taskClassifier = new TaskClassifier();
  /** ProviderManager reference — needed to materialize routing decisions. */
  private readonly providerManagerRef?: { getProviderByName(name: string): IAIProvider | null };
  /** Runtime overrides set by the 'adjust' action */
  private runtimeOverrides: {
    priorityThreshold?: number;
    /** When the LLM-set priorityThreshold lapses back to config.minObservationPriority. */
    priorityThresholdExpiresAt?: number;
    sourceBoosts: Map<string, number>;
    /** When each LLM-set source boost lapses — the same TTL as the threshold override. */
    sourceBoostExpiresAt: Map<string, number>;
    reasoningIntervalMs?: number;
  } = { sourceBoosts: new Map(), sourceBoostExpiresAt: new Map() };

  constructor(
    private readonly observationEngine: ObservationEngine,
    private readonly priorityScorer: PriorityScorer,
    private readonly provider: IAIProvider,
    private readonly taskManager: TaskManager,
    private readonly channel: IChannelAdapter,
    private readonly budgetTracker: BudgetTrackerRef,
    private readonly instinctRetriever?: InstinctRetrieverRef,
    config?: Partial<AgentCoreConfig>,
    providerRouter?: ProviderRouter,
    providerManagerRef?: { getProviderByName(name: string): IAIProvider | null },
  ) {
    this.config = { ...DEFAULT_AGENT_CORE_CONFIG, ...config };
    this.providerRouter = providerRouter;
    this.providerManagerRef = providerManagerRef;
  }

  /**
   * Main agent tick — called from HeartbeatLoop.
   * Maintenance (outcome check) -> Observe -> Orient -> Decide -> Act
   */
  async tick(): Promise<void> {
    // Guard: prevent concurrent tick overlap
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    // The collected batch, hoisted so the catch can put it back if no ACT arm consumed it.
    let batch: AgentObservation[] = [];
    let consumed = false;
    try {
      // Already decided: delivering it needs no reasoning call, budget or provider.
      if (this.heldForOperator.length > 0 && this.operatorChatId) await this.deliverHeldForOperator();

      // Rate limit (respect runtime override if set)
      const effectiveIntervalMs = this.runtimeOverrides.reasoningIntervalMs ?? this.config.minReasoningIntervalMs;
      if (Date.now() - this.lastReasoningMs < effectiveIntervalMs) return;

      // Provider guard: a tick into a full cooldown is a guaranteed error
      // every two minutes (measured 2026-09-08 01:12-01:16: "AgentCore tick
      // error … All providers are in cooldown", observations re-queued each
      // time). Nothing to reason with — keep the observations and wait.
      const cooldownMs = allProvidersCoolingDownMs();
      if (cooldownMs > 0) {
        this.logger.debug("AgentCore: skipping tick — every provider is cooling down", { waitMs: cooldownMs });
        return;
      }

      // Budget guard
      const budget = this.budgetTracker.getUsage();
      // budget.pct is a 0.0-1.0 decimal fraction from BudgetTracker
      if (budget.pct >= (1.0 - this.config.budgetFloorPct / 100)) {
        this.logger.debug("AgentCore: skipping tick — budget floor reached", { budgetPct: budget.pct });
        return;
      }

      // Check for completed tasks and inject outcome observations
      this.checkCompletedTasks();

      // 1. OBSERVE
      const observations = this.observationEngine.collect();
      if (observations.length === 0) return;
      batch = observations;

      // 2. ORIENT — score and rank
      const ranked = await this.priorityScorer.scoreAll(observations);

      // Apply runtime source boosts in-place. The pre-boost score is kept: an observation a
      // negative boost pushed under the threshold was silenced by the override, not by its score.
      this.expireSourceBoosts();
      const unboosted = new Map(ranked.map((o) => [o.id, o.priority]));
      for (const obs of ranked) {
        const boost = this.runtimeOverrides.sourceBoosts.get(obs.source);
        if (boost) {
          (obs as { priority: number }).priority = Math.min(100, Math.max(0, obs.priority + boost));
        }
      }
      // Re-sort after boosts
      if (this.runtimeOverrides.sourceBoosts.size > 0) {
        ranked.sort((a, b) => b.priority - a.priority);
      }

      const effectivePriorityThreshold = this.effectivePriorityThreshold();
      if (ranked.length === 0 || ranked[0]!.priority < effectivePriorityThreshold) {
        this.logger.debug("AgentCore: skipping tick — no high-priority observations", {
          count: ranked.length,
          topPriority: ranked[0]?.priority ?? 0,
          threshold: effectivePriorityThreshold,
        });
        // The batch was drained from one-shot observers. What the LLM-raised threshold silenced
        // (would have passed the configured threshold) is kept for a look once the override lapses;
        // what falls below the configured threshold is the steady state and is not re-queued.
        // Re-queued as COLLECTED: the ranked copy carries the scored (and boosted) priority, so a
        // demoted observation would come back demoted — and be scored a second time.
        const collected = new Map(observations.map((o) => [o.id, o]));
        const silencedByOverride = ranked
          .filter((o) => Math.max(o.priority, unboosted.get(o.id) ?? o.priority) >= this.config.minObservationPriority)
          .map((o) => collected.get(o.id) ?? o);
        if (silencedByOverride.length > 0) {
          this.requeueUnacted(silencedByOverride, "below-llm-threshold", BELOW_THRESHOLD_RECHECK_MINUTES);
        }
        return;
      }

      // 3. DECIDE — LLM reasoning
      this.lastReasoningMs = Date.now();

      // Gather context — instinct insights are confidence-ranked by the retriever
      let learnedInsights: string[] = [];
      let matchedInstinctIds: string[] = [];
      if (this.instinctRetriever) {
        try {
          const topSummary = ranked.slice(0, 3).map(o => o.summary).join("; ");
          const result = await this.instinctRetriever.getInsightsForTask(topSummary);
          learnedInsights = result.insights;
          matchedInstinctIds = result.matchedInstinctIds;
          if (learnedInsights.length > 0) {
            this.logger.debug("AgentCore: instinct insights retrieved", {
              count: learnedInsights.length,
              matchedIds: matchedInstinctIds.length,
            });
          }
        } catch {
          // Non-fatal — continue without insights
        }
      }

      // Get active task count for context
      let activeTaskCount = 0;
      let activeForegroundTaskCount = 0;
      try {
        const tasks = this.taskManager.listTasks(AgentCore.AGENT_CHAT_ID);
        activeTaskCount = tasks.filter(t => t.status === "executing" || t.status === "pending").length;
        activeForegroundTaskCount = this.taskManager.countActiveForegroundTasks?.([AgentCore.AGENT_CHAT_ID]) ?? 0;
      } catch {
        // Non-fatal
      }

      const prompt = buildReasoningPrompt({
        observations: ranked,
        budgetRemainingPct: Math.max(0, Math.round((1.0 - budget.pct) * 100)),
        activeTaskCount,
        activeForegroundTaskCount,
        learnedInsights,
        recentHistory: this.observationEngine.getHistory(5),
      });

      // Task-aware provider routing
      let activeProvider: IAIProvider = this.provider;
      if (this.providerRouter && this.providerManagerRef && ranked.length > 0) {
        try {
          const taskClass = this.taskClassifier.classify(ranked[0]!.summary);
          const routed = this.providerRouter.resolve(taskClass);
          if (routed) {
            const resolved = this.providerManagerRef.getProviderByName(routed.provider);
            if (resolved) activeProvider = resolved;
          }
        } catch {
          // Non-fatal — use default provider
        }
      }

      // Reasoning prompt goes as user message, not system prompt
      const response = await activeProvider.chat(
        "You are an autonomous agent that observes the environment and decides what to do.",
        [{ role: "user" as const, content: prompt }],
        [],
      );
      const decision = parseReasoningResponse(response.text);

      this.logger.info("AgentCore decision", {
        action: decision.action,
        reasoning: decision.reasoning.slice(0, 200),
        observationCount: ranked.length,
        topObservation: ranked[0]?.summary.slice(0, 100),
      });

      // A DECISION THAT CANNOT BE CARRIED OUT is not a decision. "execute"
      // with no goal, "batch" with no ids, "notify" with no message: the arm
      // did nothing, the unreadable-round charge was cleared and every
      // observation was requeued — eight reasoning calls, zero submissions
      // (Codex 2026-09-11 O#20). It is charged exactly like an unreadable one.
      const unusable =
        (decision.action === "execute" && !decision.goal)
        || (decision.action === "batch" && (!decision.goal || !(decision.batchObservationIds ?? []).length))
        || (decision.action === "notify" && !decision.message)
        || (decision.action === "defer" && !decision.deferMinutes);
      if (unusable) {
        const exhausted = this.chargeUnparsed(batch);
        this.logger.warn("AgentCore decision cannot be carried out", {
          action: decision.action,
          reasoning: decision.reasoning.slice(0, 200),
          exhausted,
        });
        this.requeueUnacted(
          batch,
          `unusable-${decision.action}`,
          exhausted ? UNPARSED_COOLDOWN_MINUTES : UNACTED_BATCH_RECHECK_MINUTES,
        );
        consumed = true;
        return;
      }

      // WHICH observations this decision actually handled. `consumed` used to
      // mean "the whole batch is answered", so a decision that submitted a
      // goal for ONE failure silently dropped every other actionable
      // observation collected with it — and a one-shot observer does not
      // report the same unchanged failure again (Codex 2026-09-11 M#3).
      const handled = new Set<string>();
      // A notify/escalate put off for a foreground task postpones the decision about the WHOLE
      // batch; set when that happens so the rest of the batch comes back with it.
      let postponedForForeground = false;

      // 4. ACT
      switch (decision.action) {
        case "execute":
          if (decision.goal) {
            const refusal = whyNotActionableWork(ranked, decision.batchObservationIds);
            if (refusal) {
              this.refuseGoal(decision.action, decision.goal, refusal, ranked);
              break;
            }
            const task = this.taskManager.submit(
              AgentCore.AGENT_CHAT_ID,
              AgentCore.AGENT_CHANNEL_TYPE,
              decision.goal,
              { origin: "daemon" as const, ...workspacePolicyFor(ranked, decision.goal) },
            );
            // audited 2026-09-02: tracking was gated on `matchedInstinctIds.length > 0`, so a goal
            // that matched no instinct (every goal at cold start, and with no retriever wired) was
            // never followed up — its failure produced no task-outcome observation. Every submitted
            // task is tracked; an empty instinctIds list makes the instinct-credit loop a no-op.
            this.taskInstinctMap.set(task.id, { instinctIds: matchedInstinctIds, createdAt: Date.now() });
            // WHAT THE DECISION NAMED. Marking ranked[0] handled whatever the
            // goal was about consumed the wrong failure: "Fix Broken B"
            // acknowledged A and deferred B (Codex 2026-09-11 O#19). With no
            // ids named, only a single-observation batch is unambiguous.
            const named = new Set(decision.batchObservationIds ?? []);
            const answered = named.size > 0
              ? ranked.filter((o) => named.has(o.id))
              : ranked.filter((o) => o.actionable).length === 1
              ? ranked.filter((o) => o.actionable)
              : [];
            for (const obs of answered) {
              this.priorityScorer.recordAction(obs);
              handled.add(obs.id);
            }
            // The top observation is still recorded for dedup, so a requeued
            // batch cannot resubmit the same goal on the next tick.
            if (ranked[0] && !handled.has(ranked[0].id)) this.priorityScorer.recordAction(ranked[0]);
            this.logger.info("AgentCore: submitted goal", { goal: decision.goal.slice(0, 200) });
          }
          break;

        case "notify":
          if (decision.message) {
            if (this.deferHumanVisibleDecision(decision, ranked[0], activeForegroundTaskCount)) {
              if (ranked[0]) handled.add(ranked[0].id);
              postponedForForeground = true;
              break;
            }
            await this.sendToOperator(decision.message, "notification");
          }
          break;

        case "escalate":
          if (decision.question) {
            if (this.deferHumanVisibleDecision(decision, ranked[0], activeForegroundTaskCount)) {
              if (ranked[0]) handled.add(ranked[0].id);
              postponedForForeground = true;
              break;
            }
            await this.sendToOperator(`[Agent needs input] ${decision.question}`, "escalation");
          }
          break;

        case "batch":
          if (decision.batchObservationIds && decision.batchObservationIds.length > 0 && decision.goal) {
            const refusal = whyNotActionableWork(ranked, decision.batchObservationIds);
            if (refusal) {
              this.refuseGoal(decision.action, decision.goal, refusal, ranked);
              break;
            }
            const idSet = new Set(decision.batchObservationIds);
            const matched = ranked.filter(o => idSet.has(o.id));
            const batchContext = matched.map(o => `[${o.source}] ${o.summary}`).join("; ");
            const compoundGoal = `${decision.goal} (context: ${batchContext})`;
            const task = this.taskManager.submit(
              AgentCore.AGENT_CHAT_ID,
              AgentCore.AGENT_CHANNEL_TYPE,
              compoundGoal,
              { origin: "daemon" as const, ...workspacePolicyFor(matched, compoundGoal) },
            );
            // audited 2026-09-02: same unconditional tracking as the execute arm (see above).
            this.taskInstinctMap.set(task.id, { instinctIds: matchedInstinctIds, createdAt: Date.now() });
            for (const obs of matched) { this.priorityScorer.recordAction(obs); handled.add(obs.id); }
            this.logger.info("AgentCore: submitted batch goal", { goal: compoundGoal.slice(0, 200), batchSize: matched.length });
          }
          break;

        case "defer":
          if (ranked[0] && decision.deferMinutes) {
            this.observationEngine.defer(ranked[0], decision.deferMinutes);
            handled.add(ranked[0].id);
            this.logger.info("AgentCore: deferred observation", { id: ranked[0].id, minutes: decision.deferMinutes });
          }
          break;

        case "adjust":
          if (decision.adjustments) {
            if (decision.adjustments.priorityThreshold !== undefined) {
              const requested = decision.adjustments.priorityThreshold;
              const applied = Math.min(requested, LLM_PRIORITY_THRESHOLD_CEILING);
              this.runtimeOverrides.priorityThreshold = applied;
              this.runtimeOverrides.priorityThresholdExpiresAt = Date.now() + PRIORITY_THRESHOLD_OVERRIDE_TTL_MS;
              if (applied !== requested) {
                this.logger.info("AgentCore: priorityThreshold override clamped", {
                  requested,
                  applied,
                  ceiling: LLM_PRIORITY_THRESHOLD_CEILING,
                  expiresInMinutes: PRIORITY_THRESHOLD_OVERRIDE_TTL_MS / 60_000,
                });
              }
            }
            if (decision.adjustments.sourceBoost) {
              const { source, delta } = decision.adjustments.sourceBoost;
              this.runtimeOverrides.sourceBoosts.set(source, delta);
              // Expires like the threshold override: one reasoning turn (steerable by observation
              // text) must not demote a whole source for the life of the process.
              this.runtimeOverrides.sourceBoostExpiresAt.set(source, Date.now() + PRIORITY_THRESHOLD_OVERRIDE_TTL_MS);
            }
            if (decision.adjustments.reasoningIntervalMs !== undefined) {
              this.runtimeOverrides.reasoningIntervalMs = decision.adjustments.reasoningIntervalMs;
            }
            this.logger.info("AgentCore: adjusted runtime overrides", { adjustments: decision.adjustments });
          }
          break;

        case "wait":
          // Intentionally idle — unless nothing decided it. A reply that could
          // not be parsed is not a choice to wait, and marking the batch
          // consumed threw away the observation it described: the observer had
          // already recorded the failure as reported, so the repair never
          // happened (Codex 2026-09-11 F#13).
          if (decision.unparsed === true) {
            // BOUNDED: requeueing for ever is its own failure mode — a
            // provider that never returns JSON produced 100 calls, 100
            // requeues and zero repairs (Codex 2026-09-11 H#15). After a few
            // rounds the observation is left alone with a long recheck and
            // the trouble is said out loud once.
            const exhausted = this.chargeUnparsed(batch);
            this.logger.warn("AgentCore could not read its own reasoning", {
              reasoning: decision.reasoning,
              observations: batch.length,
              exhausted,
            });
            if (exhausted) {
              this.requeueUnacted(batch, "unparsed-decision-exhausted", UNPARSED_COOLDOWN_MINUTES);
              if (!this.unparsedReported) {
                this.unparsedReported = true;
                // sendToOperator never rejects: an offline channel used to be an
                // unhandled rejection in the daemon that is carrying out the
                // recovery (Codex 2026-09-11 J#18).
                void this.sendToOperator(
                  `I could not read my own reasoning ${MAX_UNPARSED_ROUNDS} times in a row (${decision.reasoning}). ` +
                    "The observations are held for an hour; the reasoning provider needs a look.",
                  "unparsed-reasoning warning",
                );
              }
            } else {
              this.requeueUnacted(batch, "unparsed-decision", UNACTED_BATCH_RECHECK_MINUTES);
            }
            consumed = true;
            return;
          }
          break;
      }
      // A decision that PARSED clears the charge: the counter is meant to
      // measure consecutive unreadable rounds, and never clearing it turned
      // an intermittent provider into an hour's hold (Codex 2026-09-11 J#17).
      for (const obs of batch) this.unparsedRounds.delete(obs.id);
      // Every ACT arm above ran to completion on this batch (an LLM "wait" is a
      // decision too) — but only for the observations it named. The rest go
      // back, so a second broken module is not forgotten because the first one
      // was fixed (Codex 2026-09-11 M#3).
      // …only for the arms that act on a SUBSET. "wait" and "adjust" are
      // decisions about the whole batch (and the threshold path defers what it
      // drops itself); "execute" and "batch" answer the observations they
      // name and used to acknowledge the rest. "defer" puts off the top
      // observation only, and a notify/escalate postponed for a foreground task
      // put off only the top one too — the rest of the batch was destroyed
      // with them (audit agent-core-goals#3).
      if (decision.action === "execute" || decision.action === "batch" || decision.action === "defer" || postponedForForeground) {
        const unhandled = batch.filter((o) => !handled.has(o.id));
        if (unhandled.length > 0) {
          this.requeueUnacted(
            unhandled,
            postponedForForeground ? "postponed-for-foreground" : `unhandled-by-${decision.action}`,
            postponedForForeground ? FOREGROUND_DECISION_DEFER_MINUTES : UNACTED_BATCH_RECHECK_MINUTES,
          );
        }
      }
      consumed = true;
    } catch (error) {
      this.logger.error("AgentCore tick error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!consumed && batch.length > 0) {
        this.requeueUnacted(batch, "tick-error", UNACTED_BATCH_RECHECK_MINUTES);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Check if a tick is currently in progress */
  isTickInFlight(): boolean {
    return this.tickInFlight;
  }

  /**
   * A person wrote to the daemon: their chat is where AgentCore speaks from now on, and the
   * observers that track the user hear about it (audit agent-core-goals#7: the
   * UserActivityObserver was built inline and never told, so it reported the user idle for good).
   */
  onUserActivity(chatId?: string): void {
    if (chatId) this.operatorChatId = chatId;
    this.observationEngine.recordUserActivity();
  }

  /**
   * Say something to the operator. With no chat known yet the text is held for the first tick
   * that has one, not sent to a chat id no channel owns. Never rejects.
   */
  private async sendToOperator(text: string, what: string): Promise<void> {
    const chatId = this.operatorChatId;
    if (!chatId) {
      if (this.heldForOperator.length >= MAX_HELD_FOR_OPERATOR) this.heldForOperator.shift();
      this.heldForOperator.push(text);
      this.logger.warn(`AgentCore: ${what} held — no one has written to the daemon yet`, {
        held: this.heldForOperator.length,
        text: text.slice(0, 120),
      });
      return;
    }
    try {
      await this.channel.sendText(chatId, text);
    } catch (error) {
      this.logger.warn(`AgentCore: ${what} could not be delivered`, {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deliverHeldForOperator(): Promise<void> {
    if (!this.operatorChatId) return;
    // The same courtesy a fresh notify/escalate gets: not in the middle of the user's own task.
    let foreground = 0;
    try {
      foreground = this.taskManager.countActiveForegroundTasks?.([AgentCore.AGENT_CHAT_ID]) ?? 0;
    } catch {
      // Unknown is not busy: the tick itself only runs between foreground tasks.
    }
    if (foreground > 0) return;
    for (const text of this.heldForOperator.splice(0)) {
      await this.sendToOperator(text, "held message");
    }
  }

  /** Drop LLM-set source boosts whose TTL has passed. */
  private expireSourceBoosts(): void {
    const now = Date.now();
    for (const [source, expiresAt] of this.runtimeOverrides.sourceBoostExpiresAt) {
      if (now < expiresAt) continue;
      this.logger.info("AgentCore: sourceBoost override expired", {
        source,
        was: this.runtimeOverrides.sourceBoosts.get(source),
      });
      this.runtimeOverrides.sourceBoosts.delete(source);
      this.runtimeOverrides.sourceBoostExpiresAt.delete(source);
    }
  }

  /** The LLM-set threshold while it lasts; config.minObservationPriority once it has expired. */
  private effectivePriorityThreshold(): number {
    const { priorityThreshold, priorityThresholdExpiresAt } = this.runtimeOverrides;
    if (priorityThreshold === undefined) return this.config.minObservationPriority;
    if (priorityThresholdExpiresAt !== undefined && Date.now() >= priorityThresholdExpiresAt) {
      this.logger.info("AgentCore: priorityThreshold override expired", {
        was: priorityThreshold,
        now: this.config.minObservationPriority,
      });
      delete this.runtimeOverrides.priorityThreshold;
      delete this.runtimeOverrides.priorityThresholdExpiresAt;
      return this.config.minObservationPriority;
    }
    return priorityThreshold;
  }

  /**
   * Put a batch that no ACT arm consumed back into the engine. Only actionable observations are
   * re-queued (informational ones — "Build succeeded", user idle — carry nothing to act on).
   * Deferred, not injected: defer() re-surfaces past the engine's dedup window, whereas inject()
   * would be suppressed as a duplicate on the very next collect.
   */
  /**
   * Charge one unreadable reasoning round to every observation in the batch,
   * and say whether any of them has now spent its patience. A successful
   * parse clears the count (see tick()'s ACT arms).
   */
  private chargeUnparsed(batch: readonly AgentObservation[]): boolean {
    let exhausted = false;
    for (const obs of batch) {
      const spent = (this.unparsedRounds.get(obs.id) ?? 0) + 1;
      this.unparsedRounds.set(obs.id, spent);
      if (spent >= MAX_UNPARSED_ROUNDS) exhausted = true;
    }
    // The map is per-observation and observations are finite; still, a daemon
    // running for weeks should not accumulate ids for ever.
    if (this.unparsedRounds.size > 500) this.unparsedRounds.clear();
    return exhausted;
  }

  private requeueUnacted(batch: readonly AgentObservation[], cause: string, recheckMinutes: number): void {
    const actionable = batch.filter((o) => o.actionable);
    for (const obs of actionable) {
      this.observationEngine.defer(obs, recheckMinutes);
    }
    this.logger.info("AgentCore: re-queued unacted observations", {
      cause,
      requeued: actionable.length,
      dropped: batch.length - actionable.length,
      recheckMinutes,
      topObservation: batch[0]?.summary.slice(0, 120),
    });
  }

  /**
   * Nothing is submitted and nothing is marked handled: the informational observations are
   * dropped by the requeue after the switch, and any actionable ones beside them come back.
   */
  private refuseGoal(
    action: "execute" | "batch",
    goal: string,
    cause: string,
    ranked: readonly AgentObservation[],
  ): void {
    this.logger.info(`AgentCore: refused a goal that ${cause}`, {
      action,
      goal: goal.slice(0, 200),
      topObservation: ranked[0]?.summary.slice(0, 120),
    });
  }

  private deferHumanVisibleDecision(
    decision: Pick<ActionDecision, "action">,
    observation: AgentObservation | undefined,
    activeForegroundTaskCount: number,
  ): boolean {
    if (activeForegroundTaskCount <= 0) {
      return false;
    }

    if (observation) {
      this.observationEngine.defer(observation, FOREGROUND_DECISION_DEFER_MINUTES);
    }

    this.logger.info("AgentCore: deferred human-visible decision during foreground task", {
      action: decision.action,
      activeForegroundTaskCount,
      observationSource: observation?.source,
      topObservation: observation?.summary.slice(0, 120),
      deferMinutes: observation ? FOREGROUND_DECISION_DEFER_MINUTES : 0,
    });
    return true;
  }

  /** Check tracked tasks for completion and inject outcome observations. */
  private checkCompletedTasks(): void {
    const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    for (const [taskId, entry] of this.taskInstinctMap.entries()) {
      // TTL cleanup: remove stale entries that never completed
      if (now - entry.createdAt > TTL_MS) {
        this.taskInstinctMap.delete(taskId);
        continue;
      }

      const task = this.taskManager.getStatus(taskId);
      if (!task) continue; // Task not found in storage — skip, don't penalize instincts

      if (task.status === "completed" || task.status === "failed" || task.status === "blocked" || task.status === "cancelled") {
        const success = task.status === "completed";

        this.observationEngine.inject(
          createObservation("task-outcome", `Agent task ${success ? "succeeded" : "failed"}: ${task.title ?? taskId}`, {
            priority: success ? 40 : 70,
            context: { taskId, success },
          }),
        );

        import("../learning/learning-metrics.js").then(({ LearningMetrics }) => {
          LearningMetrics.getInstance().recordOutcome({ success, instinctCount: entry.instinctIds.length });
        }).catch(() => { /* non-fatal */ });

        if (this.instinctRetriever?.recordOutcome) {
          for (const id of entry.instinctIds) {
            this.instinctRetriever.recordOutcome(id, success).catch((err) => {
              getLogger().debug("Instinct outcome recording failed", { error: err instanceof Error ? err.message : String(err) });
            });
          }
        }

        this.taskInstinctMap.delete(taskId);
      }
    }
  }

  /** Get current runtime overrides (for testing/diagnostics) */
  getRuntimeOverrides(): {
    priorityThreshold?: number;
    priorityThresholdExpiresAt?: number;
    sourceBoosts: Map<string, number>;
    sourceBoostExpiresAt: Map<string, number>;
    reasoningIntervalMs?: number;
  } {
    return this.runtimeOverrides;
  }

  /** Stop the observation engine and clean up resources */
  stop(): void {
    this.observationEngine.stop();
  }
}

/**
 * Why a goal does not answer work in this batch, or undefined when it does: it answers the
 * observations it names, or — naming none — the batch itself. A trigger fire the heartbeat already
 * turned into its own task or approval is marked actionable:false, and a goal built only on it ran
 * that work a second time (review of 254fa61a: one deploy fire, one reasoning call, one task
 * submitted against its label — the run heartbeat-loop stopped starting on 2026-09-02).
 *
 * A goal that names nothing cannot say which observation it answers, so beside any informational
 * observation it is refused: judged against the whole batch, "Deploy now" beside a real build
 * failure was submitted, the fire's work ran a second time, and the failure was marked handled and
 * dropped. No score exempts one — the model is shown every ranked observation, and the threshold
 * and a source's score are both moved by its own 'adjust' (review of e54153db). The refusal costs
 * one round: the requeue drops the informational observations and brings the actionable ones back.
 * Ids that are all outside the batch name nothing here either, and submitted a goal that marked
 * nothing handled, so the same work came back to be submitted again.
 */
function whyNotActionableWork(
  ranked: ReadonlyArray<{ id: string; actionable: boolean }>,
  namedIds: readonly string[] | undefined,
): string | undefined {
  const named = new Set(namedIds ?? []);
  const answered = ranked.filter((o) => named.has(o.id));
  if (answered.length > 0) {
    return answered.some((o) => o.actionable) ? undefined : "answers only informational observations";
  }
  if (named.size > 0) return "names only observations outside this batch";
  if (ranked.some((o) => !o.actionable)) return "names no observation beside an informational one it may answer";
  return ranked.length > 0 ? undefined : "has no observation to answer";
}

/**
 * A goal driven by a working-tree observation is ABOUT the project's real
 * tree: it must run there, not in a worktree lease seeded from HEAD. Measured
 * 2026-09-10 22:31: "investigate the 1118 uncommitted changes" ran in a lease
 * and reported a clean tree. Every other goal keeps the lease.
 */
/**
 * Words that say the goal is ABOUT the tree's current state.
 *
 * The tree words used as a NOUN PHRASE are excluded: "the git status panel"
 * names a component someone is building, not the repository's state, and
 * documenting it in docs/panel.md was sent into the shared project because of
 * that word (Codex 2026-09-11 E#14, G#9).
 */
export const WORKING_TREE_GOAL_RE =
  /\b(?:uncommitted|untracked|unstaged|staged changes|working[- ]tree|working copy|git status|git diff|dirty tree|stash(?:ed)?)\b(?!\s+(?:panel|view|screen|page|tab|button|widget|component|dialog|window|menu|bar|indicator|badge|tool|command|script|endpoint|api|module|feature))/i;
/**
 * …and words that say the goal BUILDS something. An implementation verb wins
 * over everything else in the sentence: a goal that implements a feature and
 * also writes a report about it is implementation work and keeps its lease
 * (Codex 2026-09-11 G#9). Everything that merely DESCRIBES the tree — report,
 * summary, note, documentation, investigation — runs in the real tree, because
 * a lease seeded from HEAD reports a clean tree, which is a false answer
 * (measured 2026-09-10 22:31).
 */
const BUILD_SOMETHING_RE =
  /\b(?:add|implement|build|create|design|refactor|rename|port|migrate|fix|delete|remove|revert|commit|merge|rebase)\b/i;
/**
 * …and the goal saying it will CHANGE NOTHING. "Review the uncommitted fix
 * for crashes. Do not change files." is a review, and the word "fix" in the
 * thing being reviewed sent it into a lease where the tree reads clean
 * (Codex 2026-09-11 I#14).
 */
const CHANGES_NOTHING_RE =
  /\b(?:do not|don't|without) (?:change|changing|modify|modifying|edit|editing|touch|touching|writ(?:e|ing))\b|\bread[- ]only\b|\bno (?:changes|edits)\b/i;
/**
 * A verb that only DESCRIBES. When the goal's own verb is one of these, an
 * implementation word later in the sentence belongs to the thing being
 * described, not to the work.
 */
const DESCRIBES_RE = /^\s*(?:review|investigate|analy[sz]e|examine|inspect|audit|summari[sz]e|describe|explain|list|report on|look (?:at|into)|check)\b/i;

export function workspacePolicyFor(observations: ReadonlyArray<{ source: string }>, goal: string): { workspacePolicy?: "none" } {
  const sawGit = observations.some((o) => o.source === "git");
  if (!sawGit || !WORKING_TREE_GOAL_RE.test(goal)) return {};
  // A goal that says it changes nothing, or that OPENS with a describing
  // verb, is about the tree as it is — whatever implementation words appear
  // later in the sentence (Codex 2026-09-11 I#14).
  if (CHANGES_NOTHING_RE.test(goal) || DESCRIBES_RE.test(goal)) return { workspacePolicy: "none" };
  return BUILD_SOMETHING_RE.test(goal) ? {} : { workspacePolicy: "none" };
}
