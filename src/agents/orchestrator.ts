import type {
  IAIProvider,
  ConversationMessage,
  ToolCall,
  ToolResult,
  ProviderResponse,
  IStreamingProvider,
} from "./providers/provider.interface.js";
import type { ProviderManager } from "./providers/provider-manager.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tools/tool.interface.js";
import type { IChannelAdapter, IncomingMessage, Attachment } from "../channels/channel.interface.js";
import { supportsRichMessaging } from "../channels/channel.interface.js";
import { isVisionCompatible, toBase64ImageSource } from "../utils/media-processor.js";
import type { MessageContent, AssistantMessage } from "./providers/provider-core.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import { isOk, isSome } from "../types/index.js";
import type { ChatId } from "../types/index.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import {
  STRADA_SYSTEM_PROMPT,
  buildProjectContext,
  buildAnalysisSummary,
  buildDepsContext,
  buildCapabilityManifest,
  buildIdentitySection,
  buildCrashNotificationSection,
} from "./context/strada-knowledge.js";
import type { IdentityState } from "../identity/identity-state.js";
import type { CrashRecoveryContext } from "../identity/crash-recovery.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { checkStradaDeps, installStradaDep } from "../config/strada-deps.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { getLogger, getLogRingBuffer } from "../utils/logger.js";
import { AgentPhase, createInitialState, transitionPhase, type AgentState, type StepResult } from "./agent-state.js";
import { buildPlanningPrompt, buildReflectionPrompt, buildReplanningPrompt, buildExecutionContext } from "./paor-prompts.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import { MemoryRefresher } from "./memory-refresher.js";
import {
  DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS,
  DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS,
  type ReRetrievalConfig,
  type StradaDependencyConfig,
} from "../config/config.js";
import type { IEmbeddingProvider } from "../rag/rag.interface.js";
import { shouldForceReplan } from "./failure-classifier.js";
import {
  buildProviderIntelligence,
  getRecommendedMaxMessages,
  type ModelIntelligenceLookup,
} from "./providers/provider-knowledge.js";
import {
  buildAutonomyDeflectionGate,
  buildClarificationContinuationGate,
  buildClarificationReviewRequest,
  CLARIFICATION_REVIEW_SYSTEM_PROMPT,
  COMPLETION_REVIEW_SYSTEM_PROMPT,
  ErrorRecoveryEngine,
  TaskPlanner,
  SelfVerification,
  collectClarificationReviewEvidence,
  buildVerifierPipelineReviewRequest,
  formatClarificationPrompt,
  finalizeVerifierPipelineReview,
  isTerminalFailureReport,
  parseCompletionReviewDecision,
  parseClarificationReviewDecision,
  planVerifierPipeline,
  sanitizeClarificationReviewDecision,
  shouldRunClarificationReview,
  type VerifierPipelineResult,
} from "./autonomy/index.js";
import { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import { WRITE_OPERATIONS } from "./autonomy/constants.js";
import { DMPolicy, isDestructiveOperation, type DMPolicyConfig } from "../security/dm-policy.js";
import {
  checkReadOnlyBlock,
  createReadOnlyToolStub,
  getReadOnlySystemPrompt,
} from "../security/read-only-guard.js";
import type { BackgroundTaskOptions, TaskUsageEvent } from "../tasks/types.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { MetricsRecorder } from "../metrics/metrics-recorder.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import { renderGoalTree, summarizeTree } from "../goals/goal-renderer.js";
import { formatResumePrompt, prepareTreeForResume } from "../goals/goal-resume.js";
import type { GoalTree, GoalNodeId, GoalStatus } from "../goals/types.js";
import { parseGoalBlock, buildGoalTreeFromBlock } from "../goals/types.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { SoulLoader } from "./soul/index.js";
import type { SessionSummarizer } from "../memory/unified/session-summarizer.js";
import type { UserProfileStore } from "../memory/unified/user-profile-store.js";
import { classifyErrorMessage } from "../utils/error-messages.js";
import { TaskClassifier } from "../agent-core/routing/task-classifier.js";
import type {
  TaskClassification,
  ExecutionPhase,
  ExecutionTraceSource,
  PhaseOutcomeStatus,
} from "../agent-core/routing/routing-types.js";

const MAX_TOOL_ITERATIONS = 50;
const TYPING_INTERVAL_MS = 4000;
const MAX_SESSIONS = 100;
const MAX_TOOL_RESULT_LENGTH = 8192;
const STREAM_THROTTLE_MS = 500; // Throttle streaming updates to channels
const AUTONOMOUS_MODE_DIRECTIVE = `\n\n## AUTONOMOUS MODE ACTIVE
You are operating in AUTONOMOUS MODE. The user has explicitly granted you full autonomy.
- Execute ALL operations directly without asking for confirmation
- Do NOT use ask_user tool for permission/confirmation questions
- Do NOT use show_plan tool to wait for approval — execute immediately
- If you use show_plan internally, make it concrete and execution-ready; strong plans are self-reviewed and auto-approved
- Only use ask_user when you genuinely cannot determine user intent (missing critical info)
- If you use ask_user anyway, prefer decision-ready options because the system may resolve the choice autonomously
- Proceed confidently with your best judgment on all write operations
- Budget and safety limits are still enforced automatically\n`;
const API_KEY_PATTERN =
  /(?:sk-|key-|token-|api[_-]?key[=: ]+|ghp_|gho_|ghu_|ghs_|ghr_|xox[bpas]-|Bearer\s+|AKIA[0-9A-Z]{16}|-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----|mongodb(?:\+srv)?:\/\/[^\s]+@)[a-zA-Z0-9_\-.]{10,}/gi;
const PLAN_PLACEHOLDER_PATTERN = /\b(todo|tbd|placeholder|fixme|fill in|coming soon|later)\b/i;
const PLAN_WAIT_PATTERN = /\b(wait for|wait on|ask user|user approval|get approval|request approval|confirm with user|before proceeding)\b/i;
const PLAN_EXECUTABLE_PATTERN = /\b(analy(?:se|ze)|inspect|read|search|trace|reproduce|implement|update|edit|write|refactor|run|test|verify|compare|document|review|check|measure|create|remove|rename|build|deploy)\b/i;
const PERMISSION_QUESTION_PATTERN = /\b(approve|approval|permission|okay|ok(?:ay)? to|should i|may i|can i|do you want me to|confirm|proceed|continue|go ahead|allowed)\b/i;
const AUTO_APPROVE_OPTION_PATTERN = /\b(approve|approved|continue|proceed|yes|ok|okay|go ahead|accept)\b/i;
const AUTO_REJECT_OPTION_PATTERN = /\b(reject|deny|cancel|stop|no)\b/i;
const NATURAL_LANGUAGE_AUTONOMOUS_HOURS = 24;
const SAFE_SHELL_SEGMENT_PATTERN =
  /^(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck)\b)|npx\s+(?:vitest|eslint|tsc)\b|git\s+(?:status|diff|log|show|branch|rev-parse)\b|(?:rg|ls|pwd|cat|head|tail|find|sed|wc|stat|grep|test)\b|(?:vitest|eslint|tsc)\b)/i;
const SHELL_REVIEW_SYSTEM_PROMPT = `You are the shell safety arbiter for an autonomous coding agent.
Decide whether the proposed shell command should execute automatically.

Approve only when BOTH are true:
1. The command is clearly aligned with the stated task.
2. The command is bounded and normal for software work (build, test, lint, inspect, status, search, diff).

Reject when the command is unrelated, broad, destructive, secret-seeking, privilege-escalating, remote-code-executing, or otherwise unsafe.

Return JSON only:
{"decision":"approve"|"reject","reason":"short reason","taskAligned":true|false,"bounded":true|false}`;
const INTERNAL_DECISION_LINE_RE = /^\s*\*{0,2}(DONE_WITH_SUGGESTIONS|DONE|REPLAN|CONTINUE)\*{0,2}\s*$/gim;
const SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT = `You are a synthesis worker inside Strada Brain's orchestrator.
The orchestrator remains the primary intelligence and the user-facing agent.
You are not the overall assistant for the session.

Your job:
- Convert verified execution artifacts into the final user-facing response.
- Preserve completed work, blockers, verification status, and next steps.
- Remove internal control markers such as DONE, CONTINUE, or REPLAN.
- Do not invent tool results, code changes, or success claims.
- If the task is incomplete or blocked, say that clearly.
- Do not ask for permission unless the evidence truly shows missing user intent.`;

interface Session {
  messages: ConversationMessage[];
  lastActivity: Date;
  conversationScope?: string;
  profileKey?: string;
  mixedParticipants?: boolean;
}

type ToolExecutionMode = "interactive" | "background";

interface ToolExecutionOptions {
  mode?: ToolExecutionMode;
  userId?: string;
  taskPrompt?: string;
  sessionMessages?: ConversationMessage[];
  onUsage?: (usage: TaskUsageEvent) => void;
  identityKey?: string;
  strategy?: SupervisorExecutionStrategy;
  agentState?: AgentState;
  touchedFiles?: readonly string[];
}

interface SelfManagedWriteReview {
  approved: boolean;
  reason?: string;
}

interface ShellCommandReviewDecision {
  decision?: "approve" | "reject";
  reason?: string;
  taskAligned?: boolean;
  bounded?: boolean;
}

interface ClarificationIntervention {
  kind: "none" | "continue" | "ask_user" | "blocked";
  gate?: string;
  message?: string;
  input?: Record<string, unknown>;
}

interface VerifierIntervention {
  kind: "approve" | "continue" | "replan";
  gate?: string;
  result: VerifierPipelineResult;
}

type SupervisorRole = "planner" | "executor" | "reviewer" | "synthesizer";

interface SupervisorAssignment {
  role: SupervisorRole;
  providerName: string;
  modelId?: string;
  provider: IAIProvider;
  reason: string;
  traceSource?: ExecutionTraceSource;
}

interface SupervisorExecutionStrategy {
  task: TaskClassification;
  planner: SupervisorAssignment;
  executor: SupervisorAssignment;
  reviewer: SupervisorAssignment;
  synthesizer: SupervisorAssignment;
  usesMultipleProviders: boolean;
}

/** Maps ISO codes to display names for system prompt injection. */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: "English", tr: "Turkish", ja: "Japanese", ko: "Korean",
  zh: "Chinese", de: "German", es: "Spanish", fr: "French",
};

/** Strip markdown control characters from user-supplied display names. */
function sanitizeDisplayName(raw: string): string {
  return raw.replace(/[*[\]()#`>!\\<&\r\n]/g, "").trim();
}

const NAME_INTRO_RE = /(?:ben\s+|i(?:'|’)m\s+|my name is\s+|ad[ıi]m\s+)([\p{L}]+)/iu;
const EXPLICIT_USER_NAME_RE = /(?:benim\s+ad[ıi]m|ad[ıi]m|my\s+name\s+is|i(?:'|’)m|call\s+me)\s+(?:şu|su|as)?\s*["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})/iu;
const USER_ADDRESS_NAME_RE = /(?:bana|beni)\s+["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})["”]?\s+(?:de|diye\s+(?:çağır|cagir|hitap\s+et)|call\s+me)/iu;
const ASSISTANT_NAME_RE = /(?:bundan\s+sonra\s+)?(?:senin\s+)?(?:ad[ıi]n|ismin|your\s+name\s+(?:should\s+be|is)|call\s+yourself)\s*(?:şu|su|as)?\s*(?:olsun|olacak|be|is|:|-)?\s*["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})/iu;
const RESPONSE_FORMAT_CUSTOM_RE =
  /(?:(?:şu|su|this|following)\s+format(?:ta)?(?:\s+(?:cevap\s+ver|reply|respond))?|(?:cevap|yanıt|reply|respond)(?:ların|ler?n)?\s*(?:şöyle|like\s+this|in\s+this\s+format))(?:\s+ol(?:sun|malı|acak))?\s*[:\-]?\s*(.+)$/iu;
const AUTONOMY_ENABLE_RE =
  /(?:\b(?:autonom|otonom|autonomous)\b.*\b(?:çalış|calis|aç|ac|aktif|etkin|enable|turn\s+on|work|ilerle)\b|\b(?:onay|approval)\b.*\b(?:sormadan|istemeden|without\s+asking|without\s+approval)\b|\b(?:tam\s+yetki|full\s+autonomy|full\s+authority)\b)/iu;
const AUTONOMY_DISABLE_RE =
  /(?:\b(?:autonom|otonom|autonomous)\b.*\b(?:kapat|kapa|disable|turn\s+off|devre\s+dışı|devre\s+disi|çalışma|calisma)\b|\b(?:onay|approval)\b.*\b(?:sor|iste|ask\s+first|require)\b)/iu;
const ULTRATHINK_ENABLE_RE =
  /(?:\bultrathink\b|\bultra\s+think\b|\bdeep(?:er)?\s+think(?:ing)?\b|\bderin\s+düş(?:ün|un)\b|\bçok\s+derin\s+düş(?:ün|un)\b)/iu;
const ULTRATHINK_DISABLE_RE =
  /(?:\bultrathink\b|\bultra\s+think\b).*\b(?:kapat|kapa|disable|turn\s+off|off|devre\s+dışı|devre\s+disi)\b/iu;
const EXACT_RESPONSE_LITERAL_PATTERNS = [
  /\b(?:say|write|reply|respond|answer|output)\s+exactly\s*[:\-]\s*["“]?([^"\n]+?)["”]?\s*$/iu,
  /\b(?:reply|respond|answer|output|write)\s+(?:with\s+)?only\s*[:\-]\s*["“]?([^"\n]+?)["”]?\s*$/iu,
  /\b(?:yalnızca|yalnizca|sadece)\s*[:\-]\s*["“]?([^"\n]+?)["”]?\s*(?:yaz|söyle|soyle|cevap\s+ver|yanıtla)?\s*$/iu,
] as const;

interface NaturalLanguageDirectiveUpdates {
  language?: string;
  displayName?: string;
  preferences?: Record<string, unknown>;
  autonomousMode?: {
    enabled: boolean;
    expiresAt?: number;
  };
}

function sanitizePreferenceText(raw: string, maxLength = 160): string {
  return raw
    .replace(API_KEY_PATTERN, "[REDACTED]")
    .replace(/[*[\]()#`>!\\<&]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function trimDirectiveTail(raw: string): string {
  const firstLine = raw.split(/[\r\n]/u, 1)[0] ?? "";
  const firstSentence = firstLine.split(/[.!?]/u, 1)[0] ?? firstLine;
  const firstClause = firstSentence.split(/\s+(?:ve|and|ama|but|lütfen|please|çünkü|because)\b/iu, 1)[0] ?? firstSentence;
  return firstClause
    .replace(/["“”'`]+/g, "")
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\b(?:olsun|olacak|be|is)$/iu, "")
    .trim();
}

function extractExactResponseLiteral(prompt: string): string | undefined {
  for (const pattern of EXACT_RESPONSE_LITERAL_PATTERNS) {
    const captured = prompt.match(pattern)?.[1];
    if (!captured) {
      continue;
    }
    const literal = sanitizePreferenceText(captured, 120)
      .replace(/^["“”'`]+|["“”'`]+$/g, "")
      .trim();
    if (literal.length > 0) {
      return literal;
    }
  }
  return undefined;
}

function buildExactResponseDirective(prompt: string): string {
  const literal = extractExactResponseLiteral(prompt);
  if (!literal) {
    return "";
  }
  return [
    "",
    "## STRICT RESPONSE CONTRACT",
    `The user requested an exact output literal: "${literal}"`,
    "- The visible final answer must be exactly that literal.",
    "- Do not add extra words, quotes, markdown, prefixes, suffixes, or explanations.",
    "",
  ].join("\n");
}

function applyVisibleResponseContract(prompt: string, responseText: string): string {
  const literal = extractExactResponseLiteral(prompt);
  return literal ?? responseText;
}

function getStringPreference(preferences: Record<string, unknown>, key: string, maxLength = 160): string | undefined {
  const value = preferences[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const sanitized = sanitizePreferenceText(value, maxLength);
  return sanitized.length > 0 ? sanitized : undefined;
}

function getBooleanPreference(preferences: Record<string, unknown>, key: string): boolean | undefined {
  const value = preferences[key];
  return typeof value === "boolean" ? value : undefined;
}

function resolveConversationScope(chatId: string, conversationId?: string): string {
  const normalizedConversationId = conversationId?.trim();
  return normalizedConversationId ? normalizedConversationId : chatId;
}

function resolveIdentityKey(chatId: string, userId?: string, conversationId?: string): string {
  const normalizedUserId = userId?.trim();
  if (normalizedUserId) {
    return normalizedUserId;
  }
  return resolveConversationScope(chatId, conversationId);
}

function detectVerbosityPreference(text: string): string | undefined {
  const responseIntent = /\b(cevap|yanıt|yaz|reply|respond|answer|açıkla|acikla|anlat|explain)\b/iu.test(text);
  if (/\b(kısa|kisa|brief|concise|short)\b/iu.test(text) && /\b(cevap|yanıt|yaz|reply|respond|answer|açıkla|acikla)\b/iu.test(text)) {
    return "brief";
  }
  if (responseIntent && /\b(detaylı|detayli|ayrıntılı|ayrintili|thorough|detailed|long-form|deep-dive)\b/iu.test(text)) {
    return "detailed";
  }
  if (responseIntent && /\b(orta|normal|balanced|moderate)\b/iu.test(text)) {
    return "moderate";
  }
  return undefined;
}

function detectCommunicationStylePreference(text: string): string | undefined {
  const styleIntent = /\b(cevap|yanıt|reply|respond|answer|üslup|uslup|ton|tone|style)\b/iu.test(text);
  if (!styleIntent) return undefined;
  if (/\b(resmi|formal)\b/iu.test(text)) return "formal";
  if (/\b(samimi|gündelik|gundelik|casual|friendly)\b/iu.test(text)) return "casual";
  if (/\b(minimal|yalın|yalin|plain|minimalist)\b/iu.test(text)) return "minimal";
  return undefined;
}

function detectResponseFormatPreference(text: string): { format?: string; instruction?: string } {
  const customMatch = text.match(RESPONSE_FORMAT_CUSTOM_RE);
  const instruction = customMatch?.[1]
    ? sanitizePreferenceText(customMatch[1].split(/[.!?]/u, 1)[0] ?? customMatch[1], 220)
    : undefined;
  const formatIntent = /\b(cevap|yanıt|reply|respond|answer|format)\b/iu.test(text) || Boolean(instruction);

  if (formatIntent && /\bjson\b/iu.test(text)) {
    return { format: "json", instruction };
  }
  if (formatIntent && /\b(madde\s+madde|bullet\s+points?|bullets?)\b/iu.test(text)) {
    return { format: "bullet points", instruction };
  }
  if (formatIntent && /\b(tablo|table)\b/iu.test(text)) {
    return { format: "table", instruction };
  }
  if (formatIntent && /\b(tek\s+paragraf|single\s+paragraph)\b/iu.test(text)) {
    return { format: "single paragraph", instruction };
  }

  if (instruction) {
    return { instruction };
  }

  return {};
}

function createStreamingProgressTimeout(initialTimeoutMs: number, stallTimeoutMs: number): {
  markProgress: () => void;
  timeoutPromise: Promise<never>;
  clear: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let sawProgress = false;
  let rejectTimeout: ((error: Error) => void) | undefined;

  const armTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    const timeoutMs = sawProgress ? stallTimeoutMs : initialTimeoutMs;
    timeoutId = setTimeout(() => {
      const message = sawProgress
        ? `Streaming stalled after ${stallTimeoutMs}ms without progress`
        : `Streaming did not start within ${initialTimeoutMs}ms`;
      rejectTimeout?.(new Error(message));
    }, timeoutMs);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });

  armTimeout();

  return {
    markProgress: () => {
      sawProgress = true;
      armTimeout();
    },
    timeoutPromise,
    clear: () => {
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
}

/** Build a list of profile attribute lines for system prompt injection. */
function buildProfileParts(profile: { displayName?: string; language: string; activePersona: string; preferences: unknown }): string[] {
  const parts: string[] = [];
  const preferences = profile.preferences as Record<string, unknown>;
  if (profile.displayName) parts.push(`Name: ${profile.displayName}`);
  parts.push(`Language: ${profile.language}`);
  if (profile.activePersona !== "default") parts.push(`Communication Style: ${profile.activePersona}`);
  const assistantName = getStringPreference(preferences, "assistantName", 80);
  if (assistantName) parts.push(`Assistant Identity: When referring to yourself, use the name "${assistantName}".`);
  const communicationStyle = getStringPreference(preferences, "communicationStyle", 60);
  if (communicationStyle) parts.push(`Reply Style: ${communicationStyle}`);
  const verbosity = getStringPreference(preferences, "verbosity", 40);
  if (verbosity) parts.push(`Detail Level: ${verbosity}`);
  const responseFormat = getStringPreference(preferences, "responseFormat", 80);
  if (responseFormat) parts.push(`Response Format Preference: ${responseFormat}`);
  const responseFormatInstruction = getStringPreference(preferences, "responseFormatInstruction", 220);
  if (responseFormatInstruction) parts.push(`Response Format Instruction: ${responseFormatInstruction}`);
  if (getBooleanPreference(preferences, "ultrathinkMode") === true) {
    parts.push("Reasoning Mode: Use extra-careful, multi-step internal reasoning before answering.");
  }
  return parts;
}

const FIRST_TIME_USER_PROMPT = `\n\n## First-Time User
This is a new user you haven't met before.

Onboarding rules:
1. If the user asked for concrete technical help, start solving it immediately.
2. Do not turn onboarding into a checklist, intake form, or option menu.
3. At most, ask one short natural follow-up about what to call them after you have already made concrete progress or given the first actionable answer.
4. Do not ask about communication style or explanation detail in the same first technical reply unless the user explicitly asks about preferences.
5. Start with the language from the Language Rule above, but if the user writes in a different language, match their language.

Remember the user's name after they tell you. Keep onboarding minimal and non-blocking.\n`;

/** Strip prompt injection patterns from stored text before injecting into system prompts. */
function sanitizePromptInjection(text: string): string {
  return text
    .replace(API_KEY_PATTERN, "[REDACTED]")
    .replace(/^(#{1,3}\s*(SYSTEM|IMPORTANT|INSTRUCTION|OVERRIDE|IGNORE))[:\s]/gim, "[filtered] ")
    .replace(/\r/g, "");
}

/** Default prompt when user sends an image with no text. */
const DEFAULT_IMAGE_PROMPT = "What is in this image?";

/**
 * Build user message content, converting image attachments to vision blocks
 * when the provider supports it.
 */
export function buildUserContent(
  text: string,
  attachments: Attachment[] | undefined,
  supportsVision: boolean,
): string | MessageContent[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const imageAttachments: Attachment[] = [];
  const nonImageAttachments: Attachment[] = [];
  for (const a of attachments) {
    if (a.mimeType && isVisionCompatible(a.mimeType) && (a.data || a.url)) {
      imageAttachments.push(a);
    } else {
      nonImageAttachments.push(a);
    }
  }

  // If no vision support or no image attachments, append text notes
  if (!supportsVision || imageAttachments.length === 0) {
    const notes = attachments
      .map((a) => `[Attached: ${a.name} (${a.mimeType ?? "unknown"})]`)
      .join("\n");
    return text ? `${text}\n\n${notes}` : notes;
  }

  // Build MessageContent[] with image blocks
  const content: MessageContent[] = [];

  // Text block (with non-image notes appended)
  let textPart = text;
  if (nonImageAttachments.length > 0) {
    const notes = nonImageAttachments
      .map((a) => `[Attached: ${a.name} (${a.mimeType ?? "unknown"})]`)
      .join("\n");
    textPart = textPart ? `${textPart}\n\n${notes}` : notes;
  }
  content.push({ type: "text", text: textPart || DEFAULT_IMAGE_PROMPT });

  // Image blocks
  for (const att of imageAttachments) {
    if (att.data) {
      content.push({
        type: "image",
        source: toBase64ImageSource(att.data, att.mimeType!),
      });
    } else if (att.url) {
      content.push({
        type: "image",
        source: { type: "url", url: att.url },
      });
    }
  }

  return content;
}

/**
 * The AI Agent Orchestrator - the "brain" of Strada Brain.
 *
 * Implements the core agent loop:
 *   User message → LLM → Tool calls → LLM → ... → Final response
 *
 * Manages conversation sessions per chat and routes tool calls.
 */
export class Orchestrator {
  private readonly providerManager: ProviderManager;
  private readonly tools: Map<string, ITool>;
  private readonly toolDefinitions: Array<{
    name: string;
    description: string;
    input_schema: import("../types/index.js").JsonObject;
  }>;
  private readonly channel: IChannelAdapter;
  private readonly projectPath: string;
  private readonly readOnly: boolean;
  private readonly requireConfirmation: boolean;
  private readonly memoryManager?: IMemoryManager;
  private readonly metrics?: MetricsCollector;
  private readonly ragPipeline?: IRAGPipeline;
  private readonly rateLimiter?: RateLimiter;
  private readonly streamingEnabled: boolean;
  private readonly defaultLanguage: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";
  private readonly streamInitialTimeoutMs: number;
  private readonly streamStallTimeoutMs: number;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private systemPrompt: string;
  private readonly getIdentityState?: () => IdentityState;
  private readonly crashRecoveryContext?: CrashRecoveryContext;
  private stradaDeps: StradaDepsStatus | undefined;
  private readonly stradaConfig?: Partial<StradaDependencyConfig>;
  private depsSetupComplete: boolean = false;
  private readonly pendingDepsPrompt = new Map<string, boolean>();
  private readonly pendingModulesPrompt = new Map<string, boolean>();
  private readonly instinctRetriever: InstinctRetriever | null;
  private readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  private readonly metricsRecorder: MetricsRecorder | null;
  /** Per-session matched instinct IDs for appliedInstinctIds attribution in tool:result events */
  private readonly currentSessionInstinctIds = new Map<string, string[]>();
  private readonly goalDecomposer: GoalDecomposer | null;
  private readonly reRetrievalConfig?: ReRetrievalConfig;
  private readonly embeddingProvider?: IEmbeddingProvider;
  /** Active goal trees per session for proactive/reactive decomposition */
  private readonly activeGoalTrees = new Map<string, GoalTree>();
  /** Interrupted goal trees detected on startup, pending user resume/discard decision */
  private readonly pendingResumeTrees = new Map<string, GoalTree[]>();
  /** TaskManager reference for inline goal detection submission (lazy setter) */
  private taskManager: TaskManager | null = null;
  private readonly soulLoader: SoulLoader | null;
  private readonly dmPolicy: DMPolicy;
  private readonly lastPersistTime = new Map<string, number>();
  private readonly sessionSummarizer?: SessionSummarizer;
  private readonly userProfileStore?: UserProfileStore;
  /** Multi-provider routing: selects best provider per task/phase. */
  private readonly providerRouter?: import("../agent-core/routing/provider-router.js").ProviderRouter;
  /** Live model intelligence for provider-aware prompting and trimming. */
  private readonly modelIntelligence?: ModelIntelligenceLookup;
  /** Consensus verification: cross-provider output validation on low confidence. */
  private readonly consensusManager?: import("../agent-core/routing/consensus-manager.js").ConsensusManager;
  /** Confidence estimation for consensus gating. */
  private readonly confidenceEstimator?: import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
  private readonly taskClassifier = new TaskClassifier();
  private readonly onUsage?: (usage: TaskUsageEvent) => void;

  constructor(opts: {
    providerManager: ProviderManager;
    tools: ITool[];
    channel: IChannelAdapter;
    projectPath: string;
    readOnly: boolean;
    requireConfirmation: boolean;
    memoryManager?: IMemoryManager;
    metrics?: MetricsCollector;
    ragPipeline?: IRAGPipeline;
    rateLimiter?: RateLimiter;
    streamingEnabled?: boolean;
    defaultLanguage?: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";
    streamInitialTimeoutMs?: number;
    streamStallTimeoutMs?: number;
    stradaDeps?: StradaDepsStatus;
    stradaConfig?: Partial<StradaDependencyConfig>;
    instinctRetriever?: InstinctRetriever;
    eventEmitter?: IEventEmitter<LearningEventMap>;
    metricsRecorder?: MetricsRecorder;
    goalDecomposer?: GoalDecomposer;
    interruptedGoalTrees?: GoalTree[];
    getIdentityState?: () => IdentityState;
    crashRecoveryContext?: CrashRecoveryContext;
    reRetrievalConfig?: ReRetrievalConfig;
    embeddingProvider?: IEmbeddingProvider;
    soulLoader?: SoulLoader;
    dmPolicyConfig?: Partial<DMPolicyConfig>;
    dmPolicy?: DMPolicy;
    sessionSummarizer?: SessionSummarizer;
    userProfileStore?: UserProfileStore;
    providerRouter?: import("../agent-core/routing/provider-router.js").ProviderRouter;
    modelIntelligence?: ModelIntelligenceLookup;
    consensusManager?: import("../agent-core/routing/consensus-manager.js").ConsensusManager;
    confidenceEstimator?: import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
    onUsage?: (usage: TaskUsageEvent) => void;
  }) {
    this.providerManager = opts.providerManager;
    this.channel = opts.channel;
    this.projectPath = opts.projectPath;
    this.readOnly = opts.readOnly;
    this.requireConfirmation = opts.requireConfirmation;
    this.memoryManager = opts.memoryManager;
    this.metrics = opts.metrics;
    this.ragPipeline = opts.ragPipeline;
    this.rateLimiter = opts.rateLimiter;
    this.streamingEnabled = opts.streamingEnabled ?? false;
    this.defaultLanguage = opts.defaultLanguage ?? "en";
    this.streamInitialTimeoutMs =
      opts.streamInitialTimeoutMs ?? DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS;
    this.streamStallTimeoutMs =
      opts.streamStallTimeoutMs ?? DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS;
    this.stradaConfig = opts.stradaConfig;
    this.instinctRetriever = opts.instinctRetriever ?? null;
    this.eventEmitter = opts.eventEmitter ?? null;
    this.metricsRecorder = opts.metricsRecorder ?? null;
    this.goalDecomposer = opts.goalDecomposer ?? null;
    for (const tree of opts.interruptedGoalTrees ?? []) {
      const existing = this.pendingResumeTrees.get(tree.sessionId) ?? [];
      existing.push(tree);
      this.pendingResumeTrees.set(tree.sessionId, existing);
    }
    this.reRetrievalConfig = opts.reRetrievalConfig;
    this.embeddingProvider = opts.embeddingProvider;
    this.soulLoader = opts.soulLoader ?? null;
    this.dmPolicy = opts.dmPolicy ?? new DMPolicy(opts.channel, opts.dmPolicyConfig);
    this.sessionSummarizer = opts.sessionSummarizer;
    this.userProfileStore = opts.userProfileStore;
    this.providerRouter = opts.providerRouter;
    this.modelIntelligence = opts.modelIntelligence;
    this.consensusManager = opts.consensusManager;
    this.confidenceEstimator = opts.confidenceEstimator;
    this.onUsage = opts.onUsage;
    this.getIdentityState = opts.getIdentityState;
    this.crashRecoveryContext = opts.crashRecoveryContext;

    // Build tool registry
    this.tools = new Map();
    this.toolDefinitions = [];
    for (const tool of opts.tools) {
      this.registerTool(tool);
    }

    this.stradaDeps = opts.stradaDeps;
    this.depsSetupComplete = !opts.stradaDeps || opts.stradaDeps.coreInstalled;
    this.systemPrompt = "";
    this.rebuildBaseSystemPrompt();
  }

  private rebuildBaseSystemPrompt(): void {
    this.systemPrompt =
      STRADA_SYSTEM_PROMPT +
      buildProjectContext(this.projectPath) +
      buildDepsContext(this.stradaDeps) +
      buildCapabilityManifest() +
      (this.readOnly ? getReadOnlySystemPrompt() : "") +
      (this.getIdentityState ? buildIdentitySection(this.getIdentityState()) : "") +
      (this.crashRecoveryContext ? buildCrashNotificationSection(this.crashRecoveryContext) : "");
  }

  private buildStaticSupervisorAssignment(
    role: SupervisorRole,
    providerName: string,
    modelId: string | undefined,
    provider: IAIProvider,
    reason: string,
    traceSource?: ExecutionTraceSource,
  ): SupervisorAssignment {
    return { role, providerName, modelId, provider, reason, traceSource };
  }

  private getProviderByNameOrFallback(
    providerName: string | undefined,
    fallbackProvider: IAIProvider,
  ): { providerName: string; provider: IAIProvider } {
    const normalizedName = providerName?.trim();
    const resolved =
      (normalizedName ? this.providerManager.getProviderByName?.(normalizedName) : null) ??
      fallbackProvider;
    return {
      providerName: normalizedName || fallbackProvider.name,
      provider: resolved,
    };
  }

  private resolveProviderModelId(
    providerName: string,
    identityKey: string,
  ): string | undefined {
    const normalizedProvider = providerName.trim().toLowerCase();
    const activeInfo = this.providerManager.getActiveInfo?.(identityKey);
    if (activeInfo?.providerName === normalizedProvider && activeInfo.model) {
      return activeInfo.model;
    }

    const executionCandidate = this.providerManager
      .listExecutionCandidates?.(identityKey)
      .find((candidate) => candidate.name === normalizedProvider);
    if (executionCandidate?.defaultModel) {
      return executionCandidate.defaultModel;
    }

    const availableCandidate = this.providerManager
      .listAvailable?.()
      .find((candidate) => candidate.name === normalizedProvider);
    return availableCandidate?.defaultModel;
  }

  private resolveSupervisorAssignment(
    role: SupervisorRole,
    task: TaskClassification,
    phase: string | undefined,
    identityKey: string,
    fallbackName: string,
    fallbackProvider: IAIProvider,
  ): SupervisorAssignment {
    if (!this.providerRouter) {
      return this.buildStaticSupervisorAssignment(
        role,
        fallbackName,
        this.resolveProviderModelId(fallbackName, identityKey),
        fallbackProvider,
        "routing unavailable, reusing the current worker",
      );
    }

    try {
      const routed = this.providerRouter.resolve(task, phase, { identityKey });
      const resolved = this.getProviderByNameOrFallback(routed.provider, fallbackProvider);
      return this.buildStaticSupervisorAssignment(
        role,
        resolved.providerName,
        this.resolveProviderModelId(resolved.providerName, identityKey),
        resolved.provider,
        routed.reason,
      );
    } catch {
      // Routing failure is non-fatal — use fallback provider
    }

    return this.buildStaticSupervisorAssignment(
      role,
      fallbackName,
      this.resolveProviderModelId(fallbackName, identityKey),
      fallbackProvider,
      "routing fallback, reusing the current worker",
    );
  }

  private buildSupervisorExecutionStrategy(
    prompt: string,
    identityKey: string,
    fallbackProvider: IAIProvider,
  ): SupervisorExecutionStrategy {
    const task = this.taskClassifier.classify(prompt);
    const activeInfo = this.providerManager.getActiveInfo?.(identityKey);
    const selected = this.getProviderByNameOrFallback(activeInfo?.providerName, fallbackProvider);
    const selectedProviderName = selected.providerName;
    const selectedProvider = selected.provider;

    const planner = this.resolveSupervisorAssignment(
      "planner",
      { ...task, type: "planning" },
      "planning",
      identityKey,
      selectedProviderName,
      selectedProvider,
    );

    const executor = this.buildStaticSupervisorAssignment(
      "executor",
      selectedProviderName,
      activeInfo?.model ?? this.resolveProviderModelId(selectedProviderName, identityKey),
      selectedProvider,
      activeInfo?.isDefault
        ? "selected system-default provider as the primary execution worker"
        : "kept the user-selected provider as the primary execution worker",
    );

    let reviewer = this.resolveSupervisorAssignment(
      "reviewer",
      { ...task, type: "code-review" },
      "reflecting",
      identityKey,
      planner.providerName,
      planner.provider,
    );
    if (reviewer.providerName === executor.providerName && planner.providerName !== executor.providerName) {
      reviewer = this.buildStaticSupervisorAssignment(
        "reviewer",
        planner.providerName,
        planner.modelId,
        planner.provider,
        "reused the planning worker as reviewer to keep execution and review separated",
      );
    }

    let synthesizer = this.resolveSupervisorAssignment(
      "synthesizer",
      { ...task, type: "simple-question" },
      undefined,
      identityKey,
      reviewer.providerName,
      reviewer.provider,
    );
    if (synthesizer.providerName === executor.providerName) {
      if (reviewer.providerName !== executor.providerName) {
        synthesizer = this.buildStaticSupervisorAssignment(
          "synthesizer",
          reviewer.providerName,
          reviewer.modelId,
          reviewer.provider,
          "reused the reviewer as the user-facing synthesis worker to keep execution separate",
        );
      } else if (planner.providerName !== executor.providerName) {
        synthesizer = this.buildStaticSupervisorAssignment(
          "synthesizer",
          planner.providerName,
          planner.modelId,
          planner.provider,
          "reused the planner as the user-facing synthesis worker to keep execution separate",
        );
      }
    }

    const uniqueProviders = new Set([
      planner.providerName,
      executor.providerName,
      reviewer.providerName,
      synthesizer.providerName,
    ]);

    return {
      task,
      planner,
      executor,
      reviewer,
      synthesizer,
      usesMultipleProviders: uniqueProviders.size > 1,
    };
  }

  private getSupervisorAssignmentForPhase(
    strategy: SupervisorExecutionStrategy,
    phase: AgentPhase,
  ): SupervisorAssignment {
    switch (phase) {
      case AgentPhase.PLANNING:
      case AgentPhase.REPLANNING:
        return strategy.planner;
      case AgentPhase.REFLECTING:
        return strategy.reviewer;
      case AgentPhase.EXECUTING:
      case AgentPhase.COMPLETE:
      case AgentPhase.FAILED:
      default:
        return strategy.executor;
    }
  }

  private getPinnedToolTurnAssignment(
    strategy: SupervisorExecutionStrategy,
    phase: AgentPhase,
    pinnedProvider: SupervisorAssignment | null,
  ): SupervisorAssignment {
    if (!pinnedProvider || phase === AgentPhase.COMPLETE || phase === AgentPhase.FAILED) {
      return this.getSupervisorAssignmentForPhase(strategy, phase);
    }

    const role = this.getSupervisorAssignmentForPhase(strategy, phase).role;
    return this.buildStaticSupervisorAssignment(
      role,
      pinnedProvider.providerName,
      pinnedProvider.modelId,
      pinnedProvider.provider,
      "kept the active tool-turn provider pinned to preserve provider-specific tool context",
      "tool-turn-affinity",
    );
  }

  private buildSupervisorRolePrompt(
    strategy: SupervisorExecutionStrategy,
    assignment: SupervisorAssignment,
  ): string {
    const providerCapabilities = this.providerManager.getProviderCapabilities?.(
      assignment.providerName,
      assignment.modelId,
    );
    const lines = [
      "## Orchestrator Assignment",
      "Strada Brain has already analyzed the user request and owns the overall decision-making.",
      "You are serving as a worker inside that orchestrated execution plan.",
      `Current worker role: ${assignment.role}`,
      "",
      "Execution strategy:",
      `- Planner: ${strategy.planner.providerName} (${strategy.planner.reason})`,
      `- Executor: ${strategy.executor.providerName} (${strategy.executor.reason})`,
      `- Reviewer: ${strategy.reviewer.providerName} (${strategy.reviewer.reason})`,
      `- Synthesizer: ${strategy.synthesizer.providerName} (${strategy.synthesizer.reason})`,
      "",
      "Role contract:",
    ];

    switch (assignment.role) {
      case "planner":
        lines.push(
          "- Produce or revise the plan only.",
          "- Do not take over the full user conversation.",
          "- Give the executor concrete, verifiable steps.",
        );
        break;
      case "executor":
        lines.push(
          "- Execute the current plan and use tools when needed.",
          "- Do not treat your draft as the final user-facing answer.",
          "- Leave final presentation to the synthesizer unless the orchestrator explicitly surfaces a blocker.",
          "- If the task is still locally inspectable, do not hand it back to the user as a clarification request.",
        );
        break;
      case "reviewer":
        lines.push(
          "- Evaluate progress, verification, and failure signals.",
          "- Decide whether execution should continue, replan, or complete.",
          "- Do not rewrite the whole conversation as the final user answer.",
          "- Decide whether ambiguity is internally resolvable or truly requires user clarification.",
        );
        break;
      case "synthesizer":
        lines.push(
          "- Produce the final user-facing response for the orchestrator.",
          "- Preserve verified facts and blockers only.",
          "- Never mention internal control markers or provider identities.",
          "- Only ask the user a clarifying question when clarification review explicitly approved it.",
        );
        break;
    }

    return `\n\n${lines.join("\n")}\n${buildProviderIntelligence(
      assignment.providerName,
      assignment.modelId,
      this.modelIntelligence,
      providerCapabilities,
      assignment.providerName,
    )}\n`;
  }

  private stripInternalDecisionMarkers(text: string | null | undefined): string {
    if (!text) {
      return "";
    }
    return text.replace(INTERNAL_DECISION_LINE_RE, "").trim();
  }

  private recordProviderUsage(
    providerName: string,
    usage: ProviderResponse["usage"] | undefined,
    onUsage?: (usage: TaskUsageEvent) => void,
  ): void {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    this.metrics?.recordTokenUsage(inputTokens, outputTokens, providerName);
    this.rateLimiter?.recordTokenUsage(inputTokens, outputTokens, providerName);
    onUsage?.({
      provider: providerName,
      inputTokens,
      outputTokens,
    });
  }

  private toExecutionPhase(phase: AgentPhase): ExecutionPhase {
    switch (phase) {
      case AgentPhase.PLANNING:
        return "planning";
      case AgentPhase.REFLECTING:
        return "reflecting";
      case AgentPhase.REPLANNING:
        return "replanning";
      case AgentPhase.EXECUTING:
      case AgentPhase.COMPLETE:
      case AgentPhase.FAILED:
      default:
        return "executing";
    }
  }

  private toPhaseOutcomeStatus(
    decision: "approve" | "continue" | "replan",
  ): PhaseOutcomeStatus {
    switch (decision) {
      case "approve":
        return "approved";
      case "replan":
        return "replanned";
      case "continue":
      default:
        return "continued";
    }
  }

  private transitionToVerifierReplan(state: AgentState, reflectionText?: string | null): AgentState {
    const enrichedState: AgentState = {
      ...state,
      failedApproaches: [...state.failedApproaches, extractApproachSummary(state)],
      lastReflection: reflectionText ?? state.lastReflection,
      reflectionCount: state.reflectionCount + 1,
      consecutiveErrors: 0,
    };

    if (enrichedState.phase === AgentPhase.REFLECTING) {
      return transitionPhase(enrichedState, AgentPhase.REPLANNING);
    }

    if (enrichedState.phase === AgentPhase.EXECUTING) {
      return transitionPhase(
        transitionPhase(enrichedState, AgentPhase.REFLECTING),
        AgentPhase.REPLANNING,
      );
    }

    return {
      ...enrichedState,
      phase: AgentPhase.REPLANNING,
    };
  }

  private resolveExecutionTraceSource(
    assignment: SupervisorAssignment,
    fallback: ExecutionTraceSource = "supervisor-strategy",
  ): ExecutionTraceSource {
    return assignment.traceSource ?? fallback;
  }

  private recordExecutionTrace(params: {
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: ExecutionPhase;
    source?: ExecutionTraceSource;
    task: TaskClassification;
    reason?: string;
  }): void {
    this.providerRouter?.recordExecutionTrace?.({
      provider: params.assignment.providerName,
      model: params.assignment.modelId,
      role: params.assignment.role,
      phase: params.phase,
      source: params.source ?? this.resolveExecutionTraceSource(params.assignment),
      reason: params.reason ?? params.assignment.reason,
      task: params.task,
      timestamp: Date.now(),
      identityKey: params.identityKey,
    });
  }

  private recordPhaseOutcome(params: {
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: ExecutionPhase;
    status: PhaseOutcomeStatus;
    task: TaskClassification;
    source?: ExecutionTraceSource;
    reason?: string;
  }): void {
    this.providerRouter?.recordPhaseOutcome?.({
      provider: params.assignment.providerName,
      model: params.assignment.modelId,
      role: params.assignment.role,
      phase: params.phase,
      source: params.source ?? this.resolveExecutionTraceSource(params.assignment),
      status: params.status,
      reason: params.reason ?? params.assignment.reason,
      task: params.task,
      timestamp: Date.now(),
      identityKey: params.identityKey,
    });
  }

  private resolveConsensusReviewAssignment(
    preferredReviewer: SupervisorAssignment,
    currentAssignment: SupervisorAssignment,
    identityKey: string,
  ): SupervisorAssignment | null {
    if (preferredReviewer.providerName !== currentAssignment.providerName) {
      return preferredReviewer;
    }

    const fallbackReviewName = this.providerManager
      .listAvailable()
      .find((provider) => provider.name !== currentAssignment.providerName)?.name;
    if (!fallbackReviewName) {
      return null;
    }

    const fallbackReviewProvider = this.getProviderByNameOrFallback(
      fallbackReviewName,
      currentAssignment.provider,
    );
    return this.buildStaticSupervisorAssignment(
      "reviewer",
      fallbackReviewProvider.providerName,
      this.resolveProviderModelId(fallbackReviewProvider.providerName, identityKey),
      fallbackReviewProvider.provider,
      "selected an alternate reviewer to keep consensus verification cross-provider",
    );
  }

  private shouldUseSupervisorSynthesis(strategy: SupervisorExecutionStrategy): boolean {
    return Boolean(this.providerRouter) && strategy.usesMultipleProviders;
  }

  private async synthesizeUserFacingResponse(params: {
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<string> {
    const cleanedDraft = this.stripInternalDecisionMarkers(params.draft);
    const exactLiteral = extractExactResponseLiteral(params.prompt);
    if (!cleanedDraft) {
      return "";
    }

    if (!this.shouldUseSupervisorSynthesis(params.strategy)) {
      return applyVisibleResponseContract(params.prompt, cleanedDraft);
    }

    const synthesisProvider = params.strategy.synthesizer.provider;
    const recentSteps = params.agentState.stepResults
      .slice(-8)
      .map((step) => `- [${step.success ? "OK" : "FAIL"}] ${step.toolName}: ${step.summary}`)
      .join("\n");
    const synthesisRequest = [
      "Create the final user-facing response for this completed orchestrated task.",
      "",
      `Original user request:\n${params.prompt}`,
      "",
      params.agentState.plan ? `Current plan:\n${params.agentState.plan}\n` : "Current plan:\n(none)\n",
      recentSteps ? `Verified execution evidence:\n${recentSteps}\n` : "Verified execution evidence:\n(no tool evidence)\n",
      `Worker draft:\n${cleanedDraft}`,
      "",
      "Requirements:",
      "- Preserve only verified facts.",
      "- Mention blockers if any remain.",
      "- Remove internal workflow markers.",
      "- Keep the answer directly usable for the user.",
      ...(exactLiteral
        ? [
            `- The user requested this exact visible output literal: "${exactLiteral}".`,
            "- Return exactly that literal if it is consistent with the verified execution evidence.",
          ]
        : []),
    ].join("\n");

    try {
      const synthesisResponse = await synthesisProvider.chat(
        `${params.systemPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(params.strategy, params.strategy.synthesizer)}`,
        [{ role: "user", content: synthesisRequest }],
        [],
      );
      this.recordExecutionTrace({
        identityKey: params.identityKey,
        assignment: params.strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        task: params.strategy.task,
      });
      this.recordProviderUsage(
        params.strategy.synthesizer.providerName,
        synthesisResponse.usage,
        params.usageHandler,
      );
      this.recordPhaseOutcome({
        identityKey: params.identityKey,
        assignment: params.strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "approved",
        task: params.strategy.task,
        reason: "Synthesis produced the final user-facing response.",
      });
      return applyVisibleResponseContract(
        params.prompt,
        this.stripInternalDecisionMarkers(synthesisResponse.text) || cleanedDraft,
      );
    } catch {
      this.recordPhaseOutcome({
        identityKey: params.identityKey,
        assignment: params.strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "failed",
        task: params.strategy.task,
        reason: "Synthesis failed; falling back to the worker draft.",
      });
      return applyVisibleResponseContract(params.prompt, cleanedDraft);
    }
  }

  async synthesizeGoalExecutionResult(params: {
    prompt: string;
    goalTree: GoalTree;
    executionResult: import("../goals/goal-executor.js").ExecutionResult;
    chatId: string;
    conversationId?: string;
    userId?: string;
    onUsage?: (usage: TaskUsageEvent) => void;
  }): Promise<string> {
    const identityKey = resolveIdentityKey(params.chatId, params.userId, params.conversationId);
    const fallbackProvider = this.providerManager.getProvider(identityKey);
    const strategy = this.buildSupervisorExecutionStrategy(params.prompt, identityKey, fallbackProvider);
    const synthesisProvider = strategy.synthesizer.provider;
    const rawDraft = params.executionResult.results
      .filter((result) => result.result)
      .map((result) => `## Sub-goal: ${result.task}\n\n${result.result}`)
      .join("\n\n---\n\n");

    if (!rawDraft.trim()) {
      return "";
    }

    const verifiedSteps = params.executionResult.results
      .map((result) => {
        if (result.result) {
          return `- [OK] ${result.task}: ${result.result}`;
        }
        return `- [FAIL] ${result.task}: ${result.error ?? "Unknown failure"}`;
      })
      .join("\n");

    const synthesisRequest = [
      "Create the final user-facing response for this completed decomposed task.",
      "",
      `Original user request:\n${params.prompt}`,
      "",
      `Goal summary:\n${summarizeTree(params.goalTree)}`,
      "",
      verifiedSteps ? `Verified sub-goal outcomes:\n${verifiedSteps}` : "Verified sub-goal outcomes:\n(none)",
      "",
      `Raw sub-goal draft:\n${rawDraft}`,
      "",
      "Requirements:",
      "- Respond as Strada's final user-facing answer, not as an internal sub-goal worker.",
      "- Do not expose internal sub-goal headers, plan scaffolding, or decomposition notes.",
      "- Preserve only verified facts from the provided execution evidence.",
      "- If the original request asks for an exact visible output literal, obey it.",
    ].join("\n");

    try {
      const synthesisResponse = await synthesisProvider.chat(
        `${this.systemPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(strategy, strategy.synthesizer)}`,
        [{ role: "user", content: synthesisRequest }],
        [],
      );
      this.recordExecutionTrace({
        identityKey,
        assignment: strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        task: strategy.task,
      });
      this.recordProviderUsage(
        strategy.synthesizer.providerName,
        synthesisResponse.usage,
        params.onUsage,
      );
      this.recordPhaseOutcome({
        identityKey,
        assignment: strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "approved",
        task: strategy.task,
        reason: "Goal synthesis produced the final user-facing response.",
      });
      return applyVisibleResponseContract(
        params.prompt,
        this.stripInternalDecisionMarkers(synthesisResponse.text) || rawDraft,
      );
    } catch {
      this.recordPhaseOutcome({
        identityKey,
        assignment: strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "failed",
        task: strategy.task,
        reason: "Goal synthesis failed; falling back to the raw execution draft.",
      });
      return applyVisibleResponseContract(params.prompt, rawDraft);
    }
  }

  /**
   * Dynamically add a tool to the orchestrator's available tools.
   * Used by chain synthesis to make composite tools available to the LLM.
   */
  addTool(tool: ITool): void {
    this.registerTool(tool);
  }

  /**
   * Dynamically remove a tool from the orchestrator's available tools.
   * Used by chain synthesis to remove invalidated composite tools.
   */
  removeTool(name: string): void {
    this.tools.delete(name);
    const idx = this.toolDefinitions.findIndex(td => td.name === name);
    if (idx >= 0) {
      this.toolDefinitions.splice(idx, 1);
    }
  }

  /**
   * Set the task manager reference for inline goal detection submission.
   * Uses lazy setter pattern to avoid circular dependency (same as BackgroundExecutor).
   */
  setTaskManager(tm: TaskManager): void {
    this.taskManager = tm;
  }

  /** Append soul personality section to a system prompt if available. */
  private injectSoulPersonality(systemPrompt: string, channelType?: string, personaOverride?: string): string {
    if (personaOverride) {
      return systemPrompt + `\n\n## Agent Personality\n\n${personaOverride}\n`;
    }
    if (!this.soulLoader) return systemPrompt;
    const soulContent = this.soulLoader.getContent(channelType);
    if (!soulContent) return systemPrompt;
    return systemPrompt + `\n\n## Agent Personality\n\n${soulContent}\n`;
  }

  private getClarificationReviewAssignment(
    identityKey: string,
    strategy?: SupervisorExecutionStrategy,
  ): SupervisorAssignment {
    if (strategy) {
      return this.buildStaticSupervisorAssignment(
        "reviewer",
        strategy.reviewer.providerName,
        strategy.reviewer.modelId,
        strategy.reviewer.provider,
        "reviewed whether clarification should stay internal or be surfaced to the user",
        "clarification-review",
      );
    }

    const fallbackProvider = this.providerManager.getProvider(identityKey);
    return this.buildStaticSupervisorAssignment(
      "reviewer",
      fallbackProvider.name,
      this.resolveProviderModelId(fallbackProvider.name, identityKey),
      fallbackProvider,
      "reviewed whether clarification should stay internal or be surfaced to the user",
      "clarification-review",
    );
  }

  private async reviewClarification(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    state: AgentState;
    touchedFiles?: readonly string[];
    strategy?: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<{
    decision: ReturnType<typeof sanitizeClarificationReviewDecision>;
    evidence: ReturnType<typeof collectClarificationReviewEvidence>;
  }> {
    const evidence = collectClarificationReviewEvidence({
      prompt: params.prompt,
      draft: params.draft,
      state: params.state,
      projectPath: this.projectPath,
      touchedFiles: params.touchedFiles,
    });
    const reviewer = this.getClarificationReviewAssignment(params.identityKey, params.strategy);
    const reviewTask = params.strategy?.task ?? this.taskClassifier.classify(params.prompt);
    const reviewStrategy = params.strategy ?? {
      task: reviewTask,
      planner: reviewer,
      executor: reviewer,
      reviewer,
      synthesizer: reviewer,
      usesMultipleProviders: false,
    };

    try {
      const reviewResponse = await reviewer.provider.chat(
        `${this.systemPrompt}\n\n${CLARIFICATION_REVIEW_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(reviewStrategy, reviewer)}`,
        [{
          role: "user",
          content: buildClarificationReviewRequest(evidence),
        }],
        [],
      );
      this.recordExecutionTrace({
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "clarification-review",
        source: "clarification-review",
        task: reviewTask,
      });
      this.recordAuxiliaryUsage(
        reviewer.providerName,
        reviewResponse.usage,
        params.usageHandler,
      );
      const decision = sanitizeClarificationReviewDecision(parseClarificationReviewDecision(reviewResponse.text));
      this.recordPhaseOutcome({
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "clarification-review",
        source: "clarification-review",
        status: decision?.decision === "ask_user"
          ? "blocked"
          : decision?.decision === "blocked"
            ? "blocked"
            : decision?.decision === "internal_continue"
              ? "continued"
              : "approved",
        task: reviewTask,
        reason: decision?.reason ?? "Clarification review completed.",
      });
      return { decision, evidence };
    } catch (error) {
      getLogger().warn("Clarification review provider failed", {
        chatId: params.chatId,
        provider: reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordPhaseOutcome({
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "clarification-review",
        source: "clarification-review",
        status: "failed",
        task: reviewTask,
        reason: "Clarification review provider failed; falling back to Strada-side decision.",
      });
    }

    return {
      decision: evidence.canInspectLocally
        ? {
            decision: "internal_continue",
            reason: "Strada still has a local inspection path and should continue internally.",
            recommendedNextAction: "Inspect local files, logs, tests, or runtime state before asking the user anything else.",
          }
        : {
            decision: "blocked",
            reason: "External clarification is still required because no local inspection path remains.",
            blockingType: "missing_external_info",
            question: "Please share the missing external detail needed to continue.",
          },
      evidence,
    };
  }

  private async resolveDraftClarificationIntervention(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    state: AgentState;
    strategy?: SupervisorExecutionStrategy;
    touchedFiles?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<ClarificationIntervention> {
    const cleanedDraft = this.stripInternalDecisionMarkers(params.draft);
    if (!cleanedDraft) {
      return { kind: "none" };
    }
    if (!shouldRunClarificationReview(cleanedDraft)) {
      return { kind: "none" };
    }

    const { decision, evidence } = await this.reviewClarification({
      ...params,
      draft: cleanedDraft,
    });

    switch (decision?.decision) {
      case "internal_continue":
        return {
          kind: "continue",
          gate: buildClarificationContinuationGate(evidence, decision),
        };
      case "ask_user":
      case "blocked":
        return {
          kind: decision.decision,
          message: formatClarificationPrompt(decision) ?? undefined,
        };
      default:
        return { kind: "none" };
    }
  }

  private async resolveAskUserClarificationIntervention(params: {
    chatId: string;
    identityKey: string;
    toolCall: ToolCall;
    prompt: string;
    state: AgentState;
    strategy?: SupervisorExecutionStrategy;
    touchedFiles?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<ClarificationIntervention> {
    const question = this.normalizeInteractiveText(params.toolCall.input["question"]);
    const context = this.normalizeInteractiveText(params.toolCall.input["context"]);
    const options = Array.isArray(params.toolCall.input["options"])
      ? params.toolCall.input["options"].map((option) => this.normalizeInteractiveText(option)).filter(Boolean)
      : [];
    const recommended = this.normalizeInteractiveText(params.toolCall.input["recommended"]);
    const draft = [
      context ? `Context: ${context}` : "",
      question ? `Question: ${question}` : "",
      options.length > 0 ? `Options: ${options.join(" | ")}` : "",
      recommended ? `Recommended: ${recommended}` : "",
    ].filter(Boolean).join("\n");

    const { decision, evidence } = await this.reviewClarification({
      ...params,
      draft,
    });

    if (decision?.decision === "internal_continue") {
      return {
        kind: "continue",
        gate: buildClarificationContinuationGate(evidence, decision),
      };
    }

    if (decision?.decision === "ask_user" || decision?.decision === "blocked") {
      const approvedQuestion = decision.question?.trim() || question;
      const approvedOptions = decision.options?.filter((option) => option.trim().length > 0) ?? options;
      const approvedRecommended = decision.recommendedOption?.trim() || recommended || undefined;

      return {
        kind: decision.decision,
        input: {
          question: approvedQuestion,
          ...(approvedOptions.length > 0 ? { options: approvedOptions } : {}),
          ...(approvedRecommended ? { recommended: approvedRecommended } : {}),
          ...(decision.reason?.trim() ? { context: decision.reason.trim() } : context ? { context } : {}),
        },
      };
    }

    return { kind: "none" };
  }

  /**
   * Build 4-layer context injection for system prompt enrichment.
   * Layers: User Profile, Last Session Summary, Open Tasks/Goals, Semantic Memory.
   */
  private async buildContextLayers(
    goalScope: string,
    userMessage: string,
    profile: import("../memory/unified/user-profile-store.js").UserProfile | null,
    preComputedEmbedding?: number[],
  ): Promise<{ context: string; contentHashes: string[] }> {
    const layers: string[] = [];
    const contentHashes: string[] = [];

    // Layer 1: User Profile
    if (profile) {
      const parts = buildProfileParts(profile);
      if (parts.length > 0) layers.push(`## User Context\nUse this information naturally in your responses. Address the user by name and respect their preferences.\n${parts.join("\n")}`);
    }

    // Layer 2: Last Session Summary (data only, not instructions)
    if (profile?.contextSummary) {
      layers.push(`## Previous Session\nReference this context naturally when relevant. Mention past work to show continuity.\n${sanitizePromptInjection(profile.contextSummary)}`);
      contentHashes.push(profile.contextSummary);
    }

    // Layer 3: Open Tasks/Goals
    const activeGoalTree = this.activeGoalTrees?.get(goalScope);
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

    // Layer 4: Semantic Memory (real embedding search)
    if (this.memoryManager && userMessage) {
      try {
        const memoriesResult = await this.memoryManager.retrieve({
          mode: "semantic",
          query: userMessage,
          limit: 5,
          minScore: 0.15,
          embedding: preComputedEmbedding,
        } as import("../memory/memory.interface.js").SemanticRetrievalOptions);
        if (isOk(memoriesResult)) {
          const memories = memoriesResult.value;
          if (memories.length > 0) {
            const memoryContext = memories
              .map((m) => m.entry.content)
              .join("\n---\n");
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

    const context = layers.length > 0
      ? `\n\n<!-- context-layers:start -->\n${layers.join("\n\n")}\n<!-- context-layers:end -->\n`
      : "";

    return { context, contentHashes };
  }

  /**
   * Build a complete system prompt with all context layers.
   * Shared by both runAgentLoop (interactive) and runBackgroundTask (background).
   */
  private async buildSystemPromptWithContext(params: {
    chatId: string;
    conversationScope: string;
    identityKey: string;
    userId?: string;
    channelType?: string;
    prompt: string;
    personaContent?: string;
    allowFirstTimeOnboarding: boolean;
    profile: { displayName?: string; language: string; activePersona: string; preferences: unknown; contextSummary?: string } | null;
    preComputedEmbedding?: number[];
  }): Promise<{ systemPrompt: string; initialContentHashes: string[] }> {
    const logger = getLogger();

    // 1. Language directive — FIRST, highest priority, before personality
    // Always inject: profile language > LANGUAGE_PREFERENCE env > "en"
    const effectiveLang = params.profile?.language ?? this.defaultLanguage;
    const langName = LANGUAGE_DISPLAY_NAMES[effectiveLang] ?? "English";
    const langDirective = `\n## LANGUAGE RULE\nYour current language is ${langName}. Respond in ${langName} unless the user clearly switches to a different language — in that case, follow their lead.\n`;

    // 2. Soul personality injection (with optional persona override)
    let systemPrompt = langDirective + this.injectSoulPersonality(this.systemPrompt, params.channelType, params.personaContent);

    // 2.5. Exact literal-output requests need a hard response contract.
    systemPrompt += buildExactResponseDirective(params.prompt);

    // 3. Autonomous mode directive
    if (this.dmPolicy?.isAutonomousActive(params.chatId, params.userId)) {
      systemPrompt += AUTONOMOUS_MODE_DIRECTIVE;
    }

    // 4. Context layers (user profile, session summary, open tasks, semantic memory)
    const { context: contextLayers, contentHashes } = await this.buildContextLayers(
      params.conversationScope,
      params.prompt,
      params.profile as import("../memory/unified/user-profile-store.js").UserProfile | null,
      params.preComputedEmbedding,
    );
    systemPrompt += contextLayers;
    const initialContentHashes: string[] = [...contentHashes];

    // 5. First-time user prompt (only for direct user tasks without a known profile)
    if (params.allowFirstTimeOnboarding && (!params.profile || !params.profile.displayName)) {
      systemPrompt += FIRST_TIME_USER_PROMPT;
    }

    // 6. RAG injection
    if (this.ragPipeline && params.prompt) {
      try {
        const ragResults = await this.ragPipeline.search(params.prompt, {
          topK: 6,
          minScore: 0.2,
          queryEmbedding: params.preComputedEmbedding,
        });
        if (ragResults.length > 0) {
          const ragFormatted = this.ragPipeline.formatContext(ragResults);
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

    // 7. Analysis cache injection
    if (this.memoryManager) {
      try {
        const analysisResult = await this.memoryManager.getCachedAnalysis(this.projectPath);
        if (isOk(analysisResult)) {
          const analysisOpt = analysisResult.value;
          if (isSome(analysisOpt)) {
            systemPrompt += buildAnalysisSummary(analysisOpt.value);
          }
        }
      } catch {
        // Analysis cache failure is non-fatal
      }
    }

    return { systemPrompt, initialContentHashes };
  }

  /**
   * Public accessor for active sessions (used by dashboard /api/sessions).
   */
  getSessions(): Map<string, { lastActivity: Date; messageCount: number }> {
    const result = new Map<string, { lastActivity: Date; messageCount: number }>();
    for (const [chatId, session] of this.sessions) {
      result.set(chatId, {
        lastActivity: session.lastActivity,
        messageCount: session.messages.length,
      });
    }
    return result;
  }

  /**
   * Handle an incoming message from any channel.
   * Uses a per-session lock to prevent concurrent processing.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;

    // Intercept messages if Strada.Core is missing and setup not complete
    if (!this.depsSetupComplete && this.stradaDeps && !this.stradaDeps.coreInstalled) {
      await this.handleDepsSetup(msg);
      return;
    }

    // Handle pending modules prompt after core installation
    if (this.pendingModulesPrompt.get(chatId)) {
      await this.handleModulesPrompt(msg);
      return;
    }

    // Per-session concurrency lock: queue messages for the same chat
    const prev = this.sessionLocks.get(chatId) ?? Promise.resolve();
    const current = prev.then(() => this.processMessage(msg));
    const tracked = current.catch((err) => {
      getLogger().error("Session lock error", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.sessionLocks.set(chatId, tracked);
    try {
      await current;
    } finally {
      // Clean up resolved lock to prevent unbounded map growth
      if (this.sessionLocks.get(chatId) === tracked) {
        this.sessionLocks.delete(chatId);
      }
    }
  }

  /**
   * Run a task in the background with abort support and progress reporting.
   * Used by the task system for async execution.
   */
  async runBackgroundTask(prompt: string, options: BackgroundTaskOptions): Promise<string> {
    const logger = getLogger();
    const { signal, onProgress, chatId } = options;
    const conversationScope = resolveConversationScope(chatId, options.conversationId);
    const identityKey = resolveIdentityKey(chatId, options.userId, options.conversationId);
    const fallbackProvider = this.providerManager.getProvider(identityKey);
    const executionStrategy = this.buildSupervisorExecutionStrategy(prompt, identityKey, fallbackProvider);

    // ─── Metrics: start recording ────────────────────────────────────
    const taskType = options.parentMetricId ? "subtask" as const : "background" as const;
    const metricId = this.metricsRecorder?.startTask({
      sessionId: chatId,
      taskDescription: prompt.slice(0, 200),
      taskType,
      parentTaskId: options.parentMetricId,
    });
    // ────────────────────────────────────────────────────────────────

    // Build user content with vision support if attachments present
    const supportsVision = fallbackProvider.capabilities.vision;
    const userContent = buildUserContent(prompt || DEFAULT_IMAGE_PROMPT, options.attachments, supportsVision);
    const session: Session = {
      messages: [{ role: "user", content: userContent }],
      lastActivity: new Date(),
    };

    let profile = this.userProfileStore?.getProfile(identityKey) ?? null;

    // Touch user profile (debounced)
    if (this.userProfileStore && profile) {
      const lastTouch = this.lastPersistTime.get(`touch:${identityKey}`) ?? 0;
      if (Date.now() - lastTouch > 60_000) {
        this.userProfileStore.touchLastSeen(identityKey);
        this.lastPersistTime.set(`touch:${identityKey}`, Date.now());
      }
    }

    await this.maybeUpdateUserProfileFromPrompt(chatId, identityKey, prompt, options.userId);
    profile = this.userProfileStore?.getProfile(identityKey) ?? profile;

    // Load autonomous mode from profile at session start
    if (this.dmPolicy && this.userProfileStore) {
      try {
        const autonomousState = await this.userProfileStore.isAutonomousMode(identityKey);
        if (autonomousState.enabled) {
          this.dmPolicy.initFromProfile(chatId, {
            autonomousMode: true,
            autonomousExpiresAt: autonomousState.expiresAt,
          }, options.userId);
        }
      } catch {
        // Autonomous mode restoration failure is non-fatal
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // Pre-compute embedding once for memory + RAG search (avoids redundant calls)
    let bgEmbedding: number[] | undefined;
    if (this.embeddingProvider && prompt) {
      try {
        const batch = await this.embeddingProvider.embed([prompt]);
        bgEmbedding = batch.embeddings[0];
      } catch {
        // Embedding failure is non-fatal; downstream calls will embed on demand
      }
    }

    // Build system prompt with all context layers (DRY: shared with runAgentLoop)
    const { systemPrompt: builtPrompt, initialContentHashes: bgInitialContentHashes } = await this.buildSystemPromptWithContext({
      chatId,
      conversationScope,
      identityKey,
      channelType: options.channelType,
      prompt,
      allowFirstTimeOnboarding: false,
      profile,
      preComputedEmbedding: bgEmbedding,
    });
    let systemPrompt = builtPrompt;

    // ─── PAOR State Machine ──────────────────────────────────────────────
    let bgAgentState = createInitialState(prompt);

    if (this.instinctRetriever) {
      try {
        const insightResult = await this.instinctRetriever.getInsightsForTask(prompt);
        if (insightResult.insights.length > 0) {
          bgAgentState = { ...bgAgentState, learnedInsights: insightResult.insights };
          const insightsText = insightResult.insights.join("\n");
          systemPrompt += `\n\n## Learned Insights\n${insightsText}\n`;
        }
      } catch {
        // Non-fatal
      }
    }

    const BG_REFLECT_INTERVAL = 3;
    // ────────────────────────────────────────────────────────────────────

    // ─── Memory Re-retrieval: create refresher for background path ───
    const bgMemoryRefresher = this.createMemoryRefresher(bgInitialContentHashes);
    // ────────────────────────────────────────────────────────────────

    // Autonomy layer
    const errorRecovery = new ErrorRecoveryEngine();
    const taskPlanner = new TaskPlanner();
    const selfVerification = new SelfVerification();
    const stradaConformance = new StradaConformanceGuard(this.stradaDeps);
    const taskStartedAtMs = Date.now();
    stradaConformance.trackPrompt(prompt);
    let toolTurnAffinity: SupervisorAssignment | null = null;

    let bgIteration = 0;
    let bgToolCallCount = 0;

    try {
      for (bgIteration = 0; bgIteration < MAX_TOOL_ITERATIONS; bgIteration++) {
        // Check cancellation
        if (signal.aborted) {
          throw new Error("Task cancelled");
        }

        // ─── PAOR: Build phase-aware system prompt ──────────────────────
        let activePrompt = systemPrompt;
        switch (bgAgentState.phase) {
          case AgentPhase.PLANNING:
            activePrompt += "\n\n" + buildPlanningPrompt(
              bgAgentState.taskDescription,
              bgAgentState.learnedInsights,
              { enableGoalDetection: false }, // Background tasks don't spawn sub-goals
            );
            break;
          case AgentPhase.EXECUTING:
            activePrompt += buildExecutionContext(bgAgentState);
            break;
          case AgentPhase.REPLANNING:
            activePrompt += "\n\n" + buildReplanningPrompt(bgAgentState);
            break;
        }
        // ────────────────────────────────────────────────────────────────

        const currentAssignment = this.getPinnedToolTurnAssignment(
          executionStrategy,
          bgAgentState.phase,
          toolTurnAffinity,
        );
        const currentProvider = currentAssignment.provider;
        activePrompt += this.buildSupervisorRolePrompt(executionStrategy, currentAssignment);

        const response = await currentProvider.chat(
          activePrompt,
          session.messages,
          this.toolDefinitions,
        );
        this.recordExecutionTrace({
          identityKey,
          assignment: currentAssignment,
          phase: this.toExecutionPhase(bgAgentState.phase),
          source: this.resolveExecutionTraceSource(currentAssignment),
          task: executionStrategy.task,
        });

        logger.debug("Background task LLM response", {
          chatId,
          iteration: bgIteration,
          phase: bgAgentState.phase,
          stopReason: response.stopReason,
          toolCallCount: response.toolCalls.length,
        });
        if (
          response.toolCalls.length > 0 &&
          !toolTurnAffinity &&
          bgAgentState.phase !== AgentPhase.PLANNING &&
          bgAgentState.phase !== AgentPhase.REPLANNING
        ) {
          toolTurnAffinity = currentAssignment;
        }
        this.recordProviderUsage(
          currentAssignment.providerName,
          response.usage,
          options.onUsage ?? this.onUsage,
        );

        // ─── PAOR: Handle REFLECTING phase response ─────────────────────
        if (bgAgentState.phase === AgentPhase.REFLECTING) {
          const decision = parseReflectionDecision(response.text);

          if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
            const clarificationIntervention = await this.resolveDraftClarificationIntervention({
              chatId,
              identityKey,
              prompt,
              draft: response.text ?? "",
              state: bgAgentState,
              strategy: executionStrategy,
              touchedFiles: [...selfVerification.getState().touchedFiles],
              usageHandler: options.onUsage ?? this.onUsage,
            });
            if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
              bgAgentState = {
                ...bgAgentState,
                lastReflection: response.text ?? bgAgentState.lastReflection,
                reflectionCount: bgAgentState.reflectionCount + 1,
                consecutiveErrors: 0,
              };
              bgAgentState = transitionPhase(bgAgentState, AgentPhase.EXECUTING);
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: clarificationIntervention.gate });
              onProgress("Clarification review kept the task internal");
              continue;
            }
            if ((clarificationIntervention.kind === "ask_user" || clarificationIntervention.kind === "blocked") && clarificationIntervention.message) {
              session.messages.push({ role: "assistant", content: clarificationIntervention.message });
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: bgAgentState.iteration,
                toolCallCount: bgToolCallCount,
                hitMaxIterations: false,
              });
              await this.persistSessionToMemory(chatId, session.messages, /* force */ true);
              return clarificationIntervention.message;
            }

            const verifierIntervention = await this.resolveVerifierIntervention({
              chatId,
              identityKey,
              prompt,
              state: bgAgentState,
              draft: response.text,
              selfVerification,
              stradaConformance,
              strategy: executionStrategy,
              taskStartedAtMs,
              usageHandler: options.onUsage ?? this.onUsage,
            });
            if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
              this.recordPhaseOutcome({
                identityKey,
                assignment: currentAssignment,
                phase: "reflecting",
                status: "continued",
                task: executionStrategy.task,
                reason: verifierIntervention.result.summary,
              });
              bgAgentState = {
                ...bgAgentState,
                lastReflection: response.text ?? bgAgentState.lastReflection,
                reflectionCount: bgAgentState.reflectionCount + 1,
                consecutiveErrors: 0,
              };
              bgAgentState = transitionPhase(bgAgentState, AgentPhase.EXECUTING);
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: verifierIntervention.gate });
              onProgress("Verification required before completion");
              continue;
            }
            if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
              this.recordPhaseOutcome({
                identityKey,
                assignment: currentAssignment,
                phase: "reflecting",
                status: "replanned",
                task: executionStrategy.task,
                reason: verifierIntervention.result.summary,
              });
              bgAgentState = this.transitionToVerifierReplan(bgAgentState, response.text);
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: verifierIntervention.gate });
              onProgress("Verifier pipeline requested a replan");
              continue;
            }

            const finalText = await this.synthesizeUserFacingResponse({
              identityKey,
              prompt,
              draft: response.text ?? "",
              agentState: bgAgentState,
              strategy: executionStrategy,
              systemPrompt,
              usageHandler: options.onUsage ?? this.onUsage,
            });
            if (finalText) {
              session.messages.push({ role: "assistant", content: finalText });
            }
            this.recordPhaseOutcome({
              identityKey,
              assignment: currentAssignment,
              phase: "reflecting",
              status: "approved",
              task: executionStrategy.task,
              reason: "Reflection accepted completion after the verifier pipeline cleared the task.",
            });
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: bgAgentState.iteration,
              toolCallCount: bgToolCallCount,
              hitMaxIterations: false,
            });
            await this.persistSessionToMemory(chatId, session.messages, /* force */ true);
            return finalText || "Task completed without output.";
          }

          if (decision === "REPLAN") {
            bgAgentState = {
              ...bgAgentState,
              failedApproaches: [...bgAgentState.failedApproaches, extractApproachSummary(bgAgentState)],
              lastReflection: response.text ?? null,
              reflectionCount: bgAgentState.reflectionCount + 1,
            };
            bgAgentState = transitionPhase(bgAgentState, AgentPhase.REPLANNING);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: "Please create a new plan." });
            onProgress("Replanning: current approach needs adjustment");
            continue;
          }

          // CONTINUE
          bgAgentState = {
            ...bgAgentState,
            reflectionCount: bgAgentState.reflectionCount + 1,
            consecutiveErrors: 0,
          };
          bgAgentState = transitionPhase(bgAgentState, AgentPhase.EXECUTING);

          if (response.toolCalls.length === 0) {
            if (shouldSurfaceTerminalFailureFromReflection(response)) {
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: bgAgentState.iteration,
                toolCallCount: bgToolCallCount,
                hitMaxIterations: false,
              });
              await this.persistSessionToMemory(chatId, session.messages, /* force */ true);
              return response.text || "Task completed without output.";
            }

            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: "Please continue." });
            continue;
          }
        }
        // ────────────────────────────────────────────────────────────────

        // Final response — return text
        if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
          const clarificationIntervention = await this.resolveDraftClarificationIntervention({
            chatId,
            identityKey,
            prompt,
            draft: response.text ?? "",
            state: bgAgentState,
            strategy: executionStrategy,
            touchedFiles: [...selfVerification.getState().touchedFiles],
            usageHandler: options.onUsage ?? this.onUsage,
          });
          if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: clarificationIntervention.gate });
            continue;
          }
          if ((clarificationIntervention.kind === "ask_user" || clarificationIntervention.kind === "blocked") && clarificationIntervention.message) {
            session.messages.push({ role: "assistant", content: clarificationIntervention.message });
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: bgAgentState.iteration,
              toolCallCount: bgToolCallCount,
              hitMaxIterations: false,
            });
            await this.persistSessionToMemory(chatId, session.messages, /* force */ true);
            return clarificationIntervention.message;
          }

          const verifierIntervention = await this.resolveVerifierIntervention({
            chatId,
            identityKey,
            prompt,
            state: bgAgentState,
            draft: response.text,
            selfVerification,
            stradaConformance,
            strategy: executionStrategy,
            taskStartedAtMs,
            usageHandler: options.onUsage ?? this.onUsage,
          });
          if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
            this.recordPhaseOutcome({
              identityKey,
              assignment: currentAssignment,
              phase: this.toExecutionPhase(bgAgentState.phase),
              status: "continued",
              task: executionStrategy.task,
              reason: verifierIntervention.result.summary,
            });
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: verifierIntervention.gate });
            continue;
          }
          if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
            this.recordPhaseOutcome({
              identityKey,
              assignment: currentAssignment,
              phase: this.toExecutionPhase(bgAgentState.phase),
              status: "replanned",
              task: executionStrategy.task,
              reason: verifierIntervention.result.summary,
            });
            bgAgentState = this.transitionToVerifierReplan(bgAgentState, response.text);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: verifierIntervention.gate });
            continue;
          }

          const finalText = await this.synthesizeUserFacingResponse({
            identityKey,
            prompt,
            draft: response.text ?? "",
            agentState: bgAgentState,
            strategy: executionStrategy,
            systemPrompt,
            usageHandler: options.onUsage ?? this.onUsage,
          });
          if (finalText) {
            session.messages.push({ role: "assistant", content: finalText });
          }
          this.recordPhaseOutcome({
            identityKey,
            assignment: currentAssignment,
            phase: this.toExecutionPhase(bgAgentState.phase),
            status: "approved",
            task: executionStrategy.task,
            reason: "Execution produced a final response after the verifier pipeline cleared the task.",
          });

          // ─── Metrics: record success ────────────────────────────────
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: bgAgentState.iteration,
            toolCallCount: bgToolCallCount,
            hitMaxIterations: false,
          });
          // ────────────────────────────────────────────────────────────

          // Persist background task conversation to memory
          await this.persistSessionToMemory(chatId, session.messages, /* force */ true);

          return finalText || "Task completed without output.";
        }

        // ─── PAOR: Phase transitions ────────────────────────────────────
        if (bgAgentState.phase === AgentPhase.PLANNING) {
          bgAgentState = { ...bgAgentState, plan: response.text ?? null };
          bgAgentState = transitionPhase(bgAgentState, AgentPhase.EXECUTING);
        }
        if (bgAgentState.phase === AgentPhase.REPLANNING) {
          bgAgentState = { ...bgAgentState, plan: response.text ?? null };
          bgAgentState = transitionPhase(bgAgentState, AgentPhase.EXECUTING);
        }
        // ────────────────────────────────────────────────────────────────

        // Handle tool calls
        session.messages.push({
          role: "assistant",
          content: response.text,
          tool_calls: response.toolCalls,
        });

        const toolResults = await this.executeToolCalls(chatId, response.toolCalls, {
          mode: "background",
          taskPrompt: prompt,
          sessionMessages: session.messages,
          onUsage: options.onUsage ?? this.onUsage,
          identityKey,
          strategy: executionStrategy,
          agentState: bgAgentState,
          touchedFiles: [...selfVerification.getState().touchedFiles],
        });
        bgToolCallCount += response.toolCalls.length;

        // Autonomy tracking
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]!;
          const tr = toolResults[i]!;
          taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
          selfVerification.track(tc.name, tc.input, tr);
          stradaConformance.trackToolCall(tc.name, tc.input, tr.isError ?? false, tr.content);

          const analysis = errorRecovery.analyze(tc.name, tr);
          if (analysis) {
            taskPlanner.recordError(analysis.summary);
            toolResults[i] = {
              toolCallId: tr.toolCallId,
              content: sanitizeToolResult(tr.content + analysis.recoveryInjection),
              isError: tr.isError,
            };
          }

          this.emitToolResult(chatId, tc, toolResults[i]!);
        }

        // Progress report: summarize tool calls
        const toolNames = response.toolCalls.map((tc) => tc.name).join(", ");
        onProgress(`Running tools: ${toolNames}`);

        // ─── Consensus: verify output with second provider if confidence is low ───
        if (this.consensusManager && this.confidenceEstimator && this.providerRouter) {
          try {
            const bgTaskClass = this.taskClassifier.classify(prompt);
            const bgConfidence = this.confidenceEstimator.estimate({
              task: bgTaskClass,
              providerName: currentAssignment.providerName,
              providerCapabilities: currentProvider.capabilities,
              agentState: bgAgentState,
              responseLength: (response.text ?? "").length,
            });

            const bgAvailableCount = this.providerManager.listAvailable().length;
            const bgStrategy = this.consensusManager.shouldConsult(bgConfidence, bgTaskClass, bgAvailableCount);

            if (bgStrategy !== "skip" && bgAvailableCount >= 2) {
              const bgReviewAssignment = this.resolveConsensusReviewAssignment(
                executionStrategy.reviewer,
                currentAssignment,
                identityKey,
              );
              if (bgReviewAssignment) {
                if (bgReviewAssignment.provider) {
                  const bgConsensusResult = await this.consensusManager.verify({
                    originalOutput: {
                      text: response.text ?? undefined,
                      toolCalls: response.toolCalls.map((tc: ToolCall) => ({
                        name: tc.name,
                        input: tc.input,
                      })),
                    },
                    originalProvider: currentAssignment.providerName,
                    task: bgTaskClass,
                    confidence: bgConfidence,
                    reviewProvider: bgReviewAssignment.provider,
                    prompt,
                  });
                  this.recordExecutionTrace({
                    identityKey,
                    assignment: bgReviewAssignment,
                    phase: "consensus-review",
                    source: "consensus-review",
                    task: bgTaskClass,
                    reason: bgReviewAssignment.reason,
                  });
                  this.recordPhaseOutcome({
                    identityKey,
                    assignment: bgReviewAssignment,
                    phase: "consensus-review",
                    source: "consensus-review",
                    status: bgConsensusResult.agreed ? "approved" : "continued",
                    task: bgTaskClass,
                    reason: bgConsensusResult.reasoning?.trim() || (bgConsensusResult.agreed
                      ? "Consensus review agreed with the current path."
                      : "Consensus review found a disagreement and kept execution open."),
                  });

                  if (!bgConsensusResult.agreed) {
                    logger.warn("Consensus disagreement (background)", {
                      chatId,
                      strategy: bgConsensusResult.strategy,
                      reasoning: bgConsensusResult.reasoning?.slice(0, 200),
                    });
                  }
                }
              }
            }
          } catch {
            // Consensus failure is non-fatal
          }
        }
        // ────────────────────────────────────────────────────────────────────

        // ─── PAOR: Record step results ──────────────────────────────────
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]!;
          const tr = toolResults[i]!;
          const stepResult: StepResult = {
            toolName: tc.name,
            success: !(tr.isError ?? false),
            summary: tr.content.slice(0, 200),
            timestamp: Date.now(),
          };
          bgAgentState = {
            ...bgAgentState,
            stepResults: [...bgAgentState.stepResults, stepResult],
            iteration: bgAgentState.iteration + 1,
            consecutiveErrors: tr.isError ? bgAgentState.consecutiveErrors + 1 : 0,
          };
        }

        const hasErrors = toolResults.some(tr => tr.isError);
        const failedSteps = bgAgentState.stepResults.filter(s => !s.success);
        const shouldReflect =
          hasErrors ||
          (bgAgentState.stepResults.length > 0 && bgAgentState.stepResults.length % BG_REFLECT_INTERVAL === 0) ||
          shouldForceReplan(failedSteps);

        if (shouldReflect && bgAgentState.phase === AgentPhase.EXECUTING) {
          bgAgentState = transitionPhase(bgAgentState, AgentPhase.REFLECTING);
          onProgress("Reflecting on progress...");
        }
        // ────────────────────────────────────────────────────────────────

        // Add tool results
        const stateCtx = taskPlanner.getStateInjection();
        const contentBlocks: Array<
          | { type: "text"; text: string }
          | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
        > = [];
        if (stateCtx) {
          contentBlocks.push({ type: "text" as const, text: stateCtx });
        }
        if (bgAgentState.phase === AgentPhase.REFLECTING) {
          contentBlocks.push({ type: "text" as const, text: buildReflectionPrompt(bgAgentState) });
        }
        for (const tr of toolResults) {
          contentBlocks.push({
            type: "tool_result" as const,
            tool_use_id: tr.toolCallId,
            content: tr.content,
            is_error: tr.isError,
          });
        }
        session.messages.push({
          role: "user",
          content: contentBlocks.length === 1 && stateCtx ? stateCtx : contentBlocks,
        });

        // ─── Memory Re-retrieval (background path) ───────────────────────
        if (bgMemoryRefresher) {
          try {
            const check = await bgMemoryRefresher.shouldRefresh(bgIteration, prompt, chatId);
            if (check.should) {
              const refreshed = await bgMemoryRefresher.refresh(prompt, chatId, check.reason, bgIteration, check.cosineDistance);
              if (refreshed.triggered) {
                if (refreshed.newMemoryContext) {
                  systemPrompt = replaceSection(systemPrompt, "re-retrieval:memory", `## Relevant Memory\n${refreshed.newMemoryContext}`);
                }
                if (refreshed.newRagContext) {
                  systemPrompt = replaceSection(systemPrompt, "re-retrieval:rag", refreshed.newRagContext);
                }
                if (refreshed.newInsights?.length) {
                  bgAgentState = { ...bgAgentState, learnedInsights: refreshed.newInsights };
                }
              }
            }
          } catch {
            // Re-retrieval failure is non-fatal
          }
        }
        // ─────────────────────────────────────────────────────────────────
      }

      // ─── Metrics: record max iterations ──────────────────────────────
      this.recordMetricEnd(metricId, {
        agentPhase: bgAgentState.phase,
        iterations: bgAgentState.iteration,
        toolCallCount: bgToolCallCount,
        hitMaxIterations: true,
      });
      // ────────────────────────────────────────────────────────────────

      return "Task reached maximum iterations. The work done so far has been saved.";
    } catch (error) {
      bgAgentState = transitionPhase(bgAgentState, AgentPhase.FAILED);
      throw error;
    } finally {
      // ─── Metrics: safety net for unexpected exits (endTask is idempotent) ─
      this.recordMetricEnd(metricId, {
        agentPhase: bgAgentState.phase,
        iterations: bgAgentState.iteration,
        toolCallCount: bgToolCallCount,
        hitMaxIterations: false,
      });
      // ────────────────────────────────────────────────────────────────
    }
  }

  /**
   * Handle the dependency setup flow when Strada.Core is missing.
   * Prompts the user on first message, processes their response on subsequent messages.
   */
  private async handleDepsSetup(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const text = msg.text?.toLowerCase() ?? "";

    if (this.pendingDepsPrompt.get(chatId)) {
      // User is responding to our install prompt
      if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
        await this.channel.sendText(chatId, "Strada.Core kuruluyor...");
        const result = await installStradaDep(this.projectPath, "core", this.stradaConfig);
        if (result.kind === "ok") {
          this.stradaDeps = checkStradaDeps(this.projectPath, this.stradaConfig);
          this.rebuildBaseSystemPrompt();
          this.depsSetupComplete = true;
          await this.channel.sendText(chatId, "Strada.Core kuruldu! Artık kullanabilirsiniz.");

          if (!this.stradaDeps.modulesInstalled) {
            this.pendingModulesPrompt.set(chatId, true);
            await this.channel.sendText(
              chatId,
              "Strada.Modules da kurulu değil. Kurmamı ister misiniz? (evet/hayır)",
            );
            return;
          }
        } else {
          await this.channel.sendText(chatId, `Kurulum başarısız: ${result.error}`);
          this.depsSetupComplete = true;
        }
      } else {
        this.depsSetupComplete = true;
        await this.channel.sendText(
          chatId,
          "Anlaşıldı. Strada.Core olmadan sınırlı destek sunabilirim.",
        );
      }
      return;
    }

    // First message — send the install prompt
    this.pendingDepsPrompt.set(chatId, true);
    await this.channel.sendText(
      chatId,
      "⚠️ Strada.Core projenizde bulunamadı.\n\n" +
        `Proje: ${this.projectPath}\n` +
        "Arama yapılan konumlar: Packages/strada.core, Packages/com.strada.core, Packages/Strada.Core\n\n" +
        "Git submodule olarak kurmamı ister misiniz? (evet/hayır)",
    );
  }

  /**
   * Handle the optional Strada.Modules installation prompt.
   */
  private async handleModulesPrompt(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const text = msg.text?.toLowerCase() ?? "";
    this.pendingModulesPrompt.delete(chatId);

    if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
      await this.channel.sendText(chatId, "Strada.Modules kuruluyor...");
      const result = await installStradaDep(this.projectPath, "modules", this.stradaConfig);
      if (result.kind === "ok") {
        this.stradaDeps = checkStradaDeps(this.projectPath, this.stradaConfig);
        this.rebuildBaseSystemPrompt();
        await this.channel.sendText(chatId, "Strada.Modules kuruldu!");
      } else {
        await this.channel.sendText(chatId, `Modules kurulumu başarısız: ${result.error}`);
      }
    } else {
      await this.channel.sendText(chatId, "Anlaşıldı. Strada.Modules olmadan devam ediyoruz.");
    }
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    const logger = getLogger();
    const { chatId, text, userId: msgUserId, conversationId } = msg;
    const userId = msgUserId;
    const conversationScope = resolveConversationScope(chatId, conversationId);

    logger.info("Processing message", {
      chatId,
      userId,
      textLength: text.length,
      channel: msg.channelType,
    });

    // Goal tree resume detection (trigger on first message when interrupted trees exist)
    const pendingResumeTrees = this.takePendingResumeTrees(conversationScope, chatId);
    if (pendingResumeTrees.length > 0) {
      const resumePrompt = formatResumePrompt(pendingResumeTrees);
      await this.channel.sendMarkdown(chatId, resumePrompt);

      const normalized = text.toLowerCase().trim();
      if (normalized === "resume" || normalized === "resume all") {
        for (const tree of pendingResumeTrees) {
          const prepared = prepareTreeForResume(tree);
          this.activeGoalTrees.set(tree.sessionId, prepared);
        }
        await this.channel.sendMarkdown(chatId, "Resuming interrupted goal trees...");
        return;
      } else if (normalized === "discard" || normalized === "discard all") {
        await this.channel.sendMarkdown(chatId, "Interrupted goal trees discarded.");
        return;
      }
    }

    // Check rate limits before processing
    if (this.rateLimiter) {
      const rateCheck = this.rateLimiter.checkMessageRate(userId);
      if (!rateCheck.allowed) {
        logger.warn("Rate limited", { userId, reason: rateCheck.reason });
        const retryMsg = rateCheck.retryAfterMs
          ? ` Please try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`
          : "";
        await this.channel.sendText(chatId, `${rateCheck.reason}${retryMsg}`);
        return;
      }
    }

    this.metrics?.recordMessage();
    this.metrics?.setActiveSessions(this.sessions.size);
    const identityKey = resolveIdentityKey(chatId, userId, conversationId);

    // Get or create session
    const session = this.getOrCreateSession(chatId);
    session.lastActivity = new Date();
    session.conversationScope = conversationScope;
    if (!session.mixedParticipants) {
      if (!session.profileKey) {
        session.profileKey = identityKey;
      } else if (session.profileKey !== identityKey) {
        session.profileKey = undefined;
        session.mixedParticipants = true;
      }
    }

    // Touch user profile (lastSeenAt) — debounced to avoid per-message SQLite writes
    if (this.userProfileStore) {
      const lastTouch = this.lastPersistTime.get(`touch:${identityKey}`) ?? 0;
      if (Date.now() - lastTouch > 60_000) {
        this.userProfileStore.touchLastSeen(identityKey);
        this.lastPersistTime.set(`touch:${identityKey}`, Date.now());
      }
    }

    // Load autonomous mode from profile at session start
    if (this.dmPolicy && this.userProfileStore) {
      try {
        const autonomousState = await this.userProfileStore.isAutonomousMode(identityKey);
        if (autonomousState.enabled) {
          this.dmPolicy.initFromProfile(chatId, {
            autonomousMode: true,
            autonomousExpiresAt: autonomousState.expiresAt,
          }, userId);
        }
      } catch {
        // Autonomous mode restoration failure is non-fatal
      }
    }

    await this.maybeUpdateUserProfileFromPrompt(chatId, identityKey, text, userId);

    // Add user message (with vision blocks if applicable)
    const provider = this.providerManager.getProvider(identityKey);
    const supportsVision = provider.capabilities.vision;
    const userContent = buildUserContent(text, msg.attachments, supportsVision);
    session.messages.push({ role: "user", content: userContent });

    // Trim old messages to manage context window (provider-aware threshold)
    // Persist trimmed messages to memory before discarding
    const providerInfo = this.providerManager.getActiveInfo?.(identityKey);
    const trimmed = this.trimSession(session, getRecommendedMaxMessages(
      providerInfo?.providerName ?? provider.name,
      providerInfo?.model,
      this.modelIntelligence,
      this.providerManager.getProviderCapabilities?.(providerInfo?.providerName ?? provider.name, providerInfo?.model),
      providerInfo?.providerName ?? provider.name,
    ));
    if (trimmed.length > 0) {
      await this.persistSessionToMemory(chatId, trimmed, /* force */ true);
    }

    // Start typing indicator loop
    const typingInterval = setInterval(() => {
      if (supportsRichMessaging(this.channel)) {
        this.channel.sendTypingIndicator(chatId as string).catch((err) =>
          getLogger().error("Failed to send typing indicator", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }, TYPING_INTERVAL_MS);

    try {
      await this.runAgentLoop(chatId, session, msg.channelType, userId, conversationId);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("Agent loop error", { chatId, error: errMsg });
      await this.channel.sendText(chatId, classifyErrorMessage(error));
    } finally {
      clearInterval(typingInterval);
      // Persist conversation summary (forced to ensure no messages are lost)
      await this.persistSessionToMemory(chatId, session.messages.slice(-10), /* force */ true);
      // Periodic summarization: every 10 messages, generate an LLM summary
      if (this.sessionSummarizer && session.messages.length > 0 && session.messages.length % 10 === 0) {
        void this.sessionSummarizer.summarizeAndUpdateProfile(session.profileKey ?? chatId, session.messages)
          .catch(() => { /* periodic summarization failure is non-fatal */ });
      }
    }
  }

  /**
   * The core agent loop: LLM → Tool calls → LLM → ... → Response
   */
  private async runAgentLoop(
    chatId: string,
    session: Session,
    channelType?: string,
    userId?: string,
    conversationId?: string,
  ): Promise<void> {
    const logger = getLogger();
    const conversationScope = resolveConversationScope(chatId, conversationId);
    const identityKey = resolveIdentityKey(chatId, userId, conversationId);
    const fallbackProvider = this.providerManager.getProvider(identityKey);

    // Load user profile once for the entire agent loop
    const profile = this.userProfileStore?.getProfile(identityKey) ?? null;

    // Per-user persona override (from profile, not global SoulLoader mutation)
    let personaContent: string | undefined;
    if (profile?.activePersona && profile.activePersona !== "default" && this.soulLoader) {
      personaContent = await this.soulLoader.getProfileContent(profile.activePersona) ?? undefined;
    }

    // Extract query text from last user message for embedding + context
    const lastUserMsg = [...session.messages].reverse().find((m) => m.role === "user" && m.content);
    const queryText = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join(" ")
          : ""
      : "";

    // Pre-compute embedding once for memory search + RAG search (avoids 2 redundant calls)
    let preComputedEmbedding: number[] | undefined;
    if (queryText && this.embeddingProvider) {
      try {
        const batch = await this.embeddingProvider.embed([queryText]);
        preComputedEmbedding = batch.embeddings[0];
      } catch {
        // Embedding failure is non-fatal; downstream calls will embed on demand
      }
    }

    // Build system prompt with all context layers (DRY: shared with runBackgroundTask)
    logger.debug("Building system prompt", { chatId });
    const { systemPrompt: builtSystemPrompt, initialContentHashes } = await this.buildSystemPromptWithContext({
      chatId,
      conversationScope,
      identityKey,
      userId,
      channelType,
      prompt: queryText,
      personaContent,
      allowFirstTimeOnboarding: true,
      profile,
      preComputedEmbedding,
    });
    let systemPrompt = builtSystemPrompt;

    // ─── Autonomy layer ──────────────────────────────────────────────────
    const errorRecovery = new ErrorRecoveryEngine();
    const taskPlanner = new TaskPlanner();
    const selfVerification = new SelfVerification();
    const stradaConformance = new StradaConformanceGuard(this.stradaDeps);
    const taskStartedAtMs = Date.now();
    // ────────────────────────────────────────────────────────────────────

    // ─── PAOR State Machine ──────────────────────────────────────────────
    const lastUserMessage = this.extractLastUserMessage(session);
    stradaConformance.trackPrompt(lastUserMessage);
    let agentState = createInitialState(lastUserMessage);
    const executionStrategy = this.buildSupervisorExecutionStrategy(lastUserMessage, identityKey, fallbackProvider);
    let toolTurnAffinity: SupervisorAssignment | null = null;

    let matchedInstinctIds: string[] = [];
    if (this.instinctRetriever) {
      try {
        const insightResult = await this.instinctRetriever.getInsightsForTask(lastUserMessage);
        agentState = { ...agentState, learnedInsights: insightResult.insights };
        matchedInstinctIds = insightResult.matchedInstinctIds;
      } catch {
        // Non-fatal
      }
    }
    // Store per-session instinct IDs for appliedInstinctIds attribution
    this.currentSessionInstinctIds.set(chatId, matchedInstinctIds);

    // ─── Memory Re-retrieval: create refresher ───────────────────────
    const memoryRefresher = this.createMemoryRefresher(initialContentHashes);
    // ────────────────────────────────────────────────────────────────

    // ─── Metrics: start recording ────────────────────────────────────
    const metricId = this.metricsRecorder?.startTask({
      sessionId: chatId,
      taskDescription: lastUserMessage.slice(0, 200),
      taskType: "interactive",
      instinctIds: matchedInstinctIds,
    });
    // ────────────────────────────────────────────────────────────────

    const REFLECT_INTERVAL = 3;
    // ────────────────────────────────────────────────────────────────────

    logger.debug("System prompt built", { chatId, promptLength: systemPrompt.length });

    try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // ─── PAOR: Build phase-aware system prompt ──────────────────────
      let activePrompt = systemPrompt;
      switch (agentState.phase) {
        case AgentPhase.PLANNING:
          activePrompt += "\n\n" + buildPlanningPrompt(
            agentState.taskDescription,
            agentState.learnedInsights,
            { enableGoalDetection: !!this.taskManager },
          );
          break;
        case AgentPhase.EXECUTING:
          activePrompt += buildExecutionContext(agentState);
          break;
        case AgentPhase.REPLANNING:
          activePrompt += "\n\n" + buildReplanningPrompt(agentState);
          break;
      }
      // ────────────────────────────────────────────────────────────────

      const currentAssignment = this.getPinnedToolTurnAssignment(
        executionStrategy,
        agentState.phase,
        toolTurnAffinity,
      );
      const currentProvider = currentAssignment.provider;
      activePrompt += this.buildSupervisorRolePrompt(executionStrategy, currentAssignment);
      const canStream =
        this.streamingEnabled &&
        "chatStream" in currentProvider &&
        typeof currentProvider.chatStream === "function" &&
        "startStreamingMessage" in this.channel &&
        typeof this.channel.startStreamingMessage === "function";

      logger.debug("Calling LLM", { chatId, canStream, provider: currentAssignment.providerName, iteration });
      let response;
      if (canStream) {
        // Silent streaming: use streaming internally (SSE parsing, timeout, reasoning_content)
        // but don't create visible messages. User sees only the final response via sendMarkdown.
        response = await this.silentStream(chatId, activePrompt, session, currentProvider);
      } else {
        response = await currentProvider.chat(activePrompt, session.messages, this.toolDefinitions);
      }
      this.recordExecutionTrace({
        identityKey,
        assignment: currentAssignment,
        phase: this.toExecutionPhase(agentState.phase),
        source: this.resolveExecutionTraceSource(currentAssignment),
        task: executionStrategy.task,
      });
      logger.debug("LLM responded", { chatId, hasText: !!response.text, textLen: response.text?.length ?? 0, toolCalls: response.toolCalls.length });

      logger.debug("LLM response", {
        chatId,
        iteration,
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        streamed: canStream,
      });
      if (
        response.toolCalls.length > 0 &&
        !toolTurnAffinity &&
        agentState.phase !== AgentPhase.PLANNING &&
        agentState.phase !== AgentPhase.REPLANNING
      ) {
        toolTurnAffinity = currentAssignment;
      }
      this.recordProviderUsage(currentAssignment.providerName, response.usage, this.onUsage);

      // ─── PAOR: Handle REFLECTING phase response ─────────────────────
      if (agentState.phase === AgentPhase.REFLECTING) {
        const decision = parseReflectionDecision(response.text);

        if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
          const clarificationIntervention = await this.resolveDraftClarificationIntervention({
            chatId,
            identityKey,
            prompt: lastUserMessage,
            draft: response.text ?? "",
            state: agentState,
            strategy: executionStrategy,
            touchedFiles: [...selfVerification.getState().touchedFiles],
            usageHandler: this.onUsage,
          });
          if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
            agentState = {
              ...agentState,
              lastReflection: response.text ?? agentState.lastReflection,
              reflectionCount: agentState.reflectionCount + 1,
              consecutiveErrors: 0,
            };
            agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: clarificationIntervention.gate });
            continue;
          }
          if ((clarificationIntervention.kind === "ask_user" || clarificationIntervention.kind === "blocked") && clarificationIntervention.message) {
            session.messages.push({ role: "assistant", content: clarificationIntervention.message });
            await this.channel.sendMarkdown(chatId, clarificationIntervention.message);
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          const verifierIntervention = await this.resolveVerifierIntervention({
            chatId,
            identityKey,
            prompt: lastUserMessage,
            state: agentState,
            draft: response.text,
            selfVerification,
            stradaConformance,
            strategy: executionStrategy,
            taskStartedAtMs,
            usageHandler: this.onUsage,
          });
          if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
            this.recordPhaseOutcome({
              identityKey,
              assignment: currentAssignment,
              phase: "reflecting",
              status: "continued",
              task: executionStrategy.task,
              reason: verifierIntervention.result.summary,
            });
            agentState = {
              ...agentState,
              lastReflection: response.text ?? agentState.lastReflection,
              reflectionCount: agentState.reflectionCount + 1,
              consecutiveErrors: 0,
            };
            agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: verifierIntervention.gate });
            continue;
          }
          if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
            this.recordPhaseOutcome({
              identityKey,
              assignment: currentAssignment,
              phase: "reflecting",
              status: "replanned",
              task: executionStrategy.task,
              reason: verifierIntervention.result.summary,
            });
            agentState = this.transitionToVerifierReplan(agentState, response.text);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: verifierIntervention.gate });
            continue;
          }

          const finalText = await this.synthesizeUserFacingResponse({
            identityKey,
            prompt: lastUserMessage,
            draft: response.text ?? "",
            agentState,
            strategy: executionStrategy,
            systemPrompt,
            usageHandler: this.onUsage,
          });
          if (finalText) {
            session.messages.push({ role: "assistant", content: finalText });
            await this.channel.sendMarkdown(chatId, finalText);
          }
          this.recordPhaseOutcome({
            identityKey,
            assignment: currentAssignment,
            phase: "reflecting",
            status: "approved",
            task: executionStrategy.task,
            reason: "Reflection accepted completion after the verifier pipeline cleared the task.",
          });
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
          return;
        }

        if (decision === "REPLAN") {
          agentState = {
            ...agentState,
            failedApproaches: [...agentState.failedApproaches, extractApproachSummary(agentState)],
            lastReflection: response.text ?? null,
            reflectionCount: agentState.reflectionCount + 1,
          };

          // ─── Goal Decomposition: reactive decomposition when stuck ──────
          if (this.goalDecomposer && this.activeGoalTrees.has(conversationScope)) {
            try {
              const goalTree = this.activeGoalTrees.get(conversationScope)!;
              // Find the currently-executing node
              let executingNodeId: GoalNodeId | null = null;
              for (const [, node] of goalTree.nodes) {
                if (node.status === "executing") {
                  executingNodeId = node.id;
                  break;
                }
              }
              if (executingNodeId) {
                const executingNode = goalTree.nodes.get(executingNodeId)!;
                this.emitGoalEvent(goalTree.rootId, executingNodeId, "failed", executingNode.depth);
                const updatedTree = await this.goalDecomposer.decomposeReactive(
                  goalTree,
                  executingNodeId,
                  response.text ?? "",
                );
                if (updatedTree) {
                  this.activeGoalTrees.set(conversationScope, updatedTree);
                  const treeViz = renderGoalTree(updatedTree);
                  await this.channel.sendMarkdown(chatId, "Goal tree updated (reactive decomposition):\n```\n" + treeViz + "\n```");
                } else {
                  getLogger().info("Reactive decomposition skipped (depth limit reached)", { chatId, nodeId: executingNodeId });
                }
              }
            } catch (reactiveError) {
              // Reactive decomposition failure is non-fatal
              getLogger().warn("Reactive goal decomposition failed", {
                chatId,
                error: reactiveError instanceof Error ? reactiveError.message : String(reactiveError),
              });
            }
          }
          // ────────────────────────────────────────────────────────────────

          agentState = transitionPhase(agentState, AgentPhase.REPLANNING);
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({ role: "user", content: "Please create a new plan." });
          continue;
        }

        // CONTINUE
        agentState = {
          ...agentState,
          reflectionCount: agentState.reflectionCount + 1,
          consecutiveErrors: 0,
        };
        agentState = transitionPhase(agentState, AgentPhase.EXECUTING);

        if (response.toolCalls.length === 0) {
          if (shouldSurfaceTerminalFailureFromReflection(response)) {
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
              await this.channel.sendMarkdown(chatId, response.text);
            }
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({ role: "user", content: "Please continue." });
          continue;
        }
      }
      // ────────────────────────────────────────────────────────────────

      // ─── Goal Detection: check for goal block in Plan phase response ───
      // Must run BEFORE end_turn early return since goal detection responses
      // may have no tool calls but should short-circuit to background execution.
      if (agentState.phase === AgentPhase.PLANNING && this.taskManager) {
        const goalBlock = parseGoalBlock(response.text ?? "");
        if (goalBlock && goalBlock.isGoal) {
          // Build GoalTree from LLM output using shared factory
          const goalTree = buildGoalTreeFromBlock(
            goalBlock, conversationScope, lastUserMessage, response.text ?? undefined,
          );

          // Send acknowledgment
          const nodeCount = goalTree.nodes.size - 1;
          const ackMsg = `Working on: ${lastUserMessage.slice(0, 80)}` +
            ` (${nodeCount} step${nodeCount !== 1 ? "s" : ""}, ~${goalBlock.estimatedMinutes} min). I'll update you as I go.`;
          await this.channel.sendText(chatId, ackMsg);

          // Submit as background task with pre-decomposed tree
          this.taskManager.submit(chatId, channelType ?? "cli", lastUserMessage, {
            goalTree,
            conversationId: conversationScope,
            userId: identityKey,
          });

          // Record metric end for the interactive session (goal runs separately)
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: 0,
            hitMaxIterations: false,
          });

          // Short-circuit: return immediately, session lock releases
          return;
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // If no tool calls, send the final text response
      // (streaming already sent it, so skip for streamed end_turn)
      if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
        const clarificationIntervention = await this.resolveDraftClarificationIntervention({
          chatId,
          identityKey,
          prompt: lastUserMessage,
          draft: response.text ?? "",
          state: agentState,
          strategy: executionStrategy,
          touchedFiles: [...selfVerification.getState().touchedFiles],
          usageHandler: this.onUsage,
        });
        if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({
            role: "user",
            content: clarificationIntervention.gate,
          });
          continue;
        }
        if ((clarificationIntervention.kind === "ask_user" || clarificationIntervention.kind === "blocked") && clarificationIntervention.message) {
          session.messages.push({
            role: "assistant",
            content: clarificationIntervention.message,
          });
          await this.channel.sendMarkdown(chatId, clarificationIntervention.message);
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
          return;
        }

        // ─── Verification gate: catch unverified exits ──────────────────
        const verifierIntervention = await this.resolveVerifierIntervention({
          chatId,
          identityKey,
          prompt: lastUserMessage,
          state: agentState,
          draft: response.text,
          selfVerification,
          stradaConformance,
          strategy: executionStrategy,
          taskStartedAtMs,
          usageHandler: this.onUsage,
        });
        if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
          this.recordPhaseOutcome({
            identityKey,
            assignment: currentAssignment,
            phase: this.toExecutionPhase(agentState.phase),
            status: "continued",
            task: executionStrategy.task,
            reason: verifierIntervention.result.summary,
          });
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({
            role: "user",
            content: verifierIntervention.gate,
          });
          logger.debug("Verification gate triggered", { chatId, iteration });
          continue; // send back to LLM with verification reminder
        }
        if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
          this.recordPhaseOutcome({
            identityKey,
            assignment: currentAssignment,
            phase: this.toExecutionPhase(agentState.phase),
            status: "replanned",
            task: executionStrategy.task,
            reason: verifierIntervention.result.summary,
          });
          agentState = this.transitionToVerifierReplan(agentState, response.text);
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({
            role: "user",
            content: verifierIntervention.gate,
          });
          logger.debug("Verifier pipeline triggered replan", { chatId, iteration });
          continue;
        }
        // ────────────────────────────────────────────────────────────────

        // ─── Consensus for text-only responses on critical tasks ──────
        if (this.consensusManager && this.confidenceEstimator && response.text) {
          try {
            const textTaskClass = this.taskClassifier.classify(lastUserMessage);
            if (textTaskClass.criticality === "critical") {
              const textConfidence = this.confidenceEstimator.estimate({
                task: textTaskClass,
                providerName: currentAssignment.providerName,
                providerCapabilities: currentProvider.capabilities,
                agentState,
                responseLength: response.text.length,
              });
              const textAvailableCount = this.providerManager.listAvailable().length;
              const textStrategy = this.consensusManager.shouldConsult(textConfidence, textTaskClass, textAvailableCount);
              if (textStrategy !== "skip" && textAvailableCount >= 2) {
                const textReviewAssignment = this.resolveConsensusReviewAssignment(
                  executionStrategy.reviewer,
                  currentAssignment,
                  identityKey,
                );
                if (textReviewAssignment) {
                  if (textReviewAssignment.provider) {
                    const textConsensus = await this.consensusManager.verify({
                      originalOutput: { text: response.text },
                      originalProvider: currentAssignment.providerName,
                      task: textTaskClass,
                      confidence: textConfidence,
                      reviewProvider: textReviewAssignment.provider,
                      prompt: lastUserMessage,
                    });
                    this.recordExecutionTrace({
                      identityKey,
                      assignment: textReviewAssignment,
                      phase: "consensus-review",
                      source: "consensus-review",
                      task: textTaskClass,
                      reason: textReviewAssignment.reason,
                    });
                    this.recordPhaseOutcome({
                      identityKey,
                      assignment: textReviewAssignment,
                      phase: "consensus-review",
                      source: "consensus-review",
                      status: textConsensus.agreed ? "approved" : "continued",
                      task: textTaskClass,
                      reason: textConsensus.reasoning?.trim() || (textConsensus.agreed
                        ? "Consensus review agreed with the current path."
                        : "Consensus review found a disagreement and kept execution open."),
                    });
                    if (!textConsensus.agreed) {
                      logger.warn("Consensus disagreement (text-only, critical)", {
                        chatId,
                        strategy: textConsensus.strategy,
                        reasoning: textConsensus.reasoning?.slice(0, 200),
                      });
                    }
                  }
                }
              }
            }
          } catch {
            // Consensus failure is non-fatal
          }
        }
        // ────────────────────────────────────────────────────────────────

        if (response.text) {
          const finalText = await this.synthesizeUserFacingResponse({
            identityKey,
            prompt: lastUserMessage,
            draft: response.text,
            agentState,
            strategy: executionStrategy,
            systemPrompt,
            usageHandler: this.onUsage,
          });
          if (finalText) {
            session.messages.push({
              role: "assistant",
              content: finalText,
            });
            await this.channel.sendMarkdown(chatId, finalText);
          }
          this.recordPhaseOutcome({
            identityKey,
            assignment: currentAssignment,
            phase: this.toExecutionPhase(agentState.phase),
            status: "approved",
            task: executionStrategy.task,
            reason: "Execution produced a final response after the verifier pipeline cleared the task.",
          });
        } else {
          // LLM returned empty response — send fallback to user
          const lang = profile?.language ?? this.defaultLanguage;
          const fallback = lang === "tr" ? "Bir yanıt oluşturamadım. Sorunuzu yeniden ifade edebilir misiniz?"
            : lang === "ja" ? "応答を生成できませんでした。質問を言い換えていただけますか？"
            : lang === "ko" ? "응답을 생성할 수 없었습니다. 질문을 다시 표현해 주시겠어요?"
            : lang === "zh" ? "我无法生成回复。您能重新表述您的问题吗？"
            : lang === "de" ? "Ich konnte keine Antwort generieren. Könnten Sie Ihre Frage umformulieren?"
            : lang === "es" ? "No pude generar una respuesta. ¿Podría reformular su pregunta?"
            : lang === "fr" ? "Je n'ai pas pu générer de réponse. Pourriez-vous reformuler votre question ?"
            : "I wasn't able to generate a response. Could you rephrase your question?";
          logger.warn("LLM returned empty response", { chatId, canStream, provider: currentAssignment.providerName });
          await this.channel.sendMarkdown(chatId, fallback);
        }
        // ─── Metrics: record end_turn ───────────────────────────────
        this.recordMetricEnd(metricId, {
          agentPhase: AgentPhase.COMPLETE,
          iterations: agentState.iteration,
          toolCallCount: agentState.stepResults.length,
          hitMaxIterations: false,
        });
        // ──────────────────────────────────────────────────────────
        return;
      }

      // ─── PAOR: Phase transitions ────────────────────────────────────
      if (agentState.phase === AgentPhase.PLANNING) {
        agentState = { ...agentState, plan: response.text ?? null };

        // ─── Goal Decomposition: proactive decomposition for complex tasks ───
        if (this.goalDecomposer && this.goalDecomposer.shouldDecompose(lastUserMessage)) {
          try {
            const goalTree = await this.goalDecomposer.decomposeProactive(conversationScope, lastUserMessage);
            this.activeGoalTrees.set(conversationScope, goalTree);
            this.emitGoalEvent(goalTree.rootId, goalTree.rootId, "pending", 0);
            const treeViz = renderGoalTree(goalTree);
            await this.channel.sendMarkdown(chatId, "Goal decomposition:\n```\n" + treeViz + "\n```");
            // Augment plan with decomposition summary
            const treeSummary = summarizeTree(goalTree);
            agentState = { ...agentState, plan: (agentState.plan ?? "") + "\n\n[Goal Tree: " + treeSummary + "]" };
          } catch (decompError) {
            // Decomposition failure is non-fatal -- continue without decomposition
            getLogger().warn("Proactive goal decomposition failed", {
              chatId,
              error: decompError instanceof Error ? decompError.message : String(decompError),
            });
          }
        }
        // ────────────────────────────────────────────────────────────────────

        agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
      }
      if (agentState.phase === AgentPhase.REPLANNING) {
        agentState = { ...agentState, plan: response.text ?? null };
        agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
      }
      // ────────────────────────────────────────────────────────────────

      // Handle tool calls
      // First, add the assistant message with tool calls
      session.messages.push({
        role: "assistant",
        content: response.text,
        tool_calls: response.toolCalls,
      });

      // Intermediate text is stored in session for LLM context but NOT sent to user.
      // User only sees the final response (end_turn without tool calls).

      // Execute all tool calls
      const toolResults = await this.executeToolCalls(chatId, response.toolCalls, {
        mode: "interactive",
        userId,
        taskPrompt: lastUserMessage,
        sessionMessages: session.messages,
        onUsage: this.onUsage,
        identityKey,
        strategy: executionStrategy,
        agentState,
        touchedFiles: [...selfVerification.getState().touchedFiles],
      });

      // ─── Autonomy: track + analyze results ─────────────────────────────
      for (let i = 0; i < response.toolCalls.length; i++) {
        const tc = response.toolCalls[i]!;
        const tr = toolResults[i]!;

        // O(1) tracking in planner & verifier
        taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
        selfVerification.track(tc.name, tc.input, tr);
        stradaConformance.trackToolCall(tc.name, tc.input, tr.isError ?? false, tr.content);

        // Error recovery: analyze and enrich the tool result
        const analysis = errorRecovery.analyze(tc.name, tr);
        if (analysis) {
          taskPlanner.recordError(analysis.summary);
          // Re-sanitize after appending (prevents API key leakage + enforces length cap)
          // Create new result with sanitized content (ToolResult is immutable)
          toolResults[i] = {
            toolCallId: tr.toolCallId,
            content: sanitizeToolResult(tr.content + analysis.recoveryInjection),
            isError: tr.isError,
          };
        }

        this.emitToolResult(chatId, tc, toolResults[i]!);
      }

      // Inject state-aware context (stall detection, budget warnings)
      const stateCtx = taskPlanner.getStateInjection();
      // ────────────────────────────────────────────────────────────────────

      // ─── Consensus: verify output with second provider if confidence is low ───
      if (this.consensusManager && this.confidenceEstimator && this.providerRouter) {
        try {
          const taskClass = this.taskClassifier.classify(lastUserMessage);
          const confidence = this.confidenceEstimator.estimate({
            task: taskClass,
            providerName: currentAssignment.providerName,
            providerCapabilities: currentProvider.capabilities,
            agentState,
            responseLength: (response.text ?? "").length,
          });

          const availableCount = this.providerManager.listAvailable().length;
          const strategy = this.consensusManager.shouldConsult(confidence, taskClass, availableCount);

          if (strategy !== "skip" && availableCount >= 2) {
            const reviewAssignment = this.resolveConsensusReviewAssignment(
              executionStrategy.reviewer,
              currentAssignment,
              identityKey,
            );
            if (reviewAssignment) {
              if (reviewAssignment.provider) {
                const consensusResult = await this.consensusManager.verify({
                  originalOutput: {
                    text: response.text ?? undefined,
                    toolCalls: response.toolCalls.map((tc: ToolCall) => ({
                      name: tc.name,
                      input: tc.input,
                    })),
                  },
                  originalProvider: currentAssignment.providerName,
                  task: taskClass,
                  confidence,
                  reviewProvider: reviewAssignment.provider,
                  prompt: lastUserMessage,
                });
                this.recordExecutionTrace({
                  identityKey,
                  assignment: reviewAssignment,
                  phase: "consensus-review",
                  source: "consensus-review",
                  task: taskClass,
                  reason: reviewAssignment.reason,
                });
                this.recordPhaseOutcome({
                  identityKey,
                  assignment: reviewAssignment,
                  phase: "consensus-review",
                  source: "consensus-review",
                  status: consensusResult.agreed ? "approved" : "continued",
                  task: taskClass,
                  reason: consensusResult.reasoning?.trim() || (consensusResult.agreed
                    ? "Consensus review agreed with the current path."
                    : "Consensus review found a disagreement and kept execution open."),
                });

                if (!consensusResult.agreed) {
                  logger.warn("Consensus disagreement", {
                    chatId,
                    strategy: consensusResult.strategy,
                    reasoning: consensusResult.reasoning?.slice(0, 200),
                  });
                }
              }
            }
          }
        } catch {
          // Consensus failure is non-fatal
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // ─── PAOR: Record step results ──────────────────────────────────
      for (let i = 0; i < response.toolCalls.length; i++) {
        const tc = response.toolCalls[i]!;
        const tr = toolResults[i]!;
        const stepResult: StepResult = {
          toolName: tc.name,
          success: !(tr.isError ?? false),
          summary: tr.content.slice(0, 200),
          timestamp: Date.now(),
        };
        agentState = {
          ...agentState,
          stepResults: [...agentState.stepResults, stepResult],
          iteration: agentState.iteration + 1,
          consecutiveErrors: tr.isError ? agentState.consecutiveErrors + 1 : 0,
        };
      }

      const hasErrors = toolResults.some(tr => tr.isError);
      const failedSteps = agentState.stepResults.filter(s => !s.success);
      const shouldReflect =
        hasErrors ||
        (agentState.stepResults.length > 0 && agentState.stepResults.length % REFLECT_INTERVAL === 0) ||
        shouldForceReplan(failedSteps);

      if (shouldReflect && agentState.phase === AgentPhase.EXECUTING) {
        agentState = transitionPhase(agentState, AgentPhase.REFLECTING);
      }
      // ────────────────────────────────────────────────────────────────

      // Add tool results as a user message
      // Build content blocks for tool results
      const contentBlocks: Array<
        | { type: "text"; text: string }
        | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
      > = [];
      if (stateCtx) {
        contentBlocks.push({ type: "text" as const, text: stateCtx });
      }
      if (agentState.phase === AgentPhase.REFLECTING) {
        contentBlocks.push({ type: "text" as const, text: buildReflectionPrompt(agentState) });
      }
      for (const tr of toolResults) {
        contentBlocks.push({
          type: "tool_result" as const,
          tool_use_id: tr.toolCallId,
          content: tr.content,
          is_error: tr.isError,
        });
      }
      session.messages.push({
        role: "user",
        content: contentBlocks.length === 1 && stateCtx ? stateCtx : contentBlocks,
      });

      // ─── Memory Re-retrieval ─────────────────────────────────────────
      if (memoryRefresher) {
        try {
          const recentContext = this.extractLastUserMessage(session);
          const check = await memoryRefresher.shouldRefresh(iteration, recentContext, chatId);
          if (check.should) {
            const refreshed = await memoryRefresher.refresh(recentContext, chatId, check.reason, iteration, check.cosineDistance);
            if (refreshed.triggered) {
              if (refreshed.newMemoryContext) {
                systemPrompt = replaceSection(systemPrompt, "re-retrieval:memory", `## Relevant Memory\n${refreshed.newMemoryContext}`);
              }
              if (refreshed.newRagContext) {
                systemPrompt = replaceSection(systemPrompt, "re-retrieval:rag", refreshed.newRagContext);
              }
              if (refreshed.newInsights?.length) {
                agentState = { ...agentState, learnedInsights: refreshed.newInsights };
              }
              if (refreshed.newInstinctIds?.length) {
                // Deduplicate and cap instinct IDs to prevent unbounded growth
                const idSet = new Set(matchedInstinctIds);
                for (const id of refreshed.newInstinctIds) idSet.add(id);
                matchedInstinctIds = [...idSet].slice(0, 200);
                this.currentSessionInstinctIds.set(chatId, matchedInstinctIds);
              }
            }
          }
        } catch {
          // Re-retrieval failure is non-fatal
        }
      }
      // ─────────────────────────────────────────────────────────────────
    }

    // Hit max iterations
    // ─── Metrics: record max iterations ──────────────────────────────
    this.recordMetricEnd(metricId, {
      agentPhase: agentState.phase,
      iterations: agentState.iteration,
      toolCallCount: agentState.stepResults.length,
      hitMaxIterations: true,
    });
    // ────────────────────────────────────────────────────────────────

    await this.channel.sendText(
      chatId,
      "I've reached the maximum number of steps for this request. " +
        "Please send a follow-up message to continue.",
    );
    } catch (error) {
      agentState = transitionPhase(agentState, AgentPhase.FAILED);
      throw error;
    } finally {
      // ─── Metrics: safety net for unexpected exits (endTask is idempotent) ─
      this.recordMetricEnd(metricId, {
        agentPhase: agentState.phase,
        iterations: agentState.iteration,
        toolCallCount: agentState.stepResults.length,
        hitMaxIterations: false,
      });
      // ────────────────────────────────────────────────────────────────
      // Clean up per-session instinct IDs and goal trees to prevent memory leak
      this.currentSessionInstinctIds.delete(chatId);
      // Note: activeGoalTrees intentionally NOT cleaned up here -- trees persist across messages
      // in a session for reactive decomposition. Cleaned up in cleanupSessions and eviction.
    }
  }

  /** Record a metric end event (idempotent — endTask is a no-op for already-completed or unknown IDs) */
  private recordMetricEnd(
    metricId: string | undefined,
    result: { agentPhase: AgentPhase; iterations: number; toolCallCount: number; hitMaxIterations: boolean },
  ): void {
    if (metricId) {
      this.metricsRecorder?.endTask(metricId, result);
    }
  }

  /**
   * Silent streaming: uses the provider's streaming API internally (SSE parsing,
   * timeout, reasoning_content) but does NOT create visible messages for the user.
   * Returns the full ProviderResponse. Used by runAgentLoop to avoid showing
   * intermediate iterations while keeping streaming reliability.
   */
  private readonly silentStream = async (
    chatId: string,
    systemPrompt: string,
    session: Session,
    provider: IAIProvider,
  ): Promise<ProviderResponse> => {
    const timeoutGuard = createStreamingProgressTimeout(
      this.streamInitialTimeoutMs,
      this.streamStallTimeoutMs,
    );
    try {
      const streamPromise = (provider as IStreamingProvider).chatStream(
        systemPrompt,
        session.messages,
        this.toolDefinitions,
        () => {
          timeoutGuard.markProgress();
        },
      );
      const response = await Promise.race([
        streamPromise,
        timeoutGuard.timeoutPromise,
      ]);
      timeoutGuard.clear();
      return response;
    } catch (err) {
      timeoutGuard.clear();
      const errMsg = err instanceof Error ? err.message : "Unknown streaming error";
      getLogger().error("Silent stream error", { chatId, error: errMsg });
      try {
        return await provider.chat(systemPrompt, session.messages, this.toolDefinitions);
      } catch (fallbackErr) {
        getLogger().error("Silent stream fallback chat failed", {
          chatId,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  };

  /**
   * Stream a response from the LLM to the channel in real-time.
   * Sends text chunks as they arrive, then returns the final ProviderResponse.
   * Reserved for runBackgroundTask visible streaming.
   */
  // @ts-expect-error Reserved for background task streaming
  private async streamResponse(
    chatId: string,
    systemPrompt: string,
    session: Session,
    provider: IAIProvider,
  ): Promise<ProviderResponse> {
    const channel = this.channel;
    let streamId: string | undefined;
    let accumulated = "";
    let lastUpdate = 0;

    const onChunk = (chunk: string) => {
      accumulated += chunk;

      // Throttle updates to avoid flooding the channel
      const now = Date.now();
      if (now - lastUpdate >= STREAM_THROTTLE_MS && streamId) {
        lastUpdate = now;
        (
          channel as {
            updateStreamingMessage?: (
              chatId: string,
              streamId: string,
              text: string,
            ) => Promise<void>;
          }
        )
          .updateStreamingMessage?.(chatId, streamId, accumulated)
          ?.catch((err) =>
            getLogger().error("Failed to update streaming message", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      }
    };

    // Start the streaming message placeholder
    streamId =
      (await (
        channel as { startStreamingMessage?: (chatId: string) => Promise<string | undefined> }
      ).startStreamingMessage?.(chatId)) ?? undefined;

    let response: ProviderResponse;
    const timeoutGuard = createStreamingProgressTimeout(
      this.streamInitialTimeoutMs,
      this.streamStallTimeoutMs,
    );
    try {

      const streamPromise = (provider as IStreamingProvider).chatStream(
        systemPrompt,
        session.messages,
        this.toolDefinitions,
        (chunk) => {
          timeoutGuard.markProgress();
          onChunk(chunk);
        },
      );

      // Race against abort signal
      response = await Promise.race([
        streamPromise,
        timeoutGuard.timeoutPromise,
      ]);

      timeoutGuard.clear();
    } catch (streamError) {
      timeoutGuard.clear();
      const errMsg = streamError instanceof Error ? streamError.message : "Unknown streaming error";
      getLogger().error("Streaming error", { chatId, error: errMsg });
      accumulated = `[Streaming error: ${errMsg}]`;

      // Finalize with error message and return a synthetic response
      if (streamId) {
        await (
          channel as {
            finalizeStreamingMessage?: (
              chatId: string,
              streamId: string,
              text: string,
            ) => Promise<void>;
          }
        ).finalizeStreamingMessage?.(chatId, streamId, accumulated);
      }

      return {
        text: accumulated,
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }

    // Finalize the streamed message
    if (streamId) {
      await (
        channel as {
          finalizeStreamingMessage?: (
            chatId: string,
            streamId: string,
            text: string,
          ) => Promise<void>;
        }
      ).finalizeStreamingMessage?.(chatId, streamId, accumulated);
    }

    return response;
  }

  /**
   * Execute tool calls, handling confirmations for write operations.
   */
  private isSelfManagedInteractiveMode(chatId: string, mode: ToolExecutionMode, userId?: string): boolean {
    return mode === "background" || this.dmPolicy.isAutonomousActive(chatId, userId);
  }

  private normalizeInteractiveText(value: unknown): string {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  private pickAutonomousChoice(options: string[], recommended?: string): string {
    const normalizedRecommended = recommended?.trim().toLowerCase();
    if (normalizedRecommended) {
      const recommendedMatch = options.find((option) => option.toLowerCase() === normalizedRecommended);
      if (recommendedMatch) {
        return recommendedMatch;
      }
    }

    const preferred = options.find((option) => AUTO_APPROVE_OPTION_PATTERN.test(option));
    if (preferred) {
      return preferred;
    }

    const fallback = options.find((option) => !AUTO_REJECT_OPTION_PATTERN.test(option));
    return fallback ?? options[0] ?? "Continue";
  }

  private reviewAutonomousPlan(input: Record<string, unknown>, mode: ToolExecutionMode): ToolExecutionResult {
    const summary = this.normalizeInteractiveText(input["summary"]);
    const reasoning = this.normalizeInteractiveText(input["reasoning"]);
    const steps = Array.isArray(input["steps"])
      ? input["steps"]
        .map((step) => this.normalizeInteractiveText(step))
        .filter((step) => step.length > 0)
      : [];
    const issues: string[] = [];
    const combinedText = [summary, reasoning, ...steps].filter((text) => text.length > 0);
    const duplicatedStepCount = new Set(steps.map((step) => step.toLowerCase())).size;

    if (summary.length < 12) {
      issues.push("summary is too vague");
    }
    if (steps.length === 0) {
      issues.push("steps are missing");
    }
    if (steps.some((step) => step.length < 8)) {
      issues.push("one or more steps are too short to execute");
    }
    if (combinedText.some((text) => PLAN_PLACEHOLDER_PATTERN.test(text))) {
      issues.push("plan contains placeholder language");
    }
    if (combinedText.some((text) => PLAN_WAIT_PATTERN.test(text))) {
      issues.push("plan still waits for user approval");
    }
    if (steps.length > 0 && duplicatedStepCount !== steps.length) {
      issues.push("steps repeat instead of progressing");
    }
    if (steps.length > 0 && !steps.some((step) => PLAN_EXECUTABLE_PATTERN.test(step))) {
      issues.push("steps are not concrete enough");
    }

    if (issues.length > 0) {
      return {
        content:
          `Autonomous plan review rejected (${mode} mode): ${issues.join("; ")}. ` +
          "Revise the plan with concrete, executable, non-interactive steps and continue without waiting for user approval.",
        isError: false,
      };
    }

    return {
      content:
        `Autonomous plan review passed (${mode} mode). The ${steps.length}-step plan is concrete, ` +
        "non-interactive, and executable. Proceed without waiting for user approval.",
      isError: false,
    };
  }

  private reviewAutonomousQuestion(input: Record<string, unknown>, mode: ToolExecutionMode): ToolExecutionResult {
    const question = this.normalizeInteractiveText(input["question"]);
    const context = this.normalizeInteractiveText(input["context"]);
    const options = Array.isArray(input["options"])
      ? input["options"]
        .map((option) => this.normalizeInteractiveText(option))
        .filter((option) => option.length > 0)
      : [];
    const recommended = this.normalizeInteractiveText(input["recommended"]);
    const combinedText = [question, context, ...options].join(" ");
    const looksLikePermissionGate =
      PERMISSION_QUESTION_PATTERN.test(combinedText) ||
      (options.some((option) => AUTO_APPROVE_OPTION_PATTERN.test(option)) &&
        options.some((option) => AUTO_REJECT_OPTION_PATTERN.test(option)));

    if (!question) {
      return {
        content:
          `Autonomous question review rejected (${mode} mode): question is missing. ` +
          "Do not wait for user input. Make the safest reasonable assumption from the task context and continue.",
        isError: false,
      };
    }

    if (options.length > 0) {
      const choice = this.pickAutonomousChoice(options, recommended);
      const rationale = looksLikePermissionGate
        ? "this is a permission/confirmation gate, not a true blocker"
        : "no interactive user is available in this execution mode";
      return {
        content:
          `Autonomous question review (${mode} mode): ${rationale}. ` +
          `Selected "${choice}" and approved continued execution.`,
        isError: false,
      };
    }

    return {
      content:
        `Autonomous question review (${mode} mode): no interactive user is available. ` +
        "Make the safest reasonable assumption, state it briefly, and continue without waiting.",
      isError: false,
    };
  }

  private resolveInteractiveToolCall(
    chatId: string,
    toolCall: ToolCall,
    mode: ToolExecutionMode,
    userId?: string,
  ): ToolResult | null {
    if (!this.isSelfManagedInteractiveMode(chatId, mode, userId)) {
      return null;
    }

    if (toolCall.name === "show_plan") {
      const review = this.reviewAutonomousPlan(toolCall.input, mode);
      return { toolCallId: toolCall.id, content: review.content, isError: review.isError };
    }

    if (toolCall.name === "ask_user") {
      const review = this.reviewAutonomousQuestion(toolCall.input, mode);
      return { toolCallId: toolCall.id, content: review.content, isError: review.isError };
    }

    return null;
  }

  private reviewSelfManagedWriteOperation(
    chatId: string,
    toolName: string,
    input: Record<string, unknown>,
    mode: ToolExecutionMode,
    options: ToolExecutionOptions,
  ): Promise<SelfManagedWriteReview> | SelfManagedWriteReview {
    switch (toolName) {
      case "shell_exec": {
        const command = this.normalizeInteractiveText(input["command"]);
        if (!command) {
          return { approved: false, reason: "shell command is missing" };
        }
        if (isDestructiveOperation(toolName, input)) {
          return { approved: false, reason: "shell command looks destructive" };
        }
        return this.reviewShellCommandWithProvider(chatId, command, mode, options, input);
      }
      case "file_rename": {
        const oldPath = this.normalizeInteractiveText(input["old_path"]);
        const newPath = this.normalizeInteractiveText(input["new_path"]);
        if (!oldPath || !newPath) {
          return { approved: false, reason: "rename operation is missing a source or destination path" };
        }
        return { approved: true };
      }
      case "git_commit": {
        const message = this.normalizeInteractiveText(input["message"]);
        if (message.length < 3) {
          return { approved: false, reason: "git commit message is too short" };
        }
        return { approved: true };
      }
      case "file_write":
      case "file_create":
      case "file_edit":
      case "file_delete":
      case "file_delete_directory": {
        const path = this.normalizeInteractiveText(input["path"]);
        if (!path) {
          return { approved: false, reason: "target path is missing" };
        }
        return { approved: true };
      }
      default:
        return { approved: true };
    }
  }

  private extractConversationText(content: string | MessageContent[]): string {
    if (typeof content === "string") {
      return content;
    }

    return content
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "tool_result":
            return block.content;
          case "tool_use":
            return `${block.name}(${JSON.stringify(block.input)})`;
          default:
            return "";
        }
      })
      .filter((part) => part.length > 0)
      .join(" ");
  }

  private summarizeMessagesForShellReview(messages?: ConversationMessage[]): string {
    if (!messages || messages.length === 0) {
      return "";
    }

    return messages
      .slice(-4)
      .map((message) => {
        const text = this.extractConversationText(message.content).replace(/\s+/g, " ").trim();
        if (!text) {
          return "";
        }
        return `${message.role}: ${text.slice(0, 220)}`;
      })
      .filter((line) => line.length > 0)
      .join("\n");
  }

  private parseShellReviewDecision(text: string): ShellCommandReviewDecision | null {
    const trimmed = text.trim();
    const candidates = [
      trimmed,
      trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(),
    ];
    const braceStart = trimmed.indexOf("{");
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      candidates.push(trimmed.slice(braceStart, braceEnd + 1));
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      try {
        const parsed = JSON.parse(candidate) as ShellCommandReviewDecision;
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  private recordAuxiliaryUsage(
    provider: string,
    usage: ProviderResponse["usage"] | undefined,
    sink?: (usage: TaskUsageEvent) => void,
  ): void {
    if (!usage) {
      return;
    }

    this.metrics?.recordTokenUsage(usage.inputTokens, usage.outputTokens, provider);
    this.rateLimiter?.recordTokenUsage(usage.inputTokens, usage.outputTokens, provider);
    sink?.({
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }

  private async resolveVerifierIntervention(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    state: AgentState;
    draft: string | null | undefined;
    selfVerification: SelfVerification;
    stradaConformance: StradaConformanceGuard;
    strategy: SupervisorExecutionStrategy;
    taskStartedAtMs: number;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<VerifierIntervention> {
    const verificationState = params.selfVerification.getState();
    const logEntries = typeof getLogRingBuffer === "function" ? getLogRingBuffer() : [];
    const buildVerificationGate = params.selfVerification.needsVerification()
      ? params.selfVerification.getPrompt()
      : null;
    const conformanceGate = params.stradaConformance.getPrompt();
    const plan = planVerifierPipeline({
      prompt: params.prompt,
      draft: params.draft ?? "",
      state: params.state,
      task: params.strategy.task,
      verificationState,
      buildVerificationGate,
      conformanceGate,
      logEntries,
      chatId: params.chatId,
      taskStartedAtMs: params.taskStartedAtMs,
    });
    const autonomyDeflectionGate = buildAutonomyDeflectionGate(params.draft ?? "", plan.evidence);
    if (autonomyDeflectionGate) {
      return {
        kind: "continue",
        gate: autonomyDeflectionGate,
        result: {
          decision: "continue",
          gate: autonomyDeflectionGate,
          summary: "The current draft still deflects execution back to the user.",
          checks: plan.checks,
          evidence: plan.evidence,
        },
      };
    }

    if (!plan.reviewRequired) {
      return {
        kind: plan.initialDecision === "replan" ? "replan" : plan.initialDecision === "continue" ? "continue" : "approve",
        gate: plan.gate,
        result: {
          decision: plan.initialDecision,
          gate: plan.gate,
          summary: plan.summary,
          checks: plan.checks,
          evidence: plan.evidence,
        },
      };
    }

    const reviewer = params.strategy.reviewer;
    try {
      const reviewResponse = await reviewer.provider.chat(
        `${this.systemPrompt}\n\n${COMPLETION_REVIEW_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(params.strategy, reviewer)}`,
        [{
          role: "user",
          content: buildVerifierPipelineReviewRequest({
            prompt: params.prompt,
            draft: params.draft ?? "",
            state: params.state,
            plan,
          }),
        }],
        [],
      );
      this.recordExecutionTrace({
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "completion-review",
        source: "completion-review",
        task: params.strategy.task,
      });
      this.recordAuxiliaryUsage(
        reviewer.providerName,
        reviewResponse.usage,
        params.usageHandler,
      );
      const result = finalizeVerifierPipelineReview(
        plan,
        parseCompletionReviewDecision(reviewResponse.text),
      );
      this.recordPhaseOutcome({
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "completion-review",
        source: "completion-review",
        status: this.toPhaseOutcomeStatus(result.decision),
        task: params.strategy.task,
        reason: result.summary,
      });
      return {
        kind: result.decision === "replan" ? "replan" : result.decision === "continue" ? "continue" : "approve",
        gate: result.gate,
        result,
      };
    } catch (error) {
      getLogger().warn("Completion review provider failed", {
        chatId: params.chatId,
        provider: reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordPhaseOutcome({
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "completion-review",
        source: "completion-review",
        status: "failed",
        task: params.strategy.task,
        reason: "Completion review provider failed; falling back to conservative verifier gate.",
      });
    }

    const fallbackResult = finalizeVerifierPipelineReview(plan, null);
    return {
      kind: fallbackResult.decision === "replan" ? "replan" : fallbackResult.decision === "continue" ? "continue" : "approve",
      gate: fallbackResult.gate,
      result: fallbackResult,
    };
  }

  private isSafeShellFallback(command: string): boolean {
    const normalized = command.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.includes("|") || normalized.includes(";") || normalized.includes("||")) {
      return false;
    }
    if (/(^|[^&])&([^&]|$)/.test(normalized)) {
      return false;
    }

    const segments = normalized
      .split(/\s*&&\s*/u)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    return segments.length > 0 && segments.every((segment) => SAFE_SHELL_SEGMENT_PATTERN.test(segment));
  }

  private async reviewShellCommandWithProvider(
    chatId: string,
    command: string,
    mode: ToolExecutionMode,
    options: ToolExecutionOptions,
    input: Record<string, unknown>,
  ): Promise<SelfManagedWriteReview> {
    const identityKey = resolveIdentityKey(chatId, options.userId);
    const provider = this.providerManager.getProvider(identityKey);
    const taskPrompt = this.normalizeInteractiveText(options.taskPrompt);
    const recentContext = this.summarizeMessagesForShellReview(options.sessionMessages);
    const workingDirectory = this.normalizeInteractiveText(input["working_directory"]) || ".";
    const timeoutMs = Number(input["timeout_ms"] ?? 30000);
    const reviewAssignment = this.buildStaticSupervisorAssignment(
      "reviewer",
      provider.name,
      this.resolveProviderModelId(provider.name, identityKey),
      provider,
      "reviewed whether a write-capable shell command should run autonomously",
    );
    const reviewTask = this.taskClassifier.classify(taskPrompt || command);

    try {
      const response = await provider.chat(
        SHELL_REVIEW_SYSTEM_PROMPT,
        [{
          role: "user",
          content:
            `Mode: ${mode}\n` +
            `Task: ${taskPrompt || "(not provided)"}\n` +
            `Working directory: ${workingDirectory}\n` +
            `Timeout ms: ${Number.isFinite(timeoutMs) ? timeoutMs : 30000}\n` +
            `Recent context:\n${recentContext || "(none)"}\n\n` +
            `Command:\n${command}`,
        }],
        [],
      );
      this.recordExecutionTrace({
        identityKey,
        assignment: reviewAssignment,
        phase: "shell-review",
        source: "shell-review",
        task: reviewTask,
      });

      this.recordAuxiliaryUsage(provider.name, response.usage, options.onUsage ?? this.onUsage);
      const decision = this.parseShellReviewDecision(response.text);

      if (decision?.decision === "approve" && decision.taskAligned !== false && decision.bounded !== false) {
        this.recordPhaseOutcome({
          identityKey,
          assignment: reviewAssignment,
          phase: "shell-review",
          source: "shell-review",
          status: "approved",
          task: reviewTask,
          reason: decision.reason || "Shell review approved the autonomous command.",
        });
        return { approved: true, reason: decision.reason };
      }

      if (decision?.decision === "reject" || decision?.taskAligned === false || decision?.bounded === false) {
        this.recordPhaseOutcome({
          identityKey,
          assignment: reviewAssignment,
          phase: "shell-review",
          source: "shell-review",
          status: "blocked",
          task: reviewTask,
          reason: decision.reason || "Shell review rejected the autonomous command.",
        });
        return { approved: false, reason: decision.reason || "shell review rejected the command" };
      }
    } catch {
      this.recordPhaseOutcome({
        identityKey,
        assignment: reviewAssignment,
        phase: "shell-review",
        source: "shell-review",
        status: "failed",
        task: reviewTask,
        reason: "Shell review provider failed; falling back to bounded local heuristics.",
      });
      // Fall back to local bounded-command heuristics below.
    }

    if (this.isSafeShellFallback(command)) {
      return { approved: true, reason: "shell review fallback approved a bounded development command" };
    }

    return { approved: false, reason: "shell review was inconclusive for this command" };
  }

  private buildSelfManagedWriteRejection(
    toolCallId: string,
    toolName: string,
    mode: ToolExecutionMode,
    reason: string,
  ): ToolResult {
    return {
      toolCallId,
      content:
        `Self-managed write review rejected (${mode} mode) for '${toolName}': ${reason}. ` +
        "Choose a safer bounded operation and continue without waiting for user approval.",
      isError: true,
    };
  }

  private async executeToolCalls(
    chatId: string,
    toolCalls: ToolCall[],
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult[]> {
    const logger = getLogger();
    const results: ToolResult[] = [];
    const mode = options.mode ?? "interactive";

    const toolContext: ToolContext & { soulLoader?: SoulLoader | null } = {
      projectPath: this.projectPath,
      workingDirectory: this.projectPath,
      readOnly: this.readOnly,
      userId: options.userId,
      chatId,
      channel: this.channel,
      soulLoader: this.soulLoader,
    };

    for (const tc of toolCalls) {
      let activeToolCall = tc;
      const interactiveResolution = this.resolveInteractiveToolCall(chatId, activeToolCall, mode, options.userId);
      if (interactiveResolution) {
        results.push(interactiveResolution);
        continue;
      }

      if (
        mode === "interactive" &&
        activeToolCall.name === "ask_user" &&
        options.taskPrompt &&
        options.identityKey &&
        options.agentState
      ) {
        const clarificationIntervention = await this.resolveAskUserClarificationIntervention({
          chatId,
          identityKey: options.identityKey,
          toolCall: activeToolCall,
          prompt: options.taskPrompt,
          state: options.agentState,
          strategy: options.strategy,
          touchedFiles: options.touchedFiles,
          usageHandler: options.onUsage,
        });
        if (clarificationIntervention.kind === "continue") {
          results.push({
            toolCallId: activeToolCall.id,
            content: clarificationIntervention.gate ?? "Continue internally without asking the user yet.",
            isError: false,
          });
          continue;
        }
        if (clarificationIntervention.input) {
          activeToolCall = {
            ...activeToolCall,
            input: clarificationIntervention.input as unknown as import("../types/index.js").JsonObject,
          };
        }
      }

      const readOnlyCheck = checkReadOnlyBlock(activeToolCall.name, this.readOnly);
      if (!readOnlyCheck.allowed) {
        results.push(createReadOnlyToolStub(activeToolCall.name, activeToolCall.id));
        continue;
      }

      const tool = this.tools.get(activeToolCall.name);
      if (!tool) {
        results.push({
          toolCallId: activeToolCall.id,
          content: `Error: unknown tool '${activeToolCall.name}'`,
          isError: true,
        });
        continue;
      }

      logger.debug("Executing tool", {
        chatId,
        tool: activeToolCall.name,
        input: activeToolCall.input,
      });

      // Confirmation flow via DMPolicy for write operations
      if (this.requireConfirmation && this.isWriteOperation(activeToolCall.name)) {
        if (this.isSelfManagedInteractiveMode(chatId, mode, options.userId)) {
          const review = await this.reviewSelfManagedWriteOperation(chatId, activeToolCall.name, activeToolCall.input, mode, options);
          if (!review.approved) {
            results.push(
              this.buildSelfManagedWriteRejection(
                activeToolCall.id,
                activeToolCall.name,
                mode,
                review.reason ?? "operation did not pass local safety review",
              ),
            );
            continue;
          }
        } else {
          const destructive = isDestructiveOperation(activeToolCall.name, activeToolCall.input);
          const sessionUserId = options.userId ?? chatId;
          const prefs = this.dmPolicy.getSessionPrefs(sessionUserId, chatId);
          const stubDiff = {
            path: String(activeToolCall.input["path"] ?? ""),
            content: "",
            stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 1, hunks: 1 },
            oldPath: "",
            newPath: String(activeToolCall.input["path"] ?? ""),
            diff: "",
            isNew: false,
            isDeleted: false,
            isRename: false,
          };
          if (this.dmPolicy.isApprovalRequired(prefs, stubDiff, destructive)) {
            const confirmed = await this.requestWriteConfirmation(chatId, options.userId, activeToolCall.name, activeToolCall.input);
            if (!confirmed) {
              results.push({
                toolCallId: activeToolCall.id,
                content: "Operation cancelled by user.",
                isError: false,
              });
              continue;
            }
          }
        }
      }

      const toolStart = Date.now();
      try {
        const result = await tool.execute(activeToolCall.input, toolContext);
        this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, !result.isError);
        results.push({
          toolCallId: activeToolCall.id,
          content: sanitizeToolResult(result.content),
          isError: result.isError,
        });
      } catch (error) {
        this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, false);
        const errMsg = error instanceof Error ? error.message : "Unknown error";
        logger.error("Tool execution error", {
          chatId,
          tool: activeToolCall.name,
          error: errMsg,
        });
        results.push({
          toolCallId: activeToolCall.id,
          content: "Tool execution failed",
          isError: true,
        });
      }
    }

    return results;
  }

  private isWriteOperation(toolName: string): boolean {
    return WRITE_OPERATIONS.has(toolName);
  }

  private registerTool(tool: ITool): void {
    const readOnlyCheck = checkReadOnlyBlock(tool.name, this.readOnly);
    if (!readOnlyCheck.allowed) {
      return;
    }

    this.tools.set(tool.name, tool);
    const def = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as import("../types/index.js").JsonObject,
    };
    const existingIdx = this.toolDefinitions.findIndex(td => td.name === tool.name);
    if (existingIdx >= 0) {
      this.toolDefinitions[existingIdx] = def;
    } else {
      this.toolDefinitions.push(def);
    }
  }

  private async requestWriteConfirmation(
    chatId: string,
    userId: string | undefined,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    let question: string;
    let details: string;

    switch (toolName) {
      case "file_delete":
        question = `Confirm delete: \`${input["path"]}\`?`;
        details = `Permanently deleting ${input["path"]}`;
        break;
      case "file_rename":
        question = `Confirm rename: \`${input["old_path"]}\` → \`${input["new_path"]}\`?`;
        details = `Moving ${input["old_path"]} to ${input["new_path"]}`;
        break;
      case "file_delete_directory":
        question = `Confirm DELETE directory: \`${input["path"]}\`?`;
        details = `Recursively deleting ${input["path"]} and ALL contents`;
        break;
      case "shell_exec":
        question = `Confirm shell command: \`${String(input["command"]).slice(0, 100)}\`?`;
        details = `Running: ${input["command"]}`;
        break;
      case "git_commit":
        question = `Confirm git commit: "${String(input["message"]).slice(0, 80)}"?`;
        details = `Creating git commit`;
        break;
      case "git_push":
        question = "Confirm git push to remote?";
        details = `Pushing to ${input["remote"] ?? "origin"}`;
        break;
      default: {
        const path = String(input["path"] ?? "unknown");
        question = `Confirm file ${toolName === "file_write" ? "create/overwrite" : "edit"}: \`${path}\`?`;
        details = toolName === "file_edit" ? `Replacing text in ${path}` : `Writing to ${path}`;
      }
    }

    const response = await (
      this.channel as unknown as {
        requestConfirmation: (req: {
          chatId: string;
          userId?: string;
          question: string;
          options: string[];
          details?: string;
        }) => Promise<string>;
      }
    ).requestConfirmation({
      chatId,
      userId,
      question,
      options: ["Yes", "No"],
      details,
    });

    return response === "Yes";
  }

  private extractLastUserMessage(session: Session): string {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = (msg.content as MessageContent[])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text);
        if (textParts.length > 0) return textParts.join(" ");
      }
    }
    return "";
  }

  private getOrCreateSession(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (session) {
      // Move to end for LRU ordering (Map preserves insertion order)
      this.sessions.delete(chatId);
      this.sessions.set(chatId, session);
      return session;
    }

    // Evict oldest session if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value as string;
      const oldestSession = this.sessions.get(oldestKey);
      this.sessions.delete(oldestKey);
      this.sessionLocks.delete(oldestKey);
      this.activeGoalTrees.delete(oldestSession?.conversationScope ?? oldestKey);
    }

    session = { messages: [], lastActivity: new Date(), mixedParticipants: false };
    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * Trim session history to keep context manageable.
   * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
   * Returns the trimmed (removed) messages for persistence.
   */
  private trimSession(session: Session, maxMessages: number): ConversationMessage[] {
    if (session.messages.length <= maxMessages) return [];

    const overflow = session.messages.length - maxMessages;

    // Find a safe trim boundary that does NOT orphan tool_call/tool_result pairs.
    // A safe boundary is a user message with plain string content (not a tool_result array)
    // that is NOT immediately preceded by an assistant message with tool_calls.
    let trimTo = 0;
    for (let i = overflow; i < session.messages.length; i++) {
      const msg = session.messages[i]!;

      // Must be a plain user message (string content, not tool_result array)
      if (msg.role !== "user") continue;
      if (typeof msg.content !== "string") continue;

      // Check the previous message — if it's an assistant with tool_calls,
      // this user message might be a tool_result response (content mismatch
      // but we need to be safe). Only trim if the previous is NOT a tool_call.
      if (i > 0) {
        const prev = session.messages[i - 1]!;
        if (prev.role === "assistant" && (prev as AssistantMessage).tool_calls?.length) {
          continue; // Skip — trimming here would orphan the tool_calls
        }
      }

      trimTo = i;
      break;
    }

    if (trimTo > 0) {
      return session.messages.splice(0, trimTo);
    }

    // Fallback: if no safe boundary found and session exceeds hard cap (2x max),
    // force trim at the oldest complete tool pair boundary to prevent unbounded growth
    const hardCap = maxMessages * 2;
    if (session.messages.length > hardCap) {
      getLogger().warn("Session exceeds hard cap, force-trimming", {
        size: session.messages.length,
        hardCap,
      });
      // Find the first complete pair boundary (user message after a tool_result)
      for (let i = 1; i < overflow; i++) {
        const msg = session.messages[i]!;
        const prev = session.messages[i - 1]!;
        if (msg.role === "user" && prev.role === "user") {
          return session.messages.splice(0, i);
        }
      }
      // Last resort: trim at overflow, accepting potential orphaning
      return session.messages.splice(0, overflow);
    }

    return [];
  }

  getProviderManager(): ProviderManager {
    return this.providerManager;
  }

  /**
   * Clean up expired sessions (call periodically).
   */
  cleanupSessions(maxAgeMs: number = 3600_000): void {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        // Skip sessions with active locks — they are currently being processed
        if (this.sessionLocks.has(chatId)) continue;

        // Session-end summarization (fire-and-forget)
        if (this.sessionSummarizer && session.messages.length >= 2) {
          void this.sessionSummarizer.summarizeAndUpdateProfile(session.profileKey ?? chatId, session.messages)
            .catch(() => {
              // Session summarization failure is non-fatal
            });
        }
        // Persist before cleanup (forced — session is being evicted)
        void this.persistSessionToMemory(chatId, session.messages.slice(-10), /* force */ true);
        this.lastPersistTime.delete(chatId);
        this.sessions.delete(chatId);
        this.activeGoalTrees.delete(session.conversationScope ?? chatId);
      }
    }
  }

  /** Minimum interval between debounced memory persists per chat (5s). */
  private static readonly PERSIST_DEBOUNCE_MS = 5_000;

  /**
   * Persist conversation messages to memory so the agent remembers them next session.
   * Debounced by default — pass `force: true` for trim evictions and session cleanup.
   */
  private async persistSessionToMemory(
    chatId: string,
    messages: ConversationMessage[],
    force = false,
  ): Promise<void> {
    if (!this.memoryManager) return;
    if (messages.length < 2) return;

    if (!force) {
      const now = Date.now();
      const lastTime = this.lastPersistTime.get(chatId) ?? 0;
      if (now - lastTime < Orchestrator.PERSIST_DEBOUNCE_MS) return;
      this.lastPersistTime.set(chatId, now);
    }

    try {
      const summary = messages
        .map((m) => {
          if (typeof m.content === "string") return `[${m.role}] ${m.content}`;
          if (Array.isArray(m.content)) {
            const texts = (m.content as MessageContent[])
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text);
            return texts.length > 0
              ? `[${m.role}] ${texts.join(" ")}`
              : `[${m.role}] [media message]`;
          }
          return `[${m.role}] [complex content]`;
        })
        .join("\n");

      if (summary) {
        // Sanitize before persisting — strip any leaked API keys/secrets
        const sanitized = summary.replace(API_KEY_PATTERN, "[REDACTED]");
        // Extract first user message and last assistant message for structured storage
        const userMsg = messages.find((m) => m.role === "user");
        let assistantMsg: ConversationMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.role === "assistant") { assistantMsg = messages[i]; break; }
        }
        const extractText = (msg: ConversationMessage | undefined): string | undefined => {
          if (!msg) return undefined;
          if (typeof msg.content === "string") return msg.content.slice(0, 500);
          if (Array.isArray(msg.content)) {
            const texts = (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join(" ");
            return texts.slice(0, 500) || undefined;
          }
          return undefined;
        };
        const result = await this.memoryManager.storeConversation(chatId as ChatId, sanitized, {
          userMessage: extractText(userMsg),
          assistantMessage: extractText(assistantMsg),
        });
        if (result && typeof result === "object" && "kind" in result && result.kind === "err") {
          getLogger().warn("Memory storeConversation failed", { chatId, error: String((result as { error: unknown }).error) });
        }
      }
    } catch (error) {
      getLogger().warn("Memory persistence failed", { chatId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Simple heuristic language detection from text content. */
  private detectLanguageFromText(text: string): string | null {
    const lower = text.toLowerCase();
    // Turkish indicators
    if (/[çğıöşüÇĞİÖŞÜ]/.test(text) || /\b(merhaba|selam|nasıl|proje|yardım|bir|ile|için)\b/.test(lower)) return "tr";
    // Japanese
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return "ja";
    // Korean
    if (/[\uAC00-\uD7AF]/.test(text)) return "ko";
    // Chinese (no Japanese/Korean)
    if (/[\u4E00-\u9FFF]/.test(text) && !/[\u3040-\u309F\uAC00-\uD7AF]/.test(text)) return "zh";
    // German
    if (/[äöüßÄÖÜ]/.test(text) || /\b(hallo|projekt|hilfe)\b/.test(lower)) return "de";
    // Spanish
    if (/[ñ¡¿]/.test(text) || /\b(hola|proyecto|ayuda)\b/.test(lower)) return "es";
    // French
    if (/[àâæçéèêëïîôœùûüÿ]/.test(text) || /\b(bonjour|projet|aide)\b/.test(lower)) return "fr";
    return null; // Default: don't override, keep "en"
  }

  private extractNaturalLanguageDirectiveUpdates(
    latestProfile: { displayName?: string; preferences: Record<string, unknown> } | null,
    prompt: string,
  ): NaturalLanguageDirectiveUpdates {
    const updates: NaturalLanguageDirectiveUpdates = {};
    const trimmed = prompt.trim();

    const langFromMsg = this.detectLanguageFromText(prompt);
    if (langFromMsg) {
      updates.language = langFromMsg;
    }

    const isSingleWord = trimmed.split(/\s+/).length <= 2 && /^[\p{L}]{2,20}$/u.test(trimmed);
    const nameMatch = trimmed.match(EXPLICIT_USER_NAME_RE)
      ?? trimmed.match(USER_ADDRESS_NAME_RE)
      ?? trimmed.match(NAME_INTRO_RE)
      ?? (isSingleWord ? [, trimmed] : null);
    const displayName = nameMatch?.[1] ? sanitizeDisplayName(trimDirectiveTail(nameMatch[1])) : "";
    if (displayName && (!latestProfile?.displayName || trimmed.match(EXPLICIT_USER_NAME_RE))) {
      updates.displayName = displayName;
    }

    const preferenceUpdates: Record<string, unknown> = {};

    const assistantNameMatch = trimmed.match(ASSISTANT_NAME_RE);
    const assistantName = assistantNameMatch?.[1]
      ? sanitizeDisplayName(trimDirectiveTail(assistantNameMatch[1])).slice(0, 40)
      : "";
    if (assistantName) {
      preferenceUpdates.assistantName = assistantName;
    }

    const verbosity = detectVerbosityPreference(trimmed);
    if (verbosity) {
      preferenceUpdates.verbosity = verbosity;
    }

    const communicationStyle = detectCommunicationStylePreference(trimmed);
    if (communicationStyle) {
      preferenceUpdates.communicationStyle = communicationStyle;
    }

    const responseFormat = detectResponseFormatPreference(trimmed);
    if (responseFormat.format) {
      preferenceUpdates.responseFormat = responseFormat.format;
    }
    if (responseFormat.instruction) {
      preferenceUpdates.responseFormatInstruction = responseFormat.instruction;
    }

    if (ULTRATHINK_DISABLE_RE.test(trimmed)) {
      preferenceUpdates.ultrathinkMode = false;
    } else if (ULTRATHINK_ENABLE_RE.test(trimmed)) {
      preferenceUpdates.ultrathinkMode = true;
    }

    const fromNowOnMatch = trimmed.match(/(?:bundan\s+sonra|from\s+now\s+on|her\s+zaman|always)\s+(.+)$/iu);
    const directiveTail = fromNowOnMatch?.[1]
      ? sanitizePreferenceText(fromNowOnMatch[1].split(/[.!?]/u, 1)[0] ?? fromNowOnMatch[1], 220)
      : undefined;
    if (!responseFormat.instruction && directiveTail && /\b(cevap|yanıt|reply|respond|format|style|üslup|uslup|ton|tone|json|bullet|madde|tablo|table)\b/iu.test(directiveTail)) {
      preferenceUpdates.responseFormatInstruction = directiveTail;
    }

    if (AUTONOMY_DISABLE_RE.test(trimmed)) {
      updates.autonomousMode = { enabled: false };
    } else if (AUTONOMY_ENABLE_RE.test(trimmed)) {
      updates.autonomousMode = {
        enabled: true,
        expiresAt: Date.now() + NATURAL_LANGUAGE_AUTONOMOUS_HOURS * 3600_000,
      };
    }

    if (Object.keys(preferenceUpdates).length > 0) {
      updates.preferences = {
        ...(latestProfile?.preferences ?? {}),
        ...preferenceUpdates,
      };
    }

    return updates;
  }

  private async maybeUpdateUserProfileFromPrompt(chatId: string, profileKey: string, prompt: string, userId?: string): Promise<void> {
    if (!this.userProfileStore || !prompt.trim()) {
      return;
    }

    const latestProfile = this.userProfileStore.getProfile(profileKey);
    const updates = this.extractNaturalLanguageDirectiveUpdates(latestProfile, prompt);
    const profileUpdates: Record<string, unknown> = {};

    if (updates.language) {
      profileUpdates["language"] = updates.language;
    }
    if (updates.displayName) {
      profileUpdates["displayName"] = updates.displayName;
    }
    if (updates.preferences) {
      profileUpdates["preferences"] = updates.preferences;
    }

    if (Object.keys(profileUpdates).length > 0) {
      this.userProfileStore.upsertProfile(profileKey, profileUpdates);
    }

    if (updates.autonomousMode) {
      await this.userProfileStore.setAutonomousMode(
        profileKey,
        updates.autonomousMode.enabled,
        updates.autonomousMode.expiresAt,
      );
      this.dmPolicy?.initFromProfile(chatId, {
        autonomousMode: updates.autonomousMode.enabled,
        autonomousExpiresAt: updates.autonomousMode.expiresAt,
      }, userId);
    }
  }

  private emitToolResult(chatId: string, tc: { name: string; input: unknown }, tr: { content: string; isError?: boolean }): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit("tool:result", {
      sessionId: chatId,
      toolName: tc.name,
      input: sanitizeEventInput(tc.input as Record<string, unknown>),
      output: tr.content.slice(0, 500),
      success: !(tr.isError ?? false),
      retryCount: 0,
      appliedInstinctIds: this.currentSessionInstinctIds.get(chatId) ?? [],
      timestamp: Date.now(),
    });
  }

  /** Emit a goal lifecycle event on the event bus */
  private emitGoalEvent(rootId: GoalNodeId | string, nodeId: GoalNodeId | string, status: GoalStatus, depth: number): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit("goal:status-changed", {
      rootId: rootId as GoalNodeId,
      nodeId: nodeId as GoalNodeId,
      status,
      depth,
      timestamp: Date.now(),
    });
  }

  /**
   * Create a MemoryRefresher if re-retrieval is enabled, seeded with initial content hashes.
   * Returns null when re-retrieval is disabled.
   */
  private createMemoryRefresher(initialContentHashes: string[]): MemoryRefresher | null {
    if (!this.reRetrievalConfig?.enabled) return null;
    const refresher = new MemoryRefresher(this.reRetrievalConfig, {
      memoryManager: this.memoryManager,
      ragPipeline: this.ragPipeline,
      instinctRetriever: this.instinctRetriever ?? undefined,
      embeddingProvider: this.embeddingProvider,
      eventBus: this.eventEmitter ?? undefined,
    });
    if (initialContentHashes.length > 0) {
      refresher.seedContentHashes(initialContentHashes);
    }
    return refresher;
  }

  private takePendingResumeTrees(conversationScope: string, chatId: string): GoalTree[] {
    const scoped = this.pendingResumeTrees.get(conversationScope);
    if (scoped && scoped.length > 0) {
      this.pendingResumeTrees.delete(conversationScope);
      return scoped;
    }

    if (conversationScope !== chatId) {
      const legacyChatScoped = this.pendingResumeTrees.get(chatId);
      if (legacyChatScoped && legacyChatScoped.length > 0) {
        this.pendingResumeTrees.delete(chatId);
        return legacyChatScoped;
      }
    }

    return [];
  }
}

/**
 * Replace a section delimited by XML markers in a prompt string.
 * Markers: `<!-- {tag}:start -->` and `<!-- {tag}:end -->`.
 * If markers are not found, appends the section.
 */
function replaceSection(prompt: string, tag: string, newContent: string): string {
  const startMarker = `<!-- ${tag}:start -->`;
  const endMarker = `<!-- ${tag}:end -->`;
  // Sanitize newContent: strip any embedded markers to prevent injection
  // of fake section boundaries from adversarial memory/RAG content.
  const sanitized = newContent
    .replace(/<!--\s*[\w:-]+:start\s*-->/g, "")
    .replace(/<!--\s*[\w:-]+:end\s*-->/g, "");
  const startIdx = prompt.indexOf(startMarker);
  const endIdx = prompt.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return prompt + `\n\n${startMarker}\n${sanitized}\n${endMarker}\n`;
  }
  return prompt.substring(0, startIdx) + startMarker + "\n" + sanitized + "\n" + endMarker + prompt.substring(endIdx + endMarker.length);
}

type ReflectionDecision = "CONTINUE" | "REPLAN" | "DONE" | "DONE_WITH_SUGGESTIONS";

const REFLECTION_DECISION_RE = /\*\*\s*(DONE_WITH_SUGGESTIONS|DONE|REPLAN|CONTINUE)\s*\*\*/;
const VALID_DECISIONS = new Set<ReflectionDecision>(["CONTINUE", "REPLAN", "DONE", "DONE_WITH_SUGGESTIONS"]);

function parseReflectionDecision(text: string | null | undefined): ReflectionDecision {
  if (!text) return "CONTINUE";
  const match = text.match(REFLECTION_DECISION_RE);
  if (match) return match[1] as ReflectionDecision;
  // Fallback: check last line for bare keyword
  const lastLine = (text.trim().split("\n").pop() ?? "").toUpperCase() as ReflectionDecision;
  if (VALID_DECISIONS.has(lastLine)) return lastLine;
  return "CONTINUE";
}

function shouldSurfaceTerminalFailureFromReflection(response: ProviderResponse): boolean {
  return (
    response.stopReason === "end_turn" &&
    response.toolCalls.length === 0 &&
    isTerminalFailureReport(response.text)
  );
}

function extractApproachSummary(state: AgentState): string {
  const recentSteps = state.stepResults.slice(-5);
  const tools = recentSteps.map(s => s.toolName + "(" + (s.success ? "OK" : "FAIL") + ")").join(" → ");
  return (state.plan?.slice(0, 100) ?? "Unknown plan") + ": " + tools;
}

/** Sanitize tool input for learning events: cap size, strip API keys */
function sanitizeEventInput(input: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(input);
  if (serialized.length > 2048) {
    return { _truncated: true, _keys: Object.keys(input) };
  }
  const scrubbed = serialized.replace(API_KEY_PATTERN, "[REDACTED]");
  return JSON.parse(scrubbed) as Record<string, unknown>;
}

/**
 * Sanitize tool results before feeding back to LLM.
 * Caps length and strips potential API key patterns.
 */
function sanitizeToolResult(content: string): string {
  let result = content;

  // Strip API key patterns
  result = result.replace(API_KEY_PATTERN, "[REDACTED]");

  // Cap length
  if (result.length > MAX_TOOL_RESULT_LENGTH) {
    result = result.substring(0, MAX_TOOL_RESULT_LENGTH) + "\n... (truncated)";
  }

  return result;
}
