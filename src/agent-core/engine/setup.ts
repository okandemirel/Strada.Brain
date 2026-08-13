/**
 * Agent Core v2 — engine run setup (relocation Step 7; blueprint: project_v2_engine_relocation).
 *
 * The run-bootstrap cluster: COMPOSE the per-run setup helpers into the {@link PortRunSetup} the
 * spine threads + the {@link EngineRunContext} the port closes over (setupAgentCoreRun), plus its
 * cohesive sub-helpers (loadRunPersonalization, resolvePersonaContent, computeVaultContext) and the
 * per-iteration context-window trim (trimContextWindowForRun). Moved VERBATIM from orchestrator.ts;
 * mutual calls stay INTERNAL (localFn), so SetupDeps carries only leaf services/config + the few
 * genuinely-external shell callbacks (buildFreshRunSession, buildFixedSupervisorExecutionStrategy,
 * maybeUpdateUserProfileFromPrompt, getTaskExecutionContext, propagateInstinctIdsToChannel) and the
 * ContextBuilderDeps getter (buildSystemPromptWithContext is called on it directly, mirroring the
 * shell's getSupervisorRoutingContext seam).
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.ts.
 */

import type { Session } from "../../agents/orchestrator-session-manager.js";
import type { UserProfile } from "../../memory/unified/user-profile-store.js";
import { resolveAutonomousModeWithDefault } from "../../memory/unified/user-profile-store.js";
import type { ProgressLanguage } from "../../tasks/progress-signals.js";
import type { TaskUsageEvent } from "../../tasks/types.js";
import type { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { IterationHealthCoreAdapter } from "../control/iteration-health-core-adapter.js";
import type { AgentRunSetupInput, RunSetup as PortRunSetup } from "../runner/orchestrator-port.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { EngineRunContext } from "./engine-deps.js";
import type { ReflectionDeps } from "./reflection.js";
import {
  getInteractiveIterationLimit,
  getBackgroundEpochIterationLimit,
  type BudgetDeps,
} from "./budget.js";
import {
  buildSystemPromptWithContext as buildSystemPromptWithContextHelper,
  type ContextBuilderDeps,
} from "../../agents/orchestrator-context-builder.js";
import { buildVaultProjectContext } from "../../agents/context/strada-knowledge.js";
import { resolveIdentityKey, resolveConversationScope } from "../../agents/orchestrator-text-utils.js";
import { canonicalizeProviderName } from "../../agents/providers/provider-identity.js";
import { createAutonomyBundle } from "../../agents/orchestrator-autonomy-tracker.js";
import { getRecommendedMaxMessages, type ModelIntelligenceLookup } from "../../agents/providers/provider-knowledge.js";
import { getLogger } from "../../utils/logger.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type { IEmbeddingProvider } from "../../rag/rag.interface.js";
import type { InstinctRetriever } from "../../agents/instinct-retriever.js";
import type { SoulLoader } from "../../agents/soul/index.js";
import type { MonitorLifecycle } from "../../dashboard/monitor-lifecycle.js";
import type { VaultRegistry } from "../../vault/vault-registry.js";
import type { SupervisorExecutionStrategy } from "../../agents/orchestrator-supervisor-routing.js";

/**
 * The dependency slice the run-setup cluster reads. Extends {@link ReflectionDeps} + {@link BudgetDeps}
 * so the overlapping services (sessionManager, userProfileStore, providerManager, dmPolicy, taskManager,
 * metricsRecorder, defaultLanguage, progressAssessmentEnabled, iteration-limits) are inherited IDENTICALLY
 * — no "declared differently" conflict when composed into EngineDeps. Adds only the setup-specific leaves.
 *
 * SETTER-BACKED deps are LAZY GETTERS (monitorLifecycle/stradaDeps are mutated after the engine is
 * constructed — setMonitorLifecycle / runtime checkStradaDeps — so a by-value capture would freeze the
 * ctor-time value; taskManager is already lazy via ReflectionDeps).
 */
export interface SetupDeps extends ReflectionDeps, BudgetDeps {
  readonly soulLoader: SoulLoader | null;
  readonly vaultRegistry?: VaultRegistry;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly instinctRetriever: InstinctRetriever | null;
  readonly modelIntelligence?: ModelIntelligenceLookup;
  readonly autonomousDefaultEnabled: boolean;
  readonly autonomousDefaultHours: number;
  readonly conformanceEnabled?: boolean;
  readonly conformanceFrameworkPathsOnly?: boolean;
  readonly loopFingerprintThreshold?: number;
  readonly loopFingerprintWindow?: number;
  readonly loopDensityThreshold?: number;
  readonly loopDensityWindow?: number;
  readonly loopMaxRecoveryEpisodes?: number;
  readonly loopStaleAnalysisThreshold?: number;
  readonly loopHardCapReplan?: number;
  readonly loopHardCapBlock?: number;
  readonly currentSessionInstinctIds: Map<string, string[]>;
  /** LAZY: setter-backed (setMonitorLifecycle after ctor). */
  monitorLifecycle(): MonitorLifecycle | null;
  /** LAZY: re-assigned at runtime (checkStradaDeps). */
  stradaDeps(): StradaDepsStatus | undefined;
  /** Absolute project root, for checks that need to read the project on disk. */
  projectPath?(): string | undefined;
  /** The ContextBuilderDeps seam (mirrors getSupervisorRoutingContext) — buildSystemPromptWithContext runs on it. */
  getContextBuilderContext(): ContextBuilderDeps;
  buildFreshRunSession(request: AgentRunSetupInput, queryText: string, supportsVision: boolean): Session;
  buildFixedSupervisorExecutionStrategy(
    prompt: string,
    identityKey: string,
    providerName: string,
    modelId: string | undefined,
    provider: IAIProvider,
  ): SupervisorExecutionStrategy;
  maybeUpdateUserProfileFromPrompt(
    chatId: string,
    identityKey: string,
    queryText: string,
    userId: string | undefined,
  ): Promise<void>;
  getTaskExecutionContext(): { readonly identityKey?: string; readonly taskRunId?: string } | undefined;
  propagateInstinctIdsToChannel(chatId: string, instinctIds: string[]): void;
}

export async function computeVaultContext(deps: SetupDeps, userMessage: string): Promise<string> {
    if (!deps.vaultRegistry) return "";
    try {
      return await buildVaultProjectContext({
        vaultRegistry: deps.vaultRegistry,
        userMessage,
        contextBudget: 4000,
      });
    } catch (err) {
      getLogger().warn("Vault context enrichment failed", { err });
      return "";
    }
  }

export async function resolvePersonaContent(deps: SetupDeps, profile: UserProfile | null): Promise<string | undefined> {
    if (profile?.activePersona && profile.activePersona !== "default" && deps.soulLoader) {
      return (await deps.soulLoader.getProfileContent(profile.activePersona)) ?? undefined;
    }
    return undefined;
  }

  /**
   * Step 0 / gap #6 — v1's worker-prologue personalization (runBackgroundTask :3291-3350): load the
   * user profile (drives persona + autonomous mode), debounced touch, prompt-derived profile update,
   * autonomous-mode restore (a dmPolicy side-effect), a once-computed embedding (reused by the prompt
   * build), and the per-user persona override. Returns the pieces the prompt build consumes.
   */
export async function loadRunPersonalization(
    deps: SetupDeps,
    chatId: string,
    identityKey: string,
    queryText: string,
    userId: string | undefined,
  ): Promise<{
    profile: UserProfile | null;
    personaContent: string | undefined;
    preComputedEmbedding: number[] | undefined;
  }> {
    let profile = deps.userProfileStore?.getProfile(identityKey) ?? null;
    if (deps.userProfileStore && profile) {
      const lastTouch = deps.sessionManager.persistTimeMap.get(`touch:${identityKey}`) ?? 0;
      if (Date.now() - lastTouch > 60_000) {
        deps.userProfileStore.touchLastSeen(identityKey);
        deps.sessionManager.persistTimeMap.set(`touch:${identityKey}`, Date.now());
      }
    }
    await deps.maybeUpdateUserProfileFromPrompt(chatId, identityKey, queryText, userId);
    profile = deps.userProfileStore?.getProfile(identityKey) ?? profile;

    if (deps.dmPolicy && deps.userProfileStore) {
      try {
        const autonomousState = await resolveAutonomousModeWithDefault(deps.userProfileStore, identityKey, {
          enabled: deps.autonomousDefaultEnabled,
          hours: deps.autonomousDefaultHours,
        });
        deps.dmPolicy.initFromProfile(
          chatId,
          autonomousState.enabled
            ? { autonomousMode: true, autonomousExpiresAt: autonomousState.expiresAt }
            : { autonomousMode: false },
          userId,
        );
      } catch {
        // Autonomous-mode restoration failure is non-fatal.
      }
    }

    let preComputedEmbedding: number[] | undefined;
    if (deps.embeddingProvider && queryText) {
      try {
        const batch = await deps.embeddingProvider.embed([queryText]);
        preComputedEmbedding = batch.embeddings[0];
      } catch {
        // Embedding failure is non-fatal; downstream embeds on demand.
      }
    }

    const personaContent = await resolvePersonaContent(deps, profile);

    return { profile, personaContent, preComputedEmbedding };
  }

  /**
   * COMPOSE the existing per-run setup helpers (the same callees the inline loop preamble calls)
   * into the {@link PortRunSetup} the spine threads + the {@link EngineRunContext} the
   * port closes over. Mirrors runAgentLoop's prologue (orchestrator.ts ~4790-4894).
   */
export async function setupAgentCoreRun(
    deps: SetupDeps,
    request: AgentRunSetupInput,
    // Shared with the FailureLedger's core (createAgentCorePort) so the ledger's verdict rules read the
    // SAME tracker the spine records into — the v2-background-livelock fix. One run = one tracker.
    iterationHealth: IterationHealthTracker,
    healthAdapter: IterationHealthCoreAdapter,
  ): Promise<{ setup: PortRunSetup; runCtx: EngineRunContext }> {
    const chatId = request.chatId;
    const isInteractive = request.mode === "interactive"; // gap #3/#7/#8 share this branch
    // Step 0 / gap #5 — resolve the run identity the way v1's prologue does (resolveIdentityKey at
    // :3057/:2201): userId/conversationId key multi-user + cross-channel sessions, profiles, and
    // provider selection. The prior `identityKey = chatId` mis-keyed every non-default-channel run.
    // gap #1: the run scope (withRunTaskContext) already resolved + established this identity, so
    // reuse it to avoid a duplicate resolve; fall back for any path that calls setupRun outside a
    // scope (e.g. direct unit tests).
    const identityKey =
      deps.getTaskExecutionContext()?.identityKey ??
      resolveIdentityKey(
        chatId,
        request.userId,
        request.conversationId,
        deps.userProfileStore,
        request.channelType,
      );
    const queryText = request.prompt;
    // step5-parity (v1 @ a3de7d1 runWorkerTask :3567-3583): a supervisor-assigned provider pin
    // (request.assignedProvider/assignedModel) materializes the pinned provider as THE run
    // provider and a fixed all-roles strategy; an unmaterializable pin warns and falls back.
    const fixedProviderName =
      canonicalizeProviderName(request.assignedProvider)
      ?? request.assignedProvider?.trim().toLowerCase();
    const fixedModelId = request.assignedModel?.trim() || undefined;
    // Strict BARE materialization (getPrimaryProviderByName): (a) the existence probe is real —
    // getProviderByName builds a resilient chain for almost any name, so the "unmaterializable
    // pin" warn below could never fire and a bogus pin silently ran the default chain under the
    // pinned name (trio security catch); (b) a pin must be the bare provider, consistent with
    // buildTaskAwareProvider's hard-pin branch (never a chain that could fall over to a sibling).
    const fixedProvider = fixedProviderName
      ? (deps.providerManager as {
          getPrimaryProviderByName?: (name: string, model?: string) => IAIProvider | null;
        }).getPrimaryProviderByName?.(fixedProviderName, fixedModelId) ?? null
      : null;
    if (request.assignedProvider && fixedProviderName && !fixedProvider) {
      getLogger().warn("Delegated worker provider pin could not be materialized; using fallback provider", {
        assignedProvider: request.assignedProvider,
        canonicalProvider: fixedProviderName,
        assignedModel: fixedModelId,
        chatId,
      });
    }
    const fallbackProvider = fixedProvider ?? deps.providerManager.getProvider(identityKey);
    const fixedExecutionStrategy =
      fixedProviderName && fixedProvider
        ? deps.buildFixedSupervisorExecutionStrategy(queryText, identityKey, fixedProviderName, fixedModelId, fixedProvider)
        : undefined;
    // Step 0 / gap #3 — worker/background/delegated runs get a FRESH session built from userContent
    // (v1 parity: runBackgroundTask :3278-3289), so parallel runs on one chatId never collide on a
    // shared persistent session and attachments/vision are seeded. Interactive keeps the persistent
    // session (the chat continues across messages).
    const session: Session =
      isInteractive
        ? deps.sessionManager.getOrCreateSession(chatId)
        : deps.buildFreshRunSession(request, queryText, fallbackProvider.capabilities.vision);
    // v1 parity (runBackgroundTask :3213): derive the conversation scope from the request, not the
    // (possibly-shared/fresh) session — a fresh worker session carries no scope field.
    const conversationScope = resolveConversationScope(chatId, request.conversationId);

    // v1 parity (runBackgroundTask :3549-3550, deletion-map risk catch): a worker/sub-goal run
    // carrying a parent monitorScope joins the PARENT whole-goal episode — its Kanban card nests
    // under the parent workspace instead of spraying a sibling root. The v2 path dropped
    // request.monitorScope entirely; without this the supervisor-bridge workers are monitor-silent
    // on the now-default v2 route. The joinEpisode CALL fires at the END of setup (after the last
    // throwing await) so a setup failure never leaves a dangling joined card (trio catch);
    // joinEpisodeEnd fires from persistTerminal's finally (v1: finally :4894).
    const workerMonitorScope = request.monitorScope?.trim() || undefined;
    const joinsParentEpisode = Boolean(workerMonitorScope) && workerMonitorScope !== conversationScope;

    // Step 0 / gap #6 — load v1's worker-prologue personalization (profile, persona, autonomous-mode
    // restore, pre-computed embedding) before the prompt build (runBackgroundTask :3291-3350).
    const { profile, personaContent, preComputedEmbedding } = await loadRunPersonalization(deps, 
      chatId,
      identityKey,
      queryText,
      request.userId,
    );

    const vaultContext = await computeVaultContext(deps, queryText);
    const {
      systemPrompt: builtSystemPrompt,
      initialContentHashes,
      projectWorldSummary,
      projectWorldFingerprint,
    } = await buildSystemPromptWithContextHelper(deps.getContextBuilderContext(), {
      chatId,
      conversationScope,
      identityKey,
      channelType: request.channelType,
      // step5-parity: v1's INTERACTIVE prologue threaded userId so dmPolicy.isAutonomousActive
      // resolves userId-keyed prefs and the AUTONOMOUS MODE directive renders in the prompt
      // (the skip-confirmation BEHAVIOR worked either way; only the prompt layer was blind).
      // Interactive-ONLY, exactly as v1: the background/worker prologue never passed it
      // (a3de7d1 :3693-3703), so worker prompts must not inherit the directive (trio catch).
      userId: isInteractive ? request.userId : undefined,
      prompt: queryText,
      personaContent,
      vaultContext,
      profile,
      preComputedEmbedding,
    });
    // gap #6 — instinct injection (v1 runBackgroundTask :3377-3388): augment the system prompt with
    // retrieved learned insights AND capture them so the spine can seed state.learnedInsights — that
    // field IS read on the v2 path (prepareIteration → buildPhasePromptSection renders the PLANNING
    // prompt's "### Learned Patterns" block from it), so BOTH carriers must be populated to match v1.
    let systemPrompt = builtSystemPrompt;
    let learnedInsights: readonly string[] = [];
    // GAP1 (self-learning attribution): capture the retrieved instincts' IDs and stash them per-session
    // so emitToolResult tags every v2 tool:result with appliedInstinctIds (v1 parity: runAgentLoop
    // :5189-5191). WITHOUT this the v2 path is open-loop — instincts are created but never reinforced
    // (learning-pipeline.ts:333 is gated on appliedInstinctIds.length>0). Cleared on teardown in
    // persistTerminal (symmetric to v1's runAgentLoop finally :6232-6234).
    let matchedInstinctIds: string[] = [];
    if (deps.instinctRetriever) {
      try {
        const insightResult = await deps.instinctRetriever.getInsightsForTask(queryText);
        matchedInstinctIds = insightResult.matchedInstinctIds;
        if (insightResult.insights.length > 0) {
          learnedInsights = insightResult.insights;
          systemPrompt += `\n\n## Learned Insights\n${insightResult.insights.join("\n")}\n`;
        }
      } catch {
        // Non-fatal.
      }
    }
    deps.currentSessionInstinctIds.set(chatId, matchedInstinctIds);
    deps.propagateInstinctIdsToChannel(chatId, matchedInstinctIds);

    const lastUserMessage = deps.sessionManager.extractLastUserMessage(session) || queryText;
    const bundle = createAutonomyBundle({
      prompt: lastUserMessage,
      // Step 0 / gap #8 — v1 workers use the background-epoch iteration budget (runBackgroundTask
      // :3407); only interactive uses the interactive limit. The prior v2 prologue used the
      // interactive limit for ALL modes, giving workers the wrong autonomy-bundle budget.
      iterationBudget:
        isInteractive
          ? getInteractiveIterationLimit(deps)
          : getBackgroundEpochIterationLimit(deps),
      stradaDeps: deps.stradaDeps(),
      projectPath: deps.projectPath?.(),
      projectWorldSummary,
      projectWorldFingerprint,
      includeControlLoopTracker: true,
      previousJournalSnapshot: session.lastJournalSnapshot,
      conformanceEnabled: deps.conformanceEnabled,
      conformanceFrameworkPathsOnly: deps.conformanceFrameworkPathsOnly,
      // v1 parity (trio catch): the documented loop-detection knobs configure the
      // ControlLoopTracker on the v2 route exactly as the deleted loops threaded them.
      loopFingerprintThreshold: deps.loopFingerprintThreshold,
      loopFingerprintWindow: deps.loopFingerprintWindow,
      loopDensityThreshold: deps.loopDensityThreshold,
      loopDensityWindow: deps.loopDensityWindow,
      loopMaxRecoveryEpisodes: deps.loopMaxRecoveryEpisodes,
      loopStaleAnalysisThreshold: deps.loopStaleAnalysisThreshold,
      loopHardCapReplan: deps.loopHardCapReplan,
      loopHardCapBlock: deps.loopHardCapBlock,
      progressAssessmentEnabled: deps.progressAssessmentEnabled,
    });

    const memoryRefresher = deps.sessionManager.createMemoryRefresher(initialContentHashes);
    // Step 0 / gap #7 — label the metric by the actual run mode (v1 parity: runBackgroundTask uses
    // "subtask" for delegated sub-agents else "background"; interactive stays "interactive") + thread
    // parentTaskId for sub-agent lineage. The prior hardcoded "interactive" mislabeled every
    // worker/background/delegated run and dropped the parent link.
    const metricId = deps.metricsRecorder?.startTask({
      sessionId: chatId,
      taskDescription: lastUserMessage.slice(0, 200),
      taskType:
        isInteractive
          ? "interactive"
          : request.parentMetricId
            ? "subtask"
            : "background",
      parentTaskId: request.parentMetricId,
      // GAP1: attribute the metric to the retrieved instincts (v1 parity: runAgentLoop :5198-5203).
      instinctIds: matchedInstinctIds,
    });

    // iterationHealth + healthAdapter are now passed in (shared with the FailureLedger's core) — the
    // v2-background-livelock fix. Previously created here as a SEPARATE instance the ledger never saw.
    const onUsage = request.onUsage as ((usage: TaskUsageEvent) => void) | undefined;
    const runCtx: EngineRunContext = {
      onUsage,
      iterationHealth,
      healthAdapter,
      session,
      chatId,
      metricId,
      toolExecMode:
        isInteractive
          ? "interactive"
          : request.mode === "supervisor-node"
            ? "delegated" // v1 parity: supervisor-node workers run as the "delegated" tool-exec mode
            : "background",
      workspaceLease: request.workspaceLease,
      workspaceLeaseRetained: request.workspaceLeaseRetained,
      goalContext: request.goalContext,
      executionJournal: bundle.executionJournal,
      selfVerification: bundle.selfVerification,
      stradaConformance: bundle.stradaConformance,
      errorRecovery: bundle.errorRecovery,
      taskPlanner: bundle.taskPlanner,
      controlLoopTracker: bundle.controlLoopTracker ?? undefined,
      systemPrompt,
      goalsDecomposed: false,
      identityKey,
      userId: request.userId,
      channelType: request.channelType,
      attachments: request.attachments,
      conversationScope,
      projectWorldFingerprint,
      executionStrategy: undefined,
      lastAssignment: undefined,
      lastToolNames: [],
      lastProviderCapabilities: undefined,
      cumulativeOutputTokens: 0,
      taskStartedAtMs: Date.now(),
      progressLanguage: deps.defaultLanguage as ProgressLanguage,
      progressTitle: queryText.replace(/\s+/g, " ").trim().slice(0, 80) || "Task",
      emitProgress: () => {
        /* worker/background progress is surfaced via the V2 event bus, not this v1 sink */
      },
      // v1 parity: worker/background runs get a live collector so the SHARED handlers
      // (end-turn verifier :452, reflection, tool-exec delegation :91) accumulate
      // verifierResult / childWorkerResults exactly as they did for runWorkerTask; the
      // result projection reads them back. Interactive stays collector-less (as v1).
      workerCollector: isInteractive ? undefined : { toolTrace: [], childWorkerResults: [] },
      profileLanguage: undefined,
      joinsParentEpisode,
      workerMonitorScope,
      memoryRefresher,
      fixedExecutionStrategy,
      plainLoopStepIndex: 0, // BUG#1 P2: per-run tool-batch counter for the plain-loop live step DAG.
    };

    const setup: PortRunSetup = {
      systemPrompt,
      session: session as unknown as PortRunSetup["session"],
      executionJournal: bundle.executionJournal,
      memoryRefresher,
      identityKey,
      fallbackProvider,
      iterationHealth,
      metricId: metricId ?? "",
      enableGoalDetection: deps.taskManager() != null,
      learnedInsights,
    };

    // The join is the LAST setup step (no throwing awaits remain) — see the derivation comment
    // above; a joined card is now guaranteed to be settled by persistTerminal's finally.
    if (joinsParentEpisode) {
      deps.monitorLifecycle()?.joinEpisode(conversationScope, queryText, workerMonitorScope);
    }

    return { setup, runCtx };
  }

  /**
   * Provider-aware context-window trim for the v2 run. Mirrors runAgentLoop's trim (orchestrator.ts
   * ~4669): trimSession to the recommended max messages, then persist the trimmed tail to memory.
   * Idempotent across iterations (trimSession is a no-op when already within bounds).
   */
export function trimContextWindowForRun(
    deps: SetupDeps,
    session: Session,
    _mode: "interactive" | "background",
    runCtx: EngineRunContext,
  ): void {
    const providerInfo = deps.providerManager.getActiveInfo?.(runCtx.identityKey);
    const providerName = providerInfo?.providerName ?? deps.providerManager.getProvider(runCtx.identityKey).name;
    const trimmed = deps.sessionManager.trimSession(
      session,
      getRecommendedMaxMessages(
        providerName,
        providerInfo?.model,
        deps.modelIntelligence,
        deps.providerManager.getProviderCapabilities?.(providerName, providerInfo?.model),
        providerName,
      ),
    );
    if (trimmed.length > 0) {
      void deps.sessionManager.persistSessionToMemory(
        runCtx.chatId,
        trimmed,
        /* force */ true,
      );
    }
  }
