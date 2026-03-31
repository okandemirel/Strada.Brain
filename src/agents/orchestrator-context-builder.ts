import type { IMemoryManager } from "../memory/memory.interface.js";
import type { IRAGPipeline, IEmbeddingProvider } from "../rag/rag.interface.js";
import type { TaskExecutionMemory, TaskExecutionStore } from "../memory/unified/task-execution-store.js";
import type { UserProfile } from "../memory/unified/user-profile-store.js";
import type { SoulLoader } from "./soul/index.js";
import type { DMPolicy } from "../security/dm-policy.js";
import type { GoalTree } from "../goals/types.js";
import type { TaskClassification } from "../agent-core/routing/routing-types.js";
import { AgentPhase } from "./agent-state.js";
import { isOk, isSome } from "../types/index.js";
import { getLogger } from "../utils/logger.js";
import {
  LANGUAGE_DISPLAY_NAMES,
  buildProfileParts,
  buildExactResponseDirective,
  sanitizePromptInjection,
} from "./orchestrator-text-utils.js";
import { buildExplicitTargetExecutionDirective } from "./prompt-targets.js";
import { buildProjectWorldMemorySection } from "./context/strada-knowledge.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTONOMOUS_MODE_DIRECTIVE = `\n\n## AUTONOMOUS MODE ACTIVE
You are operating in AUTONOMOUS MODE. The user has explicitly granted you full autonomy.
- Execute ALL operations directly without asking for confirmation
- Do NOT use ask_user tool for permission/confirmation questions
- Do NOT use show_plan tool to wait for approval unless the user explicitly asked to review a plan first
- If you use show_plan internally, make it concrete and execution-ready; strong plans are self-reviewed and auto-approved
- Only use ask_user when you genuinely cannot determine user intent (missing critical info)
- If you use ask_user anyway, prefer decision-ready options because the system may resolve the choice autonomously
- Proceed confidently with your best judgment on all write operations
- Keep package choices, refactor paths, implementation sequencing, and other local engineering decisions internal
- Do not narrate routine milestone updates or "next I will..." progress memos to the user; continue until you have the final result, a sparse heartbeat, or a real hard blocker
- Do not end executable technical work by handing the next engineering step back to the user; either continue autonomously or report one real blocker
- Do NOT return internal tool-run checklists or "first run X / then run Y" operational memos in plain text; use the tools directly when you can
- Budget and safety limits are still enforced automatically\n`;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Readonly context interface carrying the Orchestrator fields
 * needed by context-builder standalone functions.
 */
export interface ContextBuilderDeps {
  readonly memoryManager?: IMemoryManager;
  readonly ragPipeline?: IRAGPipeline;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly taskExecutionStore?: TaskExecutionStore;
  readonly soulLoader: SoulLoader | null;
  readonly dmPolicy: DMPolicy;
  readonly activeGoalTrees: ReadonlyMap<string, GoalTree>;
  readonly projectPath: string;
  readonly defaultLanguage: string;
  readonly systemPrompt: string;
  readonly taskClassifier: { classify(prompt: string): TaskClassification };
  readonly toolMetadataByName: ReadonlyMap<string, { readonly readOnly?: boolean; readonly controlPlaneOnly?: boolean; readonly requiresBridge?: boolean; readonly available?: boolean }>;
  readonly toolDefinitions: ReadonlyArray<{ name: string }>;
  readonly runtimeArtifactManager?: {
    matchForTask(params: {
      taskDescription: string;
      taskType: string;
      projectWorldFingerprint?: string;
      availableToolNames: readonly string[];
      maxMatches: number;
    }): {
      active: Array<{
        usableForExecutionGuidance: boolean;
        artifact: { id: string; kind: string; guidance: string };
        matchScore: number;
        projectWorldMatched: boolean;
      }>;
      shadow: Array<{ artifact: { id: string } }>;
    };
  };
  readonly trajectoryReplayRetriever: {
    getInsightsForTask(params: {
      taskDescription: string;
      projectWorldFingerprint?: string;
      maxInsights: number;
    }): { insights: string[] };
  } | null;
  readonly getTaskExecutionContext?: () =>
    | { chatId: string; taskRunId?: string }
    | undefined;
  readonly runtimeArtifactMatches?: Map<
    string,
    { activeGuidanceIds: string[]; shadowIds: string[] }
  >;
  readonly buildWorkerToolDefinitions?: (
    task: TaskClassification,
    phase: AgentPhase,
    role: string,
  ) => Array<{ name: string }>;
}

// ─── Functions ────────────────────────────────────────────────────────────────

/** Append soul personality section to a system prompt if available. */
export function injectSoulPersonality(
  ctx: ContextBuilderDeps,
  systemPrompt: string,
  channelType?: string,
  personaOverride?: string,
): string {
  if (personaOverride) {
    return systemPrompt + `\n\n## Agent Personality\n\n${sanitizePromptInjection(personaOverride)}\n`;
  }
  if (!ctx.soulLoader) return systemPrompt;
  const soulContent = ctx.soulLoader.getContent(channelType);
  if (!soulContent) return systemPrompt;
  return systemPrompt + `\n\n## Agent Personality\n\n${sanitizePromptInjection(soulContent)}\n`;
}

function buildTaskExecutionMemoryLayer(
  taskExecutionMemory: TaskExecutionMemory | null,
  legacyContextSummary?: string,
): { content: string; contentHashes: string[] } | null {
  if (
    !taskExecutionMemory?.sessionSummary &&
    !taskExecutionMemory?.branchSummary &&
    !taskExecutionMemory?.verifierSummary &&
    !taskExecutionMemory?.learnedInsights.length &&
    !legacyContextSummary
  ) {
    return null;
  }

  const lines: string[] = [];
  const contentHashes: string[] = [];

  if (taskExecutionMemory?.sessionSummary) {
    lines.push(`Recent session: ${sanitizePromptInjection(taskExecutionMemory.sessionSummary)}`);
    contentHashes.push(taskExecutionMemory.sessionSummary);
  } else if (legacyContextSummary) {
    lines.push(`Recent session: ${sanitizePromptInjection(legacyContextSummary)}`);
    contentHashes.push(legacyContextSummary);
  }

  if (taskExecutionMemory && taskExecutionMemory.openItems.length > 0) {
    lines.push(`Open items: ${taskExecutionMemory.openItems.join("; ")}`);
  }
  if (taskExecutionMemory?.branchSummary) {
    lines.push(`Branch recovery: ${sanitizePromptInjection(taskExecutionMemory.branchSummary)}`);
    contentHashes.push(taskExecutionMemory.branchSummary);
  }
  if (taskExecutionMemory?.verifierSummary) {
    lines.push(
      `Verifier memory: ${sanitizePromptInjection(taskExecutionMemory.verifierSummary)}`,
    );
    contentHashes.push(taskExecutionMemory.verifierSummary);
  }
  if (taskExecutionMemory && taskExecutionMemory.learnedInsights.length > 0) {
    lines.push("Execution insights:");
    for (const insight of taskExecutionMemory.learnedInsights.slice(0, 4)) {
      lines.push(`- ${sanitizePromptInjection(insight)}`);
      contentHashes.push(insight);
    }
  }

  return {
    content: `## Task Execution Memory\nReference this context when continuing prior work or avoiding failed paths.\n${lines.join("\n")}`,
    contentHashes,
  };
}

function buildTrajectoryReplayMemoryLayer(
  ctx: ContextBuilderDeps,
  userMessage: string,
  projectWorldFingerprint?: string,
): { content: string; contentHashes: string[] } | null {
  if (!ctx.trajectoryReplayRetriever || !userMessage.trim()) {
    return null;
  }

  try {
    const replay = ctx.trajectoryReplayRetriever.getInsightsForTask({
      taskDescription: userMessage,
      projectWorldFingerprint,
      maxInsights: 2,
    });

    if (replay.insights.length === 0) {
      return null;
    }

    return {
      content: `## Execution Replay\nReference these prior similar trajectories before repeating a failed branch.\n${replay.insights.map((insight) => `- ${sanitizePromptInjection(insight)}`).join("\n")}`,
      contentHashes: [...replay.insights],
    };
  } catch {
    return null;
  }
}

function buildRuntimeArtifactMemoryLayer(
  ctx: ContextBuilderDeps,
  userMessage: string,
  classifiedTask: TaskClassification,
  projectWorldFingerprint: string | undefined,
  runtimeArtifactToolNames: readonly string[],
  chatId?: string,
  taskRunId?: string,
): { content: string; contentHashes: string[] } | null {
  if (!ctx.runtimeArtifactManager || !userMessage.trim()) {
    return null;
  }

  try {
    const matches = ctx.runtimeArtifactManager.matchForTask({
      taskDescription: userMessage,
      taskType: classifiedTask.type,
      projectWorldFingerprint,
      availableToolNames: runtimeArtifactToolNames,
      maxMatches: 6,
    });
    const activeGuidance = matches.active
      .filter((match) => match.usableForExecutionGuidance)
      .slice(0, 3);

    const getRuntimeArtifactMatchKey = (tid?: string, cid?: string): string | null => {
      const resolvedTaskRunId = tid?.trim();
      if (resolvedTaskRunId) return resolvedTaskRunId;
      const resolvedChatId = cid?.trim();
      return resolvedChatId && resolvedChatId.length > 0 ? `chat:${resolvedChatId}` : null;
    };

    const key = getRuntimeArtifactMatchKey(taskRunId, chatId);
    if (key && ctx.runtimeArtifactMatches) {
      const matchedIds = {
        activeGuidanceIds: activeGuidance.map((match) => match.artifact.id),
        shadowIds: matches.shadow.map((match) => match.artifact.id),
      };
      if (matchedIds.activeGuidanceIds.length > 0 || matchedIds.shadowIds.length > 0) {
        ctx.runtimeArtifactMatches.set(key, matchedIds);
      } else {
        ctx.runtimeArtifactMatches.delete(key);
      }
    }

    if (activeGuidance.length === 0) {
      return null;
    }

    const lines: string[] = [
      "## Runtime Self-Improvement",
      "These active runtime artifacts were learned from prior verified work. Treat them as internal guidance, not user-visible output.",
    ];
    const contentHashes: string[] = [];
    for (const match of activeGuidance) {
      const scope = match.projectWorldMatched ? "same-world" : "general";
      lines.push(
        `- [${match.artifact.kind}] ${sanitizePromptInjection(match.artifact.guidance)} (score ${match.matchScore.toFixed(2)}, ${scope})`,
      );
      contentHashes.push(match.artifact.guidance);
    }

    return {
      content: lines.join("\n"),
      contentHashes,
    };
  } catch {
    return null;
  }
}

async function buildProjectWorldMemoryLayer(
  ctx: ContextBuilderDeps,
): Promise<{
  content: string;
  contentHashes: string[];
  summary: string;
  fingerprint: string;
} | null> {
  if (!ctx.memoryManager) {
    return buildProjectWorldMemorySection({
      projectPath: ctx.projectPath,
      analysis: null,
    });
  }

  try {
    const analysisResult = await ctx.memoryManager.getCachedAnalysis(ctx.projectPath);
    const analysis =
      isOk(analysisResult) && isSome(analysisResult.value) ? analysisResult.value.value : null;
    return buildProjectWorldMemorySection({
      projectPath: ctx.projectPath,
      analysis,
    });
  } catch {
    return buildProjectWorldMemorySection({
      projectPath: ctx.projectPath,
      analysis: null,
    });
  }
}

/**
 * Build context injection for system prompt enrichment.
 * Layers: User Profile, Task Execution Memory, Project/World Memory, Open Tasks/Goals, Semantic Memory.
 */
export async function buildContextLayers(
  ctx: ContextBuilderDeps,
  goalScope: string,
  executionScope: string,
  userMessage: string,
  profile: UserProfile | null,
  preComputedEmbedding?: number[],
): Promise<{
  context: string;
  contentHashes: string[];
  projectWorldSummary?: string;
  projectWorldFingerprint?: string;
}> {
  const layers: string[] = [];
  const contentHashes: string[] = [];
  let projectWorldSummary: string | undefined;
  let projectWorldFingerprint: string | undefined;
  const classifiedTask = ctx.taskClassifier.classify(userMessage);
  const taskContext = ctx.getTaskExecutionContext?.();

  const runtimeArtifactToolNames = ctx.buildWorkerToolDefinitions
    ? ctx.buildWorkerToolDefinitions(classifiedTask, AgentPhase.EXECUTING, "executor").map((d) => d.name)
    : ctx.toolDefinitions
        .filter((d) => {
          const m = ctx.toolMetadataByName.get(d.name);
          return !m?.controlPlaneOnly && !(m?.requiresBridge && m.available === false);
        })
        .map((d) => d.name);

  // Layer 1: User Profile
  if (profile) {
    const parts = buildProfileParts(profile);
    if (parts.length > 0)
      layers.push(
        `## User Context\nUse this information naturally in your responses. Address the user by name and respect their preferences.\n${parts.join("\n")}`,
      );
  }

  // Layer 2: Task Execution Memory
  const taskExecutionMemory = ctx.taskExecutionStore?.getMemory(executionScope) ?? null;
  const taskExecutionLayer = buildTaskExecutionMemoryLayer(
    taskExecutionMemory,
    profile?.contextSummary,
  );
  if (taskExecutionLayer) {
    layers.push(taskExecutionLayer.content);
    contentHashes.push(...taskExecutionLayer.contentHashes);
  }

  // Layer 3: Project / World Memory
  const projectWorldLayer = await buildProjectWorldMemoryLayer(ctx);
  if (projectWorldLayer) {
    layers.push(projectWorldLayer.content);
    contentHashes.push(...projectWorldLayer.contentHashes);
    projectWorldSummary = projectWorldLayer.summary;
    projectWorldFingerprint = projectWorldLayer.fingerprint;
  }

  // Layer 4: Runtime self-improvement artifacts
  const runtimeArtifactLayer = buildRuntimeArtifactMemoryLayer(
    ctx,
    userMessage,
    classifiedTask,
    projectWorldFingerprint,
    runtimeArtifactToolNames,
    taskContext?.chatId,
    taskContext?.taskRunId,
  );
  if (runtimeArtifactLayer) {
    layers.push(runtimeArtifactLayer.content);
    contentHashes.push(...runtimeArtifactLayer.contentHashes);
  }

  // Layer 5: Cross-session execution replay
  const trajectoryReplayLayer = buildTrajectoryReplayMemoryLayer(
    ctx,
    userMessage,
    projectWorldFingerprint,
  );
  if (trajectoryReplayLayer) {
    layers.push(trajectoryReplayLayer.content);
    contentHashes.push(...trajectoryReplayLayer.contentHashes);
  }

  // Layer 6: Open Tasks/Goals
  const activeGoalTree = ctx.activeGoalTrees?.get(goalScope);
  if (activeGoalTree) {
    const pendingGoals: Array<{ task: string; status: string }> = [];
    for (const node of activeGoalTree.nodes.values()) {
      if (node.status === "pending" || node.status === "executing") {
        pendingGoals.push({ task: node.task, status: node.status });
      }
    }
    if (pendingGoals.length > 0) {
      const taskLines = pendingGoals
        .slice(0, 5)
        .map((g) => `- ${g.task} — ${g.status}`)
        .join("\n");
      layers.push(`## Open Tasks\n${taskLines}`);
    }
  }

  // Layer 7: Semantic Memory (real embedding search)
  if (ctx.memoryManager && userMessage) {
    try {
      const memoriesResult = await ctx.memoryManager.retrieve({
        mode: "semantic",
        query: userMessage,
        limit: 5,
        minScore: 0.15,
        embedding: preComputedEmbedding,
      } as import("../memory/memory.interface.js").SemanticRetrievalOptions);
      if (isOk(memoriesResult)) {
        const memories = memoriesResult.value;
        if (memories.length > 0) {
          const memoryContext = memories.map((m) => m.entry.content).join("\n---\n");
          layers.push(`## Relevant Memory\n${memoryContext}`);
          for (const m of memories) {
            contentHashes.push(m.entry.content);
          }
        }
      }
    } catch {
      // Memory retrieval failure is non-fatal
    }
  }

  const context =
    layers.length > 0
      ? `\n\n<!-- context-layers:start -->\n${layers.join("\n\n")}\n<!-- context-layers:end -->\n`
      : "";

  return { context, contentHashes, projectWorldSummary, projectWorldFingerprint };
}

/**
 * Build a complete system prompt with all context layers.
 * Shared by both runAgentLoop (interactive) and runBackgroundTask (background).
 */
export async function buildSystemPromptWithContext(
  ctx: ContextBuilderDeps,
  params: {
    chatId: string;
    conversationScope: string;
    identityKey: string;
    userId?: string;
    channelType?: string;
    prompt: string;
    personaContent?: string;
    profile: {
      displayName?: string;
      language: string;
      activePersona: string;
      preferences: unknown;
      contextSummary?: string;
    } | null;
    preComputedEmbedding?: number[];
  },
): Promise<{
  systemPrompt: string;
  initialContentHashes: string[];
  projectWorldSummary?: string;
  projectWorldFingerprint?: string;
}> {
  const logger = getLogger();

  // 1. Language directive — FIRST, highest priority, before personality
  // Always inject: profile language > LANGUAGE_PREFERENCE env > "en"
  const effectiveLang = params.profile?.language ?? ctx.defaultLanguage;
  const langName = LANGUAGE_DISPLAY_NAMES[effectiveLang] ?? "English";
  const langDirective = `\n## LANGUAGE RULE\nYour current language is ${langName}. Respond in ${langName} unless the user clearly switches to a different language — in that case, follow their lead.\n`;

  // 2. Soul personality injection (with optional persona override)
  let systemPrompt =
    langDirective +
    injectSoulPersonality(ctx, ctx.systemPrompt, params.channelType, params.personaContent);

  // 2.5. Exact literal-output requests need a hard response contract.
  systemPrompt += buildExactResponseDirective(params.prompt);

  const explicitTargetDirective = buildExplicitTargetExecutionDirective(params.prompt);
  if (explicitTargetDirective) {
    systemPrompt += `\n\n${explicitTargetDirective}\n`;
  }

  // 3. Autonomous mode directive
  if (ctx.dmPolicy?.isAutonomousActive(params.chatId, params.userId)) {
    systemPrompt += AUTONOMOUS_MODE_DIRECTIVE;
  }

  // 4. Context layers (user profile, session summary, open tasks, semantic memory)
  const {
    context: contextLayers,
    contentHashes,
    projectWorldSummary,
    projectWorldFingerprint,
  } = await buildContextLayers(
    ctx,
    params.conversationScope,
    params.identityKey,
    params.prompt,
    params.profile as UserProfile | null,
    params.preComputedEmbedding,
  );
  systemPrompt += contextLayers;
  const initialContentHashes: string[] = [...contentHashes];

  // 5. RAG injection
  if (ctx.ragPipeline && params.prompt) {
    try {
      const ragResults = await ctx.ragPipeline.search(params.prompt, {
        topK: 6,
        minScore: 0.2,
        queryEmbedding: params.preComputedEmbedding,
      });
      if (ragResults.length > 0) {
        const ragFormatted = ctx.ragPipeline.formatContext(ragResults);
        systemPrompt += `\n\n<!-- re-retrieval:rag:start -->\n${ragFormatted}\n<!-- re-retrieval:rag:end -->\n`;
        for (const r of ragResults) initialContentHashes.push(r.chunk.content);
        logger.debug("Injected RAG context", {
          chatId: params.chatId,
          resultCount: ragResults.length,
          topScore: ragResults[0]!.finalScore.toFixed(3),
        });
      }
    } catch {
      // RAG failure is non-fatal
    }
  }

  return { systemPrompt, initialContentHashes, projectWorldSummary, projectWorldFingerprint };
}
