/**
 * Type-safe Configuration for Strada.Brain
 *
 * Provides:
 * - Deep partial types
 * - Config validators
 * - Environment type mapping
 * - Zod schema integration
 */

import { realpathSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import * as dotenv from "dotenv";
import type { SecretPattern } from "../security/secret-sanitizer.js";
import type { Result, ValidationResult, ValidationError } from "../types/index.js";
import { resolveDotenvPath } from "../common/runtime-paths.js";
import { mcpServerEntrySchema } from "./config-schema.js";
import type { DelegationConfig } from "../agents/multi/delegation/delegation-types.js";
import { getPreset } from "./presets.js";
import type { Config } from "./config-types.js";
import { configSchema } from "./config-schema.js";
export * from "./config-types.js";
export { configSchema } from "./config-schema.js";
export type { RawConfig } from "./config-schema.js";

dotenv.config({ path: resolveDotenvPath({ moduleUrl: import.meta.url }) });

// =============================================================================
// CONFIG VALIDATION
// =============================================================================

/** Config validation error */
export interface ConfigValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** Config validation result */
export type ConfigValidationResult = ValidationResult<Config>;

/**
 * Validate raw config values
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));
    return { kind: "invalid", errors };
  }

  // Transform to structured config
  const rawConfig = result.data;
  const config: Config = {
    anthropicApiKey: rawConfig.anthropicApiKey,
    anthropicAuthMode: rawConfig.anthropicAuthMode,
    anthropicAuthToken: rawConfig.anthropicAuthToken,
    openaiApiKey: rawConfig.openaiApiKey,
    openaiAuthMode: rawConfig.openaiAuthMode,
    openaiChatgptAuthFile: rawConfig.openaiChatgptAuthFile,
    openaiSubscriptionAccessToken: rawConfig.openaiSubscriptionAccessToken,
    openaiSubscriptionAccountId: rawConfig.openaiSubscriptionAccountId,
    deepseekApiKey: rawConfig.deepseekApiKey,
    qwenApiKey: rawConfig.qwenApiKey,
    kimiApiKey: rawConfig.kimiApiKey,
    minimaxApiKey: rawConfig.minimaxApiKey,
    groqApiKey: rawConfig.groqApiKey,
    mistralApiKey: rawConfig.mistralApiKey,
    togetherApiKey: rawConfig.togetherApiKey,
    fireworksApiKey: rawConfig.fireworksApiKey,
    geminiApiKey: rawConfig.geminiApiKey,
    opencodeApiKey: rawConfig.opencodeApiKey,
    opencode2ApiKey: rawConfig.opencode2ApiKey,
    opencodeBaseUrl: rawConfig.opencodeBaseUrl,
    opencodeDefaultModel: rawConfig.opencodeDefaultModel,
    openrouterApiKey: rawConfig.openrouterApiKey,
    ollamaBaseUrl: rawConfig.ollamaBaseUrl,
    providerChain: rawConfig.providerChain,

    telegram: {
      botToken: rawConfig.telegramBotToken,
      allowedUserIds: rawConfig.allowedTelegramUserIds ?? [],
    },

    discord: {
      botToken: rawConfig.discordBotToken,
      guildId: rawConfig.discordGuildId,
      allowedUserIds: rawConfig.allowedDiscordUserIds ?? [],
      allowedRoleIds: rawConfig.allowedDiscordRoleIds ?? [],
    },

    slack: {
      botToken: rawConfig.slackBotToken,
      signingSecret: rawConfig.slackSigningSecret,
      appToken: rawConfig.slackAppToken,
      socketMode: rawConfig.slackSocketMode,
      allowedWorkspaces: rawConfig.allowedSlackWorkspaces,
      allowedUserIds: rawConfig.allowedSlackUserIds,
    },

    teams: {
      appId: rawConfig.teamsAppId,
      appPassword: rawConfig.teamsAppPassword,
      // Only surface tenancy fields when explicitly configured so the default
      // (MultiTenant) behaviour is decided downstream and untouched configs stay
      // shaped exactly as before.
      ...(rawConfig.teamsAppType ? { appType: rawConfig.teamsAppType } : {}),
      ...(rawConfig.teamsAppTenantId ? { appTenantId: rawConfig.teamsAppTenantId } : {}),
      allowedUserIds: rawConfig.teamsAllowedUserIds ?? [],
      allowOpenAccess: rawConfig.teamsAllowOpenAccess,
    },

    security: {
      systemAuth: {
        jwtSecret: rawConfig.jwtSecret,
        requireMfa: rawConfig.requireMfa,
      },
      requireEditConfirmation: rawConfig.requireEditConfirmation,
      readOnlyMode: rawConfig.readOnlyMode,
    },

    tasks: {
      concurrencyLimit: rawConfig.taskMaxConcurrent,
      messageBurstWindowMs: rawConfig.taskMessageBurstWindowMs,
      messageBurstMaxMessages: rawConfig.taskMessageBurstMaxMessages,
      interactiveMaxIterations: rawConfig.taskInteractiveMaxIterations,
      interactiveTokenBudget: rawConfig.taskInteractiveTokenBudget,
      backgroundEpochMaxIterations: rawConfig.taskBackgroundEpochMaxIterations,
      backgroundAutoContinue: rawConfig.taskBackgroundAutoContinue,
      interactiveAutoContinue: rawConfig.taskInteractiveAutoContinue,
      backgroundMaxEpochs: rawConfig.taskBackgroundMaxEpochs,
    },

    interaction: {
      mode: rawConfig.interactionMode,
      heartbeatAfterMs: rawConfig.interactionHeartbeatAfterMs,
      heartbeatIntervalMs: rawConfig.interactionHeartbeatIntervalMs,
      escalationPolicy: rawConfig.interactionEscalationPolicy,
    },

    unityProjectPath: rawConfig.unityProjectPath,
    strada: {
      coreRepoUrl: rawConfig.stradaCoreRepoUrl,
      modulesRepoUrl: rawConfig.stradaModulesRepoUrl,
      mcpRepoUrl: rawConfig.stradaMcpRepoUrl,
      mcpPath: rawConfig.stradaMcpPath,
      unityBridgePort: rawConfig.unityBridgePort,
      unityBridgeAutoConnect: rawConfig.unityBridgeAutoConnect,
      unityBridgeTimeout: rawConfig.unityBridgeTimeout,
      unityEditorPath: rawConfig.unityEditorPath,
      scriptExecuteEnabled: rawConfig.scriptExecuteEnabled,
      reflectionInvokeEnabled: rawConfig.reflectionInvokeEnabled,
    },

    dashboard: {
      enabled: rawConfig.dashboardEnabled,
      port: rawConfig.dashboardPort,
    },

    websocketDashboard: {
      enabled: rawConfig.websocketDashboardEnabled,
      port: rawConfig.websocketDashboardPort,
      authToken: rawConfig.websocketDashboardAuthToken,
      allowedOrigins: rawConfig.websocketDashboardAllowedOrigins,
    },

    prometheus: {
      enabled: rawConfig.prometheusEnabled,
      port: rawConfig.prometheusPort,
    },

    modelIntelligence: {
      enabled: rawConfig.modelIntelligenceEnabled,
      refreshHours: rawConfig.modelIntelligenceRefreshHours,
      dbPath: rawConfig.modelIntelligenceDbPath,
      providerSourcesPath: rawConfig.modelIntelligenceProviderSourcesPath,
    },

    memory: {
      enabled: rawConfig.memoryEnabled,
      dbPath: rawConfig.memoryDbPath,
      backend: rawConfig.memoryBackend,
      unified: {
        dimensions: rawConfig.memoryDimensions,
        autoTiering: rawConfig.memoryAutoTiering,
        autoTieringIntervalMs: rawConfig.memoryAutoTieringIntervalMs,
        promotionThreshold: rawConfig.memoryPromotionThreshold,
        demotionTimeoutDays: rawConfig.memoryDemotionTimeoutDays,
        tierLimits: {
          working: rawConfig.memoryTierWorkingMax,
          ephemeral: rawConfig.memoryTierEphemeralMax,
          persistent: rawConfig.memoryTierPersistentMax,
        },
        ephemeralTtlHours: rawConfig.memoryEphemeralTtlHours,
      },
      decay: {
        enabled: rawConfig.memoryDecayEnabled,
        lambdas: {
          working: rawConfig.memoryDecayLambdaWorking,
          ephemeral: rawConfig.memoryDecayLambdaEphemeral,
          persistent: rawConfig.memoryDecayLambdaPersistent,
        },
        exemptDomains: rawConfig.memoryDecayExemptDomains
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean),
        timeoutMs: rawConfig.memoryDecayTimeoutMs,
      },
      consolidation: {
        enabled: rawConfig.memoryConsolidationEnabled,
        idleMinutes: rawConfig.memoryConsolidationIdleMinutes,
        threshold: rawConfig.memoryConsolidationThreshold,
        batchSize: rawConfig.memoryConsolidationBatchSize,
        minClusterSize: rawConfig.memoryConsolidationMinClusterSize,
        maxDepth: rawConfig.memoryConsolidationMaxDepth,
        modelTier: rawConfig.memoryConsolidationModelTier,
      },
    },

    rag: {
      enabled: rawConfig.ragEnabled,
      provider: rawConfig.embeddingProvider,
      model: rawConfig.embeddingModel,
      baseUrl: rawConfig.embeddingBaseUrl,
      dimensions: rawConfig.embeddingDimensions,
      contextMaxTokens: rawConfig.ragContextMaxTokens,
    },

    streamingEnabled: rawConfig.streamingEnabled,
    shellEnabled: rawConfig.shellEnabled,
    llmStreamInitialTimeoutMs: rawConfig.llmStreamInitialTimeoutMs,
    llmStreamStallTimeoutMs: rawConfig.llmStreamStallTimeoutMs,
    llmProviderFirstResponseTimeoutMs: rawConfig.llmProviderFirstResponseTimeoutMs,

    rateLimit: {
      enabled: rawConfig.rateLimitEnabled,
      messagesPerMinute: rawConfig.rateLimitMessagesPerMinute,
      messagesPerHour: rawConfig.rateLimitMessagesPerHour,
      tokensPerDay: rawConfig.rateLimitTokensPerDay,
      dailyBudgetUsd: rawConfig.rateLimitDailyBudgetUsd,
      monthlyBudgetUsd: rawConfig.rateLimitMonthlyBudgetUsd,
    },

    web: {
      port: rawConfig.webChannelPort,
    },

    logLevel: rawConfig.logLevel,
    logFile: rawConfig.logFile,
    pluginDirs: rawConfig.pluginDirs,

    bayesian: {
      enabled: rawConfig.bayesianEnabled,
      deprecatedThreshold: rawConfig.bayesianDeprecatedThreshold,
      activeThreshold: rawConfig.bayesianActiveThreshold,
      evolutionThreshold: rawConfig.bayesianEvolutionThreshold,
      autoEvolveThreshold: rawConfig.bayesianAutoEvolveThreshold,
      maxInitial: rawConfig.bayesianMaxInitial,
      coolingPeriodDays: rawConfig.bayesianCoolingPeriodDays,
      coolingMinObservations: rawConfig.bayesianCoolingMinObservations,
      coolingMaxFailures: rawConfig.bayesianCoolingMaxFailures,
      promotionMinObservations: rawConfig.bayesianPromotionMinObservations,
      verdictCleanSuccess: rawConfig.bayesianVerdictCleanSuccess,
      verdictRetrySuccess: rawConfig.bayesianVerdictRetrySuccess,
      verdictFailure: rawConfig.bayesianVerdictFailure,
    },

    learningPipelineV2: {
      confidenceWeights: rawConfig.stradaConfidenceWeights,
      maxInstincts: rawConfig.stradaMaxInstincts,
      detectionWindowSize: rawConfig.stradaDetectionWindowSize,
      periodicExtractionInterval: rawConfig.stradaPeriodicExtractionInterval,
    },

    goalMaxDepth: rawConfig.goalMaxDepth,
    goalMaxRetries: rawConfig.goalMaxRetries,
    goalMaxFailures: rawConfig.goalMaxFailures,
    goalParallelExecution: rawConfig.goalParallelExecution,
    goalMaxParallel: rawConfig.goalMaxParallel,
    providerMaxConcurrentRequests: rawConfig.providerMaxConcurrentRequests,

    goal: {
      maxFailures: rawConfig.goalMaxFailures,
      escalationTimeoutMinutes: rawConfig.stradaGoalEscalationTimeoutMinutes,
      maxRedecompositions: rawConfig.stradaGoalMaxRedecompositions,
    },

    toolChain: {
      enabled: rawConfig.toolChainEnabled,
      minOccurrences: rawConfig.toolChainMinOccurrences,
      successRateThreshold: rawConfig.toolChainSuccessRateThreshold,
      maxActive: rawConfig.toolChainMaxActive,
      maxAgeDays: rawConfig.toolChainMaxAgeDays,
      llmBudgetPerCycle: rawConfig.toolChainLlmBudgetPerCycle,
      minChainLength: rawConfig.toolChainMinChainLength,
      maxChainLength: rawConfig.toolChainMaxChainLength,
      detectionIntervalMs: rawConfig.toolChainDetectionIntervalMs,
      resilience: {
        rollbackEnabled: rawConfig.chainRollbackEnabled,
        parallelEnabled: rawConfig.chainParallelEnabled,
        maxParallelBranches: rawConfig.chainMaxParallelBranches,
        compensationTimeoutMs: rawConfig.chainCompensationTimeoutMs,
      },
    },

    crossSession: {
      enabled: rawConfig.crossSessionEnabled,
      maxAgeDays: rawConfig.crossSessionMaxAgeDays,
      scopeFilter: rawConfig.crossSessionScopeFilter,
      recencyBoost: rawConfig.crossSessionRecencyBoost,
      scopeBoost: rawConfig.crossSessionScopeBoost,
      promotionThreshold: rawConfig.crossSessionPromotionThreshold,
    },

    agentName: rawConfig.agentName,
    language: rawConfig.language,

    daemon: {
      heartbeat: {
        intervalMs: rawConfig.daemonIntervalMs,
        heartbeatFile: rawConfig.daemonHeartbeatFile,
        idlePause: rawConfig.daemonIdlePause,
      },
      security: {
        approvalTimeoutMin: rawConfig.daemonApprovalTimeoutMin,
        autoApproveTools: rawConfig.daemonAutoApproveTools,
      },
      budget: {
        // The daemon has NO independent budget envelope: unless a dedicated
        // sub-limit is explicitly set, it takes its share of the SYSTEM's
        // daily budget (STRADA_BUDGET_DAILY_USD) — one wallet, accounted by
        // the UnifiedBudgetManager like every other spender.
        dailyBudgetUsd:
          rawConfig.daemonDailyBudget ??
          (rawConfig.stradaBudgetDailyUsd > 0 ? rawConfig.stradaBudgetDailyUsd : undefined),
        warnPct: rawConfig.daemonBudgetWarnPct,
      },
      backoff: {
        baseCooldownMs: rawConfig.daemonBackoffBase,
        maxCooldownMs: rawConfig.daemonBackoffMax,
        failureThreshold: rawConfig.daemonFailureThreshold,
      },
      timezone: rawConfig.daemonTimezone,
      triggers: {
        webhookSecret: rawConfig.webhookSecret,
        webhookRateLimit: rawConfig.webhookRateLimit,
        dedupWindowMs: rawConfig.daemonDedupWindowMs,
        defaultDebounceMs: rawConfig.daemonDefaultDebounceMs,
        checklistMorningHour: rawConfig.checklistMorningHour,
        checklistAfternoonHour: rawConfig.checklistAfternoonHour,
        checklistEveningHour: rawConfig.checklistEveningHour,
      },
      triggerFireRetentionDays: rawConfig.triggerFireRetentionDays,
    },

    reRetrieval: {
      enabled: rawConfig.stradaMemoryReRetrievalEnabled,
      interval: rawConfig.stradaMemoryReRetrievalInterval,
      topicShiftEnabled: rawConfig.stradaMemoryTopicShiftEnabled,
      topicShiftThreshold: rawConfig.stradaMemoryTopicShiftThreshold,
      maxReRetrievals: rawConfig.stradaMemoryMaxReRetrievals,
      timeoutMs: rawConfig.stradaMemoryReRetrievalTimeoutMs,
      memoryLimit: rawConfig.stradaMemoryReRetrievalMemoryLimit,
      ragTopK: rawConfig.stradaMemoryReRetrievalRagTopK,
    },

    notification: {
      minLevel: rawConfig.stradaNotifyMinLevel,
      routing: {
        silent: splitCsv(rawConfig.stradaNotifySilent),
        low: splitCsv(rawConfig.stradaNotifyLow),
        medium: splitCsv(rawConfig.stradaNotifyMedium),
        high: splitCsv(rawConfig.stradaNotifyHigh),
        critical: splitCsv(rawConfig.stradaNotifyCritical),
      },
      groupingWindowMs: 30000,
    },

    quietHours: {
      enabled: rawConfig.stradaQuietStart !== undefined,
      startHour: rawConfig.stradaQuietStart ?? 22,
      endHour: rawConfig.stradaQuietEnd,
      timezone: rawConfig.daemonTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      bufferMax: rawConfig.stradaQuietBufferMax,
    },

    digest: {
      enabled: rawConfig.stradaDigestEnabled,
      schedule: rawConfig.stradaDigestSchedule,
      timezone: rawConfig.daemonTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      dashboardHistoryDepth: rawConfig.stradaDashboardHistoryDepth,
    },

    agent: {
      enabled: rawConfig.multiAgentEnabled,
      defaultBudgetUsd: rawConfig.agentDefaultBudgetUsd,
      maxConcurrent: rawConfig.agentMaxConcurrent,
      idleTimeoutMs: rawConfig.agentIdleTimeoutMs,
      maxMemoryEntries: rawConfig.agentMaxMemoryEntries,
    },

    delegation: {
      enabled: rawConfig.taskDelegationEnabled,
      maxDepth: rawConfig.agentMaxDelegationDepth,
      maxConcurrentPerParent: rawConfig.agentMaxConcurrentDelegations,
      tiers: {
        local: rawConfig.delegationTierLocal,
        cheap: rawConfig.delegationTierCheap,
        standard: rawConfig.delegationTierStandard,
        premium: rawConfig.delegationTierPremium,
      },
      types: rawConfig.delegationTypes
        ? parseDelegationTypes(rawConfig.delegationTypes)
        : ([] as unknown as DelegationConfig["types"]), // DEFAULT_DELEGATION_TYPES applied at runtime
      verbosity: rawConfig.delegationVerbosity,
    },

    deployment: {
      enabled: rawConfig.deployEnabled,
      scriptPath: rawConfig.deployScriptPath,
      testCommand: rawConfig.deployTestCommand,
      targetBranch: rawConfig.deployTargetBranch,
      requireCleanGit: rawConfig.deployRequireCleanGit,
      testTimeoutMs: rawConfig.deployTestTimeoutMs,
      executionTimeoutMs: rawConfig.deployExecutionTimeoutMs,
      cooldownMinutes: rawConfig.deployCooldownMinutes,
      notificationUrgency: rawConfig.deployNotificationUrgency,
      postScriptPath: rawConfig.deployPostScriptPath,
      rollbackScriptPath: rawConfig.deployRollbackScriptPath,
    },

    autonomousDefaultEnabled: rawConfig.autonomousDefaultEnabled,
    autonomousDefaultHours: rawConfig.autonomousDefaultHours,

    conformanceEnabled: rawConfig.conformanceEnabled,
    conformanceFrameworkPathsOnly: rawConfig.conformanceFrameworkPathsOnly,
    loopFingerprintThreshold: rawConfig.loopFingerprintThreshold,
    loopFingerprintWindow: rawConfig.loopFingerprintWindow,
    loopDensityThreshold: rawConfig.loopDensityThreshold,
    loopDensityWindow: rawConfig.loopDensityWindow,
    loopMaxRecoveryEpisodes: rawConfig.loopMaxRecoveryEpisodes,
    loopStaleAnalysisThreshold: rawConfig.loopStaleAnalysisThreshold,
    loopHardCapReplan: rawConfig.loopHardCapReplan,
    loopHardCapBlock: Math.max(rawConfig.loopHardCapBlock, rawConfig.loopHardCapReplan + 1),
    progressAssessmentEnabled: rawConfig.progressAssessmentEnabled,
    daemonFullAutonomy: rawConfig.daemonFullAutonomy,

    routing: {
      preset: rawConfig.routingPreset,
      phaseSwitching: rawConfig.routingPhaseSwitching,
    },

    consensus: {
      mode: rawConfig.consensusMode,
      threshold: rawConfig.consensusThreshold,
      maxProviders: rawConfig.consensusMaxProviders,
    },

    autoUpdate: {
      enabled: rawConfig.autoUpdateEnabled,
      intervalHours: rawConfig.autoUpdateIntervalHours,
      idleTimeoutMin: rawConfig.autoUpdateIdleTimeoutMin,
      channel: rawConfig.autoUpdateChannel,
      notify: rawConfig.autoUpdateNotify,
      autoRestart: rawConfig.autoUpdateAutoRestart,
    },

    supervisor: {
      enabled: rawConfig.stradaSupervisorEnabled,
      complexityThreshold: rawConfig.stradaSupervisorComplexityThreshold,
      maxParallelNodes: rawConfig.stradaSupervisorMaxParallelNodes,
      nodeTimeoutMs: rawConfig.stradaSupervisorNodeTimeoutMs,
      verificationMode: rawConfig.stradaSupervisorVerificationMode,
      verificationBudgetPct: rawConfig.stradaSupervisorVerificationBudgetPct,
      triageProvider: rawConfig.stradaSupervisorTriageProvider,
      maxFailureBudget: rawConfig.stradaSupervisorMaxFailureBudget,
      diversityCap: rawConfig.stradaSupervisorDiversityCap,
    },

    budget: {
      dailyLimitUsd: rawConfig.stradaBudgetDailyUsd,
      monthlyLimitUsd: rawConfig.stradaBudgetMonthlyUsd,
      warnPct: rawConfig.stradaBudgetWarnPct,
    },

    vault: rawConfig.vault,
    mcpServers: rawConfig.mcpServers,
    obsidian: rawConfig.obsidian,
  };

  // Cross-field validation: dashboardPort and websocketDashboardPort must differ when both enabled
  if (
    config.dashboard.enabled &&
    config.websocketDashboard.enabled &&
    config.dashboard.port === config.websocketDashboard.port
  ) {
    return {
      kind: "invalid",
      errors: [{
        path: "websocketDashboardPort",
        message: "dashboardPort and websocketDashboardPort must be different when both are enabled",
        code: "custom",
      }],
    };
  }

  return { kind: "valid", value: config };
}

/** Zod schema for DELEGATION_TYPES env var validation */
const DelegationTypeConfigSchema = z.array(
  z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    tier: z.enum(["local", "cheap", "standard", "premium"]),
    timeoutMs: z.number().int().min(5000).max(300000),
    maxIterations: z.number().int().min(1).max(50),
    systemPrompt: z.string().optional(),
  }),
);

/** Parse and validate DELEGATION_TYPES JSON env var */
function parseDelegationTypes(raw: string): DelegationConfig["types"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DELEGATION_TYPES is not valid JSON: ${raw.substring(0, 100)}`);
  }
  const result = DelegationTypeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`DELEGATION_TYPES validation failed: ${result.error.message}`);
  }
  return result.data as DelegationConfig["types"];
}

/** Known valid notification channel names */
const VALID_CHANNELS = new Set(["chat", "dashboard"]);

/** Split a comma-separated string into a trimmed, non-empty, allowlist-validated array */
function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((ch) => VALID_CHANNELS.has(ch));
}

/**
 * Validate project path exists and is a directory
 */
export function validateProjectPath(projectPath: string): Result<string, string> {
  try {
    const realPath = realpathSync(projectPath);
    const stats = statSync(realPath);

    if (!stats.isDirectory()) {
      return { kind: "err", error: `UNITY_PROJECT_PATH is not a directory: ${projectPath}` };
    }

    return { kind: "ok", value: realPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "err", error: `UNITY_PROJECT_PATH does not exist: ${projectPath} (${message})` };
  }
}

// =============================================================================
// SECRET PATTERNS
// =============================================================================

/** Redaction function type */
export type RedactionFunction = (match: string) => string;

/** Enhanced secret pattern with typed redaction */
export interface TypedSecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly redaction: string | RedactionFunction;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly description: string;
}

/**
 * Secret patterns for sanitization.
 * Loaded from environment variable or uses defaults.
 */
export const secretPatterns: SecretPattern[] = [
  // OpenAI API keys
  {
    name: "openai_api_key",
    pattern: /sk-[a-zA-Z0-9]{48,}/g,
    redaction: "[REDACTED_OPENAI_KEY]",
  },
  {
    name: "openai_project_key",
    pattern: /sk-proj-[a-zA-Z0-9_-]{48,}/g,
    redaction: "[REDACTED_OPENAI_PROJECT_KEY]",
  },
  // GitHub tokens
  {
    name: "github_token",
    pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g,
    redaction: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "github_pat",
    pattern: /github_pat_[a-zA-Z0-9]{22,}_[a-zA-Z0-9]{59,}/g,
    redaction: "[REDACTED_GITHUB_PAT]",
  },
  // Slack tokens
  {
    name: "slack_token",
    pattern: /xox[bpas]-[a-zA-Z0-9-]{10,}/g,
    redaction: "[REDACTED_SLACK_TOKEN]",
  },
  {
    name: "slack_webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g,
    redaction: "[REDACTED_SLACK_WEBHOOK]",
  },
  // Authorization tokens
  {
    name: "bearer_token",
    // [a-zA-Z0_...] only allowed the digit 0 — tokens with digits 1-9 escaped
    // redaction. Use the full 0-9 range (matches DEFAULT_SECRET_PATTERNS).
    pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
    redaction: "Bearer [REDACTED]",
  },
  {
    name: "basic_auth",
    pattern: /Basic\s+[a-zA-Z0-9+/]{20,}={0,2}/gi,
    redaction: "Basic [REDACTED]",
  },
  // Private keys
  {
    name: "private_key",
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    redaction: "[REDACTED_PRIVATE_KEY]",
  },
  // Database credentials
  {
    name: "connection_password",
    pattern: /(?:password|pwd)=([^;\s&]{4,})/gi,
    redaction: "password=[REDACTED]",
  },
  {
    name: "database_url",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^/\s]+/gi,
    redaction: (match: string) => {
      const urlMatch = match.match(/^(\w+:\/\/)[^:]+:[^@]+(@.+)$/);
      if (urlMatch) {
        return `${urlMatch[1]}[REDACTED_CREDENTIALS]${urlMatch[2]}`;
      }
      return "[REDACTED_DATABASE_URL]";
    },
  },
  // JWT tokens
  {
    name: "jwt_token",
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    redaction: "[REDACTED_JWT]",
  },
  // .env values
  {
    name: "env_value",
    pattern: /^([A-Z_][A-Z0-9_]*)=(.+)$/gm,
    redaction: "$1=[REDACTED]",
  },
  // Platform tokens
  {
    name: "discord_token",
    pattern: /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/g,
    redaction: "[REDACTED_DISCORD_TOKEN]",
  },
  {
    name: "telegram_token",
    pattern: /\d{8,10}:[a-zA-Z0-9_-]{35}/g,
    redaction: "[REDACTED_TELEGRAM_TOKEN]",
  },
  // AWS credentials
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    redaction: "[REDACTED_AWS_KEY]",
  },
  // Generic secrets
  {
    name: "secret_value",
    pattern: /(?:secret|token|password|key)["']?\s*[:=]\s*["']?[a-zA-Z0-9_\-\/+=]{20,}["']?/gi,
    redaction: "[REDACTED_SECRET]",
  },
];

// =============================================================================
// ENVIRONMENT LOADING
// =============================================================================

/**
 * Raw environment values - all values are strings or undefined
 */
interface EnvVars {
  anthropicApiKey: string | undefined;
  anthropicAuthMode: string | undefined;
  anthropicAuthToken: string | undefined;
  openaiApiKey: string | undefined;
  openaiAuthMode: string | undefined;
  openaiChatgptAuthFile: string | undefined;
  openaiSubscriptionAccessToken: string | undefined;
  openaiSubscriptionAccountId: string | undefined;
  deepseekApiKey: string | undefined;
  qwenApiKey: string | undefined;
  kimiApiKey: string | undefined;
  minimaxApiKey: string | undefined;
  groqApiKey: string | undefined;
  mistralApiKey: string | undefined;
  togetherApiKey: string | undefined;
  fireworksApiKey: string | undefined;
  geminiApiKey: string | undefined;
  providerChain: string | undefined;
  telegramBotToken: string | undefined;
  allowedTelegramUserIds: string | undefined;
  discordBotToken: string | undefined;
  discordGuildId: string | undefined;
  allowedDiscordUserIds: string | undefined;
  allowedDiscordRoleIds: string | undefined;
  slackBotToken: string | undefined;
  slackSigningSecret: string | undefined;
  slackAppToken: string | undefined;
  slackSocketMode: string | undefined;
  allowedSlackWorkspaces: string | undefined;
  allowedSlackUserIds: string | undefined;
  teamsAppId: string | undefined;
  teamsAppPassword: string | undefined;
  teamsAppType: string | undefined;
  teamsAppTenantId: string | undefined;
  teamsAllowedUserIds: string | undefined;
  teamsAllowOpenAccess: string | undefined;
  jwtSecret: string | undefined;
  requireMfa: string | undefined;
  requireEditConfirmation: string | undefined;
  readOnlyMode: string | undefined;
  unityProjectPath: string | undefined;
  unityBridgePort: string | undefined;
  unityBridgeAutoConnect: string | undefined;
  unityBridgeTimeout: string | undefined;
  unityEditorPath: string | undefined;
  stradaCoreRepoUrl: string | undefined;
  stradaModulesRepoUrl: string | undefined;
  stradaMcpRepoUrl: string | undefined;
  stradaMcpPath: string | undefined;
  scriptExecuteEnabled: string | undefined;
  reflectionInvokeEnabled: string | undefined;
  dashboardEnabled: string | undefined;
  dashboardPort: string | undefined;
  websocketDashboardEnabled: string | undefined;
  websocketDashboardPort: string | undefined;
  websocketDashboardAuthToken: string | undefined;
  websocketDashboardAllowedOrigins: string | undefined;
  ollamaBaseUrl: string | undefined;
  prometheusEnabled: string | undefined;
  prometheusPort: string | undefined;
  modelIntelligenceEnabled: string | undefined;
  modelIntelligenceRefreshHours: string | undefined;
  modelIntelligenceDbPath: string | undefined;
  modelIntelligenceProviderSourcesPath: string | undefined;
  memoryEnabled: string | undefined;
  memoryDbPath: string | undefined;
  memoryBackend: string | undefined;
  memoryDimensions: string | undefined;
  memoryAutoTiering: string | undefined;
  memoryAutoTieringIntervalMs: string | undefined;
  memoryPromotionThreshold: string | undefined;
  memoryDemotionTimeoutDays: string | undefined;
  memoryTierWorkingMax: string | undefined;
  memoryTierEphemeralMax: string | undefined;
  memoryTierPersistentMax: string | undefined;
  memoryEphemeralTtlHours: string | undefined;
  ragEnabled: string | undefined;
  embeddingProvider: string | undefined;
  embeddingModel: string | undefined;
  embeddingBaseUrl: string | undefined;
  embeddingDimensions: string | undefined;
  ragContextMaxTokens: string | undefined;
  streamingEnabled: string | undefined;
  shellEnabled: string | undefined;
  llmStreamInitialTimeoutMs: string | undefined;
  llmStreamStallTimeoutMs: string | undefined;
  llmProviderFirstResponseTimeoutMs: string | undefined;
  rateLimitEnabled: string | undefined;
  rateLimitMessagesPerMinute: string | undefined;
  rateLimitMessagesPerHour: string | undefined;
  rateLimitTokensPerDay: string | undefined;
  rateLimitDailyBudgetUsd: string | undefined;
  rateLimitMonthlyBudgetUsd: string | undefined;
  // Unified Budget System
  stradaBudgetDailyUsd: string | undefined;
  stradaBudgetMonthlyUsd: string | undefined;
  stradaBudgetWarnPct: string | undefined;
  // Codebase Memory Vault (nested object assembled from individual env vars before schema parse)
  vault: {
    enabled: string | undefined;
    writeHookBudgetMs: string | undefined;
    debounceMs: string | undefined;
    embeddingFallback: string | undefined;
    self: {
      enabled: string | undefined;
    };
  };
  logLevel: string | undefined;
  logFile: string | undefined;
  webChannelPort: string | undefined;
  pluginDirs: string | undefined;
  bayesianEnabled: string | undefined;
  bayesianDeprecatedThreshold: string | undefined;
  bayesianActiveThreshold: string | undefined;
  bayesianEvolutionThreshold: string | undefined;
  bayesianAutoEvolveThreshold: string | undefined;
  bayesianMaxInitial: string | undefined;
  bayesianCoolingPeriodDays: string | undefined;
  bayesianCoolingMinObservations: string | undefined;
  bayesianCoolingMaxFailures: string | undefined;
  bayesianPromotionMinObservations: string | undefined;
  bayesianVerdictCleanSuccess: string | undefined;
  bayesianVerdictRetrySuccess: string | undefined;
  bayesianVerdictFailure: string | undefined;
  goalMaxDepth: string | undefined;
  goalMaxRetries: string | undefined;
  goalMaxFailures: string | undefined;
  goalParallelExecution: string | undefined;
  goalMaxParallel: string | undefined;
  providerMaxConcurrentRequests: string | undefined;
  stradaGoalEscalationTimeoutMinutes: string | undefined;
  stradaGoalMaxRedecompositions: string | undefined;
  toolChainEnabled: string | undefined;
  toolChainMinOccurrences: string | undefined;
  toolChainSuccessRateThreshold: string | undefined;
  toolChainMaxActive: string | undefined;
  toolChainMaxAgeDays: string | undefined;
  toolChainLlmBudgetPerCycle: string | undefined;
  toolChainMinChainLength: string | undefined;
  toolChainMaxChainLength: string | undefined;
  toolChainDetectionIntervalMs: string | undefined;
  crossSessionEnabled: string | undefined;
  crossSessionMaxAgeDays: string | undefined;
  crossSessionScopeFilter: string | undefined;
  crossSessionRecencyBoost: string | undefined;
  crossSessionScopeBoost: string | undefined;
  crossSessionPromotionThreshold: string | undefined;
  agentName: string | undefined;
  language: string | undefined;
  daemonIntervalMs: string | undefined;
  daemonTimezone: string | undefined;
  daemonHeartbeatFile: string | undefined;
  daemonDailyBudget: string | undefined;
  daemonBudgetWarnPct: string | undefined;
  daemonApprovalTimeoutMin: string | undefined;
  daemonAutoApproveTools: string | undefined;
  daemonBackoffBase: string | undefined;
  daemonBackoffMax: string | undefined;
  daemonFailureThreshold: string | undefined;
  daemonIdlePause: string | undefined;
  webhookSecret: string | undefined;
  webhookRateLimit: string | undefined;
  daemonDedupWindowMs: string | undefined;
  daemonDefaultDebounceMs: string | undefined;
  checklistMorningHour: string | undefined;
  checklistAfternoonHour: string | undefined;
  checklistEveningHour: string | undefined;
  // Trigger Fire History Pruning (Phase 21)
  triggerFireRetentionDays: string | undefined;
  // Notification, Quiet Hours, Digest (Phase 18)
  stradaDigestEnabled: string | undefined;
  stradaDigestSchedule: string | undefined;
  stradaNotifyMinLevel: string | undefined;
  stradaNotifySilent: string | undefined;
  stradaNotifyLow: string | undefined;
  stradaNotifyMedium: string | undefined;
  stradaNotifyHigh: string | undefined;
  stradaNotifyCritical: string | undefined;
  stradaQuietStart: string | undefined;
  stradaQuietEnd: string | undefined;
  stradaQuietBufferMax: string | undefined;
  stradaDashboardHistoryDepth: string | undefined;
  // Memory Re-Retrieval (Phase 17)
  stradaMemoryReRetrievalEnabled: string | undefined;
  stradaMemoryReRetrievalInterval: string | undefined;
  stradaMemoryTopicShiftEnabled: string | undefined;
  stradaMemoryTopicShiftThreshold: string | undefined;
  stradaMemoryMaxReRetrievals: string | undefined;
  stradaMemoryReRetrievalTimeoutMs: string | undefined;
  stradaMemoryReRetrievalMemoryLimit: string | undefined;
  stradaMemoryReRetrievalRagTopK: string | undefined;
  // Memory Decay (Phase 21)
  memoryDecayEnabled: string | undefined;
  memoryDecayLambdaWorking: string | undefined;
  memoryDecayLambdaEphemeral: string | undefined;
  memoryDecayLambdaPersistent: string | undefined;
  memoryDecayExemptDomains: string | undefined;
  memoryDecayTimeoutMs: string | undefined;
  // Memory Consolidation (Phase 25)
  memoryConsolidationEnabled: string | undefined;
  memoryConsolidationIdleMinutes: string | undefined;
  memoryConsolidationThreshold: string | undefined;
  memoryConsolidationBatchSize: string | undefined;
  memoryConsolidationMinClusterSize: string | undefined;
  memoryConsolidationMaxDepth: string | undefined;
  memoryConsolidationModelTier: string | undefined;
  // Chain Resilience (Phase 22)
  chainRollbackEnabled: string | undefined;
  chainParallelEnabled: string | undefined;
  chainMaxParallelBranches: string | undefined;
  chainCompensationTimeoutMs: string | undefined;
  // Multi-Agent (Phase 23)
  multiAgentEnabled: string | undefined;
  agentDefaultBudgetUsd: string | undefined;
  agentMaxConcurrent: string | undefined;
  agentIdleTimeoutMs: string | undefined;
  agentMaxMemoryEntries: string | undefined;
  // Task Delegation (Phase 24)
  taskDelegationEnabled: string | undefined;
  agentMaxDelegationDepth: string | undefined;
  agentMaxConcurrentDelegations: string | undefined;
  delegationTierLocal: string | undefined;
  delegationTierCheap: string | undefined;
  delegationTierStandard: string | undefined;
  delegationTierPremium: string | undefined;
  delegationVerbosity: string | undefined;
  delegationTypes: string | undefined;
  // Task routing
  taskMaxConcurrent: string | undefined;
  taskMessageBurstWindowMs: string | undefined;
  taskMessageBurstMaxMessages: string | undefined;
  taskInteractiveMaxIterations: string | undefined;
  taskInteractiveTokenBudget: string | undefined;
  taskBackgroundEpochMaxIterations: string | undefined;
  taskBackgroundAutoContinue: string | undefined;
  taskInteractiveAutoContinue: string | undefined;
  taskBackgroundMaxEpochs: string | undefined;
  // Interaction Policy
  interactionMode: string | undefined;
  interactionHeartbeatAfterMs: string | undefined;
  interactionHeartbeatIntervalMs: string | undefined;
  interactionEscalationPolicy: string | undefined;
  // Autonomous Mode
  autonomousDefaultEnabled: string | undefined;
  autonomousDefaultHours: string | undefined;
  // Conformance Guard
  conformanceEnabled: string | undefined;
  conformanceFrameworkPathsOnly: string | undefined;
  // Control Loop
  loopFingerprintThreshold: string | undefined;
  loopFingerprintWindow: string | undefined;
  loopDensityThreshold: string | undefined;
  loopDensityWindow: string | undefined;
  loopMaxRecoveryEpisodes: string | undefined;
  loopStaleAnalysisThreshold: string | undefined;
  loopHardCapReplan: string | undefined;
  loopHardCapBlock: string | undefined;
  progressAssessmentEnabled: string | undefined;
  // Daemon Full Autonomy
  daemonFullAutonomy: string | undefined;
  // Provider Routing
  routingPreset: string | undefined;
  routingPhaseSwitching: string | undefined;
  // Consensus
  consensusMode: string | undefined;
  consensusThreshold: string | undefined;
  consensusMaxProviders: string | undefined;
  // Auto-Update
  autoUpdateEnabled: string | undefined;
  autoUpdateIntervalHours: string | undefined;
  autoUpdateIdleTimeoutMin: string | undefined;
  autoUpdateChannel: string | undefined;
  autoUpdateNotify: string | undefined;
  autoUpdateAutoRestart: string | undefined;
  // Learning Pipeline v2
  stradaConfidenceWeights: string | undefined;
  stradaMaxInstincts: string | undefined;
  stradaDetectionWindowSize: string | undefined;
  stradaPeriodicExtractionInterval: string | undefined;
  // Supervisor Brain
  stradaSupervisorEnabled: string | undefined;
  stradaSupervisorComplexityThreshold: string | undefined;
  stradaSupervisorMaxParallelNodes: string | undefined;
  stradaSupervisorNodeTimeoutMs: string | undefined;
  stradaSupervisorVerificationMode: string | undefined;
  stradaSupervisorVerificationBudgetPct: string | undefined;
  stradaSupervisorTriageProvider: string | undefined;
  stradaSupervisorMaxFailureBudget: string | undefined;
  stradaSupervisorDiversityCap: string | undefined;
  // OpenCode (Zen/Go)
  opencodeApiKey: string | undefined;
  opencode2ApiKey: string | undefined;
  opencodeBaseUrl: string | undefined;
  opencodeDefaultModel: string | undefined;
  // OpenRouter
  openrouterApiKey: string | undefined;
  // External MCP servers (file-backed, not an env var — see loadMcpServers)
  mcpServers: unknown[];
  // Obsidian Integration
  obsidian: {
    enabled: string | undefined;
    apiUrl: string | undefined;
    apiKey: string | undefined;
    vaultPath: string | undefined;
    certPath: string | undefined;
  };
}

/**
 * Load configuration from environment variables
 */
/**
 * Reads the external MCP server list.
 *
 * A file rather than an environment variable: server lists are structured
 * (command, args, per-server env), they get long, and the per-server `env` is
 * where credentials live — none of which survives being flattened into a shell
 * variable. The path follows the convention other MCP hosts use.
 *
 * Every failure returns an empty list and logs, because a malformed MCP config
 * must cost the user their MCP tools, never their ability to start Strada.
 */
function loadMcpServers(env: Record<string, string | undefined>): unknown[] {
  const path = env["MCP_CONFIG_PATH"] ?? join(env["STRADA_HOME"] ?? homedir(), ".strada", "mcp.json");
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const keep = (entries: unknown[]): unknown[] => {
      // Validate per entry and drop the bad ones. A malformed entry must cost
      // the user that server, never their ability to start Strada — letting it
      // reach the top-level schema turns an optional integration into a fatal
      // config error.
      const good: unknown[] = [];
      for (const entry of entries) {
        if (mcpServerEntrySchema.safeParse(entry).success) {
          good.push(entry);
          continue;
        }
        const name =
          entry && typeof entry === "object" && "name" in entry
            ? String((entry as { name: unknown }).name)
            : "(unnamed)";
        warnAboutMcpConfig(`MCP server "${name}" in ${path} is not a valid entry — skipping it`);
      }
      return good;
    };
    // Accept both a bare array and the `{ "mcpServers": {...} }` object other
    // hosts use, so a config can be copied across without being rewritten.
    if (Array.isArray(parsed)) return keep(parsed);
    if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
      const servers = (parsed as { mcpServers: unknown }).mcpServers;
      if (Array.isArray(servers)) return keep(servers);
      if (servers && typeof servers === "object") {
        // Object form is keyed by server name; the name lives in the key.
        return keep(
          Object.entries(servers as Record<string, Record<string, unknown>>).map(
            ([name, spec]) => ({ name, ...spec }),
          ),
        );
      }
    }
    warnAboutMcpConfig(`MCP config at ${path} has an unrecognised shape — ignoring it`);
    return [];
  } catch (err) {
    warnAboutMcpConfig(
      `MCP config at ${path} could not be read — ignoring it: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Config is parsed before the logger is constructed, so this cannot go through
 * getLogger(). stderr is the only channel that exists this early, and staying
 * silent would leave a user with a typo'd MCP config wondering why none of
 * their tools appeared.
 */
function warnAboutMcpConfig(message: string): void {
  // eslint-disable-next-line no-console -- see above: no logger exists yet
  console.warn(`[config] ${message}`);
}

function loadFromEnv(env: Record<string, string | undefined>): EnvVars {
  return {
    mcpServers: loadMcpServers(env),
    anthropicApiKey: env["ANTHROPIC_API_KEY"],
    anthropicAuthMode: env["ANTHROPIC_AUTH_MODE"],
    anthropicAuthToken: env["ANTHROPIC_AUTH_TOKEN"],
    openaiApiKey: env["OPENAI_API_KEY"],
    openaiAuthMode: env["OPENAI_AUTH_MODE"],
    openaiChatgptAuthFile: env["OPENAI_CHATGPT_AUTH_FILE"],
    openaiSubscriptionAccessToken: env["OPENAI_SUBSCRIPTION_ACCESS_TOKEN"],
    openaiSubscriptionAccountId: env["OPENAI_SUBSCRIPTION_ACCOUNT_ID"],
    deepseekApiKey: env["DEEPSEEK_API_KEY"],
    qwenApiKey: env["QWEN_API_KEY"],
    kimiApiKey: env["KIMI_API_KEY"],
    minimaxApiKey: env["MINIMAX_API_KEY"],
    groqApiKey: env["GROQ_API_KEY"],
    mistralApiKey: env["MISTRAL_API_KEY"],
    togetherApiKey: env["TOGETHER_API_KEY"],
    fireworksApiKey: env["FIREWORKS_API_KEY"],
    geminiApiKey: env["GEMINI_API_KEY"],
    opencodeApiKey: env["OPENCODE_API_KEY"],
    opencode2ApiKey: env["OPENCODE2_API_KEY"],
    opencodeBaseUrl: env["OPENCODE_BASE_URL"],
    opencodeDefaultModel: env["OPENCODE_DEFAULT_MODEL"],
    openrouterApiKey: env["OPENROUTER_API_KEY"],
    providerChain: env["PROVIDER_CHAIN"],
    telegramBotToken: env["TELEGRAM_BOT_TOKEN"],
    allowedTelegramUserIds: env["ALLOWED_TELEGRAM_USER_IDS"],
    discordBotToken: env["DISCORD_BOT_TOKEN"],
    discordGuildId: env["DISCORD_GUILD_ID"],
    allowedDiscordUserIds: env["ALLOWED_DISCORD_USER_IDS"],
    allowedDiscordRoleIds: env["ALLOWED_DISCORD_ROLE_IDS"],
    slackBotToken: env["SLACK_BOT_TOKEN"],
    slackSigningSecret: env["SLACK_SIGNING_SECRET"],
    slackAppToken: env["SLACK_APP_TOKEN"],
    slackSocketMode: env["SLACK_SOCKET_MODE"],
    allowedSlackWorkspaces: env["ALLOWED_SLACK_WORKSPACES"],
    allowedSlackUserIds: env["ALLOWED_SLACK_USER_IDS"],
    teamsAppId: env["TEAMS_APP_ID"],
    teamsAppPassword: env["TEAMS_APP_PASSWORD"],
    teamsAppType: env["TEAMS_APP_TYPE"],
    teamsAppTenantId: env["TEAMS_APP_TENANT_ID"],
    teamsAllowedUserIds: env["TEAMS_ALLOWED_USER_IDS"],
    teamsAllowOpenAccess: env["TEAMS_ALLOW_OPEN_ACCESS"],
    jwtSecret: env["JWT_SECRET"],
    requireMfa: env["REQUIRE_MFA"],
    requireEditConfirmation: env["REQUIRE_EDIT_CONFIRMATION"],
    readOnlyMode: env["READ_ONLY_MODE"],
    unityProjectPath: env["UNITY_PROJECT_PATH"],
    unityBridgePort: env["UNITY_BRIDGE_PORT"],
    unityBridgeAutoConnect: env["UNITY_BRIDGE_AUTO_CONNECT"],
    unityBridgeTimeout: env["UNITY_BRIDGE_TIMEOUT"],
    unityEditorPath: env["UNITY_EDITOR_PATH"] ?? env["UNITY_PATH"],
    stradaCoreRepoUrl: env["STRADA_CORE_REPO_URL"],
    stradaModulesRepoUrl: env["STRADA_MODULES_REPO_URL"],
    stradaMcpRepoUrl: env["STRADA_MCP_REPO_URL"],
    stradaMcpPath: env["STRADA_MCP_PATH"],
    scriptExecuteEnabled: env["SCRIPT_EXECUTE_ENABLED"],
    reflectionInvokeEnabled: env["REFLECTION_INVOKE_ENABLED"],
    dashboardEnabled: env["DASHBOARD_ENABLED"],
    dashboardPort: env["DASHBOARD_PORT"],
    websocketDashboardEnabled: env["ENABLE_WEBSOCKET_DASHBOARD"],
    websocketDashboardPort: env["WEBSOCKET_DASHBOARD_PORT"],
    websocketDashboardAuthToken: env["WEBSOCKET_DASHBOARD_AUTH_TOKEN"],
    websocketDashboardAllowedOrigins: env["WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS"],
    ollamaBaseUrl: env["OLLAMA_BASE_URL"],
    prometheusEnabled: env["ENABLE_PROMETHEUS"],
    prometheusPort: env["PROMETHEUS_PORT"],
    modelIntelligenceEnabled: env["MODEL_INTELLIGENCE_ENABLED"],
    modelIntelligenceRefreshHours: env["MODEL_INTELLIGENCE_REFRESH_HOURS"],
    modelIntelligenceDbPath: env["MODEL_INTELLIGENCE_DB_PATH"],
    modelIntelligenceProviderSourcesPath: env["MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH"],
    memoryEnabled: env["MEMORY_ENABLED"],
    memoryDbPath: env["MEMORY_DB_PATH"],
    memoryBackend: env["MEMORY_BACKEND"],
    memoryDimensions: env["MEMORY_DIMENSIONS"],
    memoryAutoTiering: env["MEMORY_AUTO_TIERING"],
    memoryAutoTieringIntervalMs: env["MEMORY_AUTO_TIERING_INTERVAL_MS"],
    memoryPromotionThreshold: env["MEMORY_PROMOTION_THRESHOLD"],
    memoryDemotionTimeoutDays: env["MEMORY_DEMOTION_TIMEOUT_DAYS"],
    memoryTierWorkingMax: env["MEMORY_TIER_WORKING_MAX"],
    memoryTierEphemeralMax: env["MEMORY_TIER_EPHEMERAL_MAX"],
    memoryTierPersistentMax: env["MEMORY_TIER_PERSISTENT_MAX"],
    memoryEphemeralTtlHours: env["MEMORY_EPHEMERAL_TTL_HOURS"],
    ragEnabled: env["RAG_ENABLED"],
    embeddingProvider: env["EMBEDDING_PROVIDER"],
    embeddingModel: env["EMBEDDING_MODEL"],
    embeddingBaseUrl: env["EMBEDDING_BASE_URL"],
    embeddingDimensions: env["EMBEDDING_DIMENSIONS"],
    ragContextMaxTokens: env["RAG_CONTEXT_MAX_TOKENS"],
    streamingEnabled: env["STREAMING_ENABLED"],
    shellEnabled: env["SHELL_ENABLED"],
    llmStreamInitialTimeoutMs: env["LLM_STREAM_INITIAL_TIMEOUT_MS"],
    llmStreamStallTimeoutMs: env["LLM_STREAM_STALL_TIMEOUT_MS"],
    llmProviderFirstResponseTimeoutMs: env["LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS"],
    rateLimitEnabled: env["RATE_LIMIT_ENABLED"],
    rateLimitMessagesPerMinute: env["RATE_LIMIT_MESSAGES_PER_MINUTE"],
    rateLimitMessagesPerHour: env["RATE_LIMIT_MESSAGES_PER_HOUR"],
    rateLimitTokensPerDay: env["RATE_LIMIT_TOKENS_PER_DAY"],
    rateLimitDailyBudgetUsd: env["RATE_LIMIT_DAILY_BUDGET_USD"],
    rateLimitMonthlyBudgetUsd: env["RATE_LIMIT_MONTHLY_BUDGET_USD"],
    // Unified Budget System
    stradaBudgetDailyUsd: env["STRADA_BUDGET_DAILY_USD"],
    stradaBudgetMonthlyUsd: env["STRADA_BUDGET_MONTHLY_USD"],
    stradaBudgetWarnPct: env["STRADA_BUDGET_WARN_PCT"],
    // Codebase Memory Vault
    vault: {
      enabled: env["STRADA_VAULT_ENABLED"],
      writeHookBudgetMs: env["STRADA_VAULT_WRITE_HOOK_BUDGET_MS"],
      debounceMs: env["STRADA_VAULT_DEBOUNCE_MS"],
      embeddingFallback: env["STRADA_VAULT_EMBEDDING_FALLBACK"],
      self: {
        enabled: env["STRADA_VAULT_SELF_ENABLED"],
      },
    },
    // Obsidian Integration
    obsidian: {
      enabled: env["OBSIDIAN_ENABLED"],
      apiUrl: env["OBSIDIAN_API_URL"],
      apiKey: env["OBSIDIAN_API_KEY"],
      vaultPath: env["OBSIDIAN_VAULT_PATH"],
      certPath: env["OBSIDIAN_CERT_PATH"],
    },
    logLevel: env["LOG_LEVEL"],
    logFile: env["LOG_FILE"],
    webChannelPort: env["WEB_CHANNEL_PORT"],
    pluginDirs: env["PLUGIN_DIRS"],
    bayesianEnabled: env["BAYESIAN_ENABLED"],
    bayesianDeprecatedThreshold: env["BAYESIAN_DEPRECATED_THRESHOLD"],
    bayesianActiveThreshold: env["BAYESIAN_ACTIVE_THRESHOLD"],
    bayesianEvolutionThreshold: env["BAYESIAN_EVOLUTION_THRESHOLD"],
    bayesianAutoEvolveThreshold: env["BAYESIAN_AUTO_EVOLVE_THRESHOLD"],
    bayesianMaxInitial: env["BAYESIAN_MAX_INITIAL"],
    bayesianCoolingPeriodDays: env["BAYESIAN_COOLING_PERIOD_DAYS"],
    bayesianCoolingMinObservations: env["BAYESIAN_COOLING_MIN_OBSERVATIONS"],
    bayesianCoolingMaxFailures: env["BAYESIAN_COOLING_MAX_FAILURES"],
    bayesianPromotionMinObservations: env["BAYESIAN_PROMOTION_MIN_OBSERVATIONS"],
    bayesianVerdictCleanSuccess: env["BAYESIAN_VERDICT_CLEAN_SUCCESS"],
    bayesianVerdictRetrySuccess: env["BAYESIAN_VERDICT_RETRY_SUCCESS"],
    bayesianVerdictFailure: env["BAYESIAN_VERDICT_FAILURE"],
    goalMaxDepth: env["GOAL_MAX_DEPTH"],
    goalMaxRetries: env["GOAL_MAX_RETRIES"],
    goalMaxFailures: env["GOAL_MAX_FAILURES"],
    goalParallelExecution: env["GOAL_PARALLEL_EXECUTION"],
    goalMaxParallel: env["GOAL_MAX_PARALLEL"],
    providerMaxConcurrentRequests: env["PROVIDER_MAX_CONCURRENT_REQUESTS"],
    stradaGoalEscalationTimeoutMinutes: env["STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES"],
    stradaGoalMaxRedecompositions: env["STRADA_GOAL_MAX_REDECOMPOSITIONS"],
    toolChainEnabled: env["TOOL_CHAIN_ENABLED"],
    toolChainMinOccurrences: env["TOOL_CHAIN_MIN_OCCURRENCES"],
    toolChainSuccessRateThreshold: env["TOOL_CHAIN_SUCCESS_RATE_THRESHOLD"],
    toolChainMaxActive: env["TOOL_CHAIN_MAX_ACTIVE"],
    toolChainMaxAgeDays: env["TOOL_CHAIN_MAX_AGE_DAYS"],
    toolChainLlmBudgetPerCycle: env["TOOL_CHAIN_LLM_BUDGET_PER_CYCLE"],
    toolChainMinChainLength: env["TOOL_CHAIN_MIN_CHAIN_LENGTH"],
    toolChainMaxChainLength: env["TOOL_CHAIN_MAX_CHAIN_LENGTH"],
    toolChainDetectionIntervalMs: env["TOOL_CHAIN_DETECTION_INTERVAL_MS"],
    crossSessionEnabled: env["STRADA_CROSS_SESSION_ENABLED"],
    crossSessionMaxAgeDays: env["STRADA_INSTINCT_MAX_AGE_DAYS"],
    crossSessionScopeFilter: env["STRADA_INSTINCT_SCOPE_FILTER"],
    crossSessionRecencyBoost: env["STRADA_INSTINCT_RECENCY_BOOST"],
    crossSessionScopeBoost: env["STRADA_INSTINCT_SCOPE_BOOST"],
    crossSessionPromotionThreshold: env["STRADA_INSTINCT_PROMOTION_THRESHOLD"],
    agentName: env["STRADA_AGENT_NAME"],
    language: env["LANGUAGE_PREFERENCE"],
    daemonIntervalMs: env["STRADA_DAEMON_INTERVAL_MS"],
    daemonTimezone: env["STRADA_DAEMON_TIMEZONE"],
    daemonHeartbeatFile: env["STRADA_DAEMON_HEARTBEAT_FILE"],
    daemonDailyBudget: env["STRADA_DAEMON_DAILY_BUDGET"],
    daemonBudgetWarnPct: env["STRADA_DAEMON_BUDGET_WARN_PCT"],
    daemonApprovalTimeoutMin: env["STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES"],
    daemonAutoApproveTools: env["STRADA_DAEMON_AUTO_APPROVE_TOOLS"],
    daemonBackoffBase: env["STRADA_DAEMON_BACKOFF_BASE"],
    daemonBackoffMax: env["STRADA_DAEMON_BACKOFF_MAX"],
    daemonFailureThreshold: env["STRADA_DAEMON_FAILURE_THRESHOLD"],
    daemonIdlePause: env["STRADA_DAEMON_IDLE_PAUSE"],
    webhookSecret: env["STRADA_WEBHOOK_SECRET"],
    webhookRateLimit: env["STRADA_WEBHOOK_RATE_LIMIT"],
    daemonDedupWindowMs: env["STRADA_DAEMON_DEDUP_WINDOW_MS"],
    daemonDefaultDebounceMs: env["STRADA_DAEMON_DEFAULT_DEBOUNCE_MS"],
    checklistMorningHour: env["STRADA_CHECKLIST_MORNING_HOUR"],
    checklistAfternoonHour: env["STRADA_CHECKLIST_AFTERNOON_HOUR"],
    checklistEveningHour: env["STRADA_CHECKLIST_EVENING_HOUR"],
    // Trigger Fire History Pruning (Phase 21)
    triggerFireRetentionDays: env["TRIGGER_FIRE_RETENTION_DAYS"],
    // Notification, Quiet Hours, Digest (Phase 18)
    stradaDigestEnabled: env["STRADA_DIGEST_ENABLED"],
    stradaDigestSchedule: env["STRADA_DIGEST_SCHEDULE"],
    stradaNotifyMinLevel: env["STRADA_NOTIFY_MIN_LEVEL"],
    stradaNotifySilent: env["STRADA_NOTIFY_SILENT"],
    stradaNotifyLow: env["STRADA_NOTIFY_LOW"],
    stradaNotifyMedium: env["STRADA_NOTIFY_MEDIUM"],
    stradaNotifyHigh: env["STRADA_NOTIFY_HIGH"],
    stradaNotifyCritical: env["STRADA_NOTIFY_CRITICAL"],
    stradaQuietStart: env["STRADA_QUIET_START"],
    stradaQuietEnd: env["STRADA_QUIET_END"],
    stradaQuietBufferMax: env["STRADA_QUIET_BUFFER_MAX"],
    stradaDashboardHistoryDepth: env["STRADA_DASHBOARD_HISTORY_DEPTH"],
    // Memory Re-Retrieval (Phase 17)
    stradaMemoryReRetrievalEnabled: env["STRADA_MEMORY_RERETRIEVAL_ENABLED"],
    stradaMemoryReRetrievalInterval: env["STRADA_MEMORY_RERETRIEVAL_INTERVAL"],
    stradaMemoryTopicShiftEnabled: env["STRADA_MEMORY_TOPIC_SHIFT_ENABLED"],
    stradaMemoryTopicShiftThreshold: env["STRADA_MEMORY_TOPIC_SHIFT_THRESHOLD"],
    stradaMemoryMaxReRetrievals: env["STRADA_MEMORY_MAX_RERETRIEVALS"],
    stradaMemoryReRetrievalTimeoutMs: env["STRADA_MEMORY_RERETRIEVAL_TIMEOUT_MS"],
    stradaMemoryReRetrievalMemoryLimit: env["STRADA_MEMORY_RERETRIEVAL_MEMORY_LIMIT"],
    stradaMemoryReRetrievalRagTopK: env["STRADA_MEMORY_RERETRIEVAL_RAG_TOPK"],
    // Memory Decay (Phase 21)
    memoryDecayEnabled: env["MEMORY_DECAY_ENABLED"],
    memoryDecayLambdaWorking: env["MEMORY_DECAY_LAMBDA_WORKING"],
    memoryDecayLambdaEphemeral: env["MEMORY_DECAY_LAMBDA_EPHEMERAL"],
    memoryDecayLambdaPersistent: env["MEMORY_DECAY_LAMBDA_PERSISTENT"],
    memoryDecayExemptDomains: env["MEMORY_DECAY_EXEMPT_DOMAINS"],
    memoryDecayTimeoutMs: env["MEMORY_DECAY_TIMEOUT_MS"],
    // Memory Consolidation (Phase 25)
    memoryConsolidationEnabled: env["MEMORY_CONSOLIDATION_ENABLED"],
    memoryConsolidationIdleMinutes: env["MEMORY_CONSOLIDATION_IDLE_MINUTES"],
    memoryConsolidationThreshold: env["MEMORY_CONSOLIDATION_THRESHOLD"],
    memoryConsolidationBatchSize: env["MEMORY_CONSOLIDATION_BATCH_SIZE"],
    memoryConsolidationMinClusterSize: env["MEMORY_CONSOLIDATION_MIN_CLUSTER_SIZE"],
    memoryConsolidationMaxDepth: env["MEMORY_CONSOLIDATION_MAX_DEPTH"],
    memoryConsolidationModelTier: env["MEMORY_CONSOLIDATION_MODEL_TIER"],
    // Chain Resilience (Phase 22)
    chainRollbackEnabled: env["CHAIN_ROLLBACK_ENABLED"],
    chainParallelEnabled: env["CHAIN_PARALLEL_ENABLED"],
    chainMaxParallelBranches: env["CHAIN_MAX_PARALLEL_BRANCHES"],
    chainCompensationTimeoutMs: env["CHAIN_COMPENSATION_TIMEOUT_MS"],
    // Multi-Agent (Phase 23)
    multiAgentEnabled: env["MULTI_AGENT_ENABLED"],
    agentDefaultBudgetUsd: env["AGENT_DEFAULT_BUDGET_USD"],
    agentMaxConcurrent: env["AGENT_MAX_CONCURRENT"],
    agentIdleTimeoutMs: env["AGENT_IDLE_TIMEOUT_MS"],
    agentMaxMemoryEntries: env["AGENT_MAX_MEMORY_ENTRIES"],
    // Task Delegation (Phase 24)
    taskDelegationEnabled: env["TASK_DELEGATION_ENABLED"],
    agentMaxDelegationDepth: env["AGENT_MAX_DELEGATION_DEPTH"],
    agentMaxConcurrentDelegations: env["AGENT_MAX_CONCURRENT_DELEGATIONS"],
    delegationTierLocal: env["DELEGATION_TIER_LOCAL"],
    delegationTierCheap: env["DELEGATION_TIER_CHEAP"],
    delegationTierStandard: env["DELEGATION_TIER_STANDARD"],
    delegationTierPremium: env["DELEGATION_TIER_PREMIUM"],
    delegationVerbosity: env["DELEGATION_VERBOSITY"],
    delegationTypes: env["DELEGATION_TYPES"],
    taskMaxConcurrent: env["TASK_MAX_CONCURRENT"],
    taskMessageBurstWindowMs: env["TASK_MESSAGE_BURST_WINDOW_MS"],
    taskMessageBurstMaxMessages: env["TASK_MESSAGE_BURST_MAX_MESSAGES"],
    taskInteractiveMaxIterations: env["TASK_INTERACTIVE_MAX_ITERATIONS"],
    taskInteractiveTokenBudget: env["TASK_INTERACTIVE_TOKEN_BUDGET"],
    taskBackgroundEpochMaxIterations: env["TASK_BACKGROUND_EPOCH_MAX_ITERATIONS"],
    taskBackgroundAutoContinue: env["TASK_BACKGROUND_AUTO_CONTINUE"],
    taskInteractiveAutoContinue: env["TASK_INTERACTIVE_AUTO_CONTINUE"],
    taskBackgroundMaxEpochs: env["TASK_BACKGROUND_MAX_EPOCHS"],
    interactionMode: env["INTERACTION_MODE"],
    interactionHeartbeatAfterMs: env["INTERACTION_HEARTBEAT_AFTER_MS"],
    interactionHeartbeatIntervalMs: env["INTERACTION_HEARTBEAT_INTERVAL_MS"],
    interactionEscalationPolicy: env["INTERACTION_ESCALATION_POLICY"],
    // Autonomous Mode
    autonomousDefaultEnabled: env["AUTONOMOUS_DEFAULT_ENABLED"],
    autonomousDefaultHours: env["AUTONOMOUS_DEFAULT_HOURS"],
    // Conformance Guard
    conformanceEnabled: env["STRADA_CONFORMANCE_ENABLED"],
    conformanceFrameworkPathsOnly: env["STRADA_CONFORMANCE_FRAMEWORK_PATHS_ONLY"],
    // Control Loop
    loopFingerprintThreshold: env["STRADA_LOOP_FINGERPRINT_THRESHOLD"],
    loopFingerprintWindow: env["STRADA_LOOP_FINGERPRINT_WINDOW"],
    loopDensityThreshold: env["STRADA_LOOP_DENSITY_THRESHOLD"],
    loopDensityWindow: env["STRADA_LOOP_DENSITY_WINDOW"],
    loopMaxRecoveryEpisodes: env["STRADA_LOOP_MAX_RECOVERY_EPISODES"],
    loopStaleAnalysisThreshold: env["STRADA_LOOP_STALE_ANALYSIS_THRESHOLD"],
    loopHardCapReplan: env["STRADA_LOOP_HARD_CAP_REPLAN"],
    loopHardCapBlock: env["STRADA_LOOP_HARD_CAP_BLOCK"],
    progressAssessmentEnabled: env["STRADA_PROGRESS_ASSESSMENT_ENABLED"],
    // Daemon Full Autonomy
    daemonFullAutonomy: env["STRADA_DAEMON_FULL_AUTONOMY"],
    // Provider Routing
    routingPreset: env["ROUTING_PRESET"],
    routingPhaseSwitching: env["ROUTING_PHASE_SWITCHING"],
    // Consensus
    consensusMode: env["CONSENSUS_MODE"],
    consensusThreshold: env["CONSENSUS_THRESHOLD"],
    consensusMaxProviders: env["CONSENSUS_MAX_PROVIDERS"],
    // Auto-Update
    autoUpdateEnabled: env["AUTO_UPDATE_ENABLED"],
    autoUpdateIntervalHours: env["AUTO_UPDATE_INTERVAL_HOURS"],
    autoUpdateIdleTimeoutMin: env["AUTO_UPDATE_IDLE_TIMEOUT_MIN"],
    autoUpdateChannel: env["AUTO_UPDATE_CHANNEL"],
    autoUpdateNotify: env["AUTO_UPDATE_NOTIFY"],
    autoUpdateAutoRestart: env["AUTO_UPDATE_AUTO_RESTART"],
    // Learning Pipeline v2
    stradaConfidenceWeights: env["STRADA_CONFIDENCE_WEIGHTS"],
    stradaMaxInstincts: env["STRADA_MAX_INSTINCTS"],
    stradaDetectionWindowSize: env["STRADA_DETECTION_WINDOW_SIZE"],
    stradaPeriodicExtractionInterval: env["STRADA_PERIODIC_EXTRACTION_INTERVAL"],
    // Supervisor Brain
    stradaSupervisorEnabled: env["SUPERVISOR_ENABLED"],
    stradaSupervisorComplexityThreshold: env["SUPERVISOR_COMPLEXITY_THRESHOLD"],
    stradaSupervisorMaxParallelNodes: env["SUPERVISOR_MAX_PARALLEL_NODES"],
    stradaSupervisorNodeTimeoutMs: env["SUPERVISOR_NODE_TIMEOUT_MS"],
    stradaSupervisorVerificationMode: env["SUPERVISOR_VERIFICATION_MODE"],
    stradaSupervisorVerificationBudgetPct: env["SUPERVISOR_VERIFICATION_BUDGET_PCT"],
    stradaSupervisorTriageProvider: env["SUPERVISOR_TRIAGE_PROVIDER"],
    stradaSupervisorMaxFailureBudget: env["SUPERVISOR_MAX_FAILURE_BUDGET"],
    stradaSupervisorDiversityCap: env["SUPERVISOR_DIVERSITY_CAP"],
  };
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

let cachedConfig: Config | null = null;

/** Active env source — overridable for testing via loadConfig(envOverride) */
const defaultEnv = process.env;

/**
 * Load and validate configuration from environment.
 * Pass an env override map (e.g. in tests) to read from that map instead of process.env.
 * When an override is provided the result is NOT cached.
 */
export function loadConfig(envOverride?: Record<string, string | undefined>): Config {
  if (!envOverride && cachedConfig) return cachedConfig;

  const activeEnv = envOverride ?? defaultEnv;
  const raw = loadFromEnv(activeEnv);
  const validation = validateConfig(raw);

  if (validation.kind === "invalid") {
    const errors = validation.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  const config = validation.value;

  // Validate project path
  const pathResult = validateProjectPath(config.unityProjectPath);
  if (pathResult.kind === "err") {
    throw new Error(pathResult.error);
  }

  // Apply system preset if configured (env vars override preset values)
  const presetName = activeEnv["SYSTEM_PRESET"];
  const preset = presetName ? getPreset(presetName) : undefined;
  if (presetName && !preset) {
    throw new Error(
      `Invalid SYSTEM_PRESET "${presetName}". Valid values: free, budget, balanced, performance, premium`,
    );
  }

  // Parse per-provider model overrides (manual env > preset > defaults)
  const providerModels: Record<string, string> = {};
  if (preset) {
    Object.assign(providerModels, preset.providerModels);
  }
  for (const p of [
    "openai",
    "deepseek",
    "qwen",
    "kimi",
    "minimax",
    "groq",
    "mistral",
    "together",
    "fireworks",
    "gemini",
    "openrouter",
    "claude",
    "ollama",
  ]) {
    const val = activeEnv[`${p.toUpperCase()}_MODEL`];
    if (val) providerModels[p] = val;
  }

  // OpenCode is the odd one out: its model env var is OPENCODE_DEFAULT_MODEL
  // (not OPENCODE_MODEL), so it is absent from the generic {PROVIDER}_MODEL loop
  // above and would otherwise never reach providerModels — leaving the provider
  // pinned to its hardcoded default. Wire it explicitly. A direct OPENCODE_MODEL
  // (if ever set) still wins via the loop; this only fills the gap.
  if (config.opencodeDefaultModel && !providerModels["opencode"]) {
    providerModels["opencode"] = config.opencodeDefaultModel;
  }
  // opencode2 shares the same model/base-URL configuration as opencode.
  if (providerModels["opencode"] && !providerModels["opencode2"]) {
    providerModels["opencode2"] = providerModels["opencode"];
  }

  // Per-provider base-URL overrides. OpenCode's base URL is the only one driven
  // by an env var today (OPENCODE_BASE_URL); when unset, createProvider falls
  // back to the Zen preset. ollama's base URL is threaded separately.
  const providerBaseUrls: Record<string, string> = {};
  if (config.opencodeBaseUrl) {
    providerBaseUrls["opencode"] = config.opencodeBaseUrl;
    providerBaseUrls["opencode2"] = config.opencodeBaseUrl;
  }

  // `anthropic` and `claude` are aliases for one provider, but the env var is
  // CLAUDE_MODEL (→ providerModels.claude). Mirror the value across both keys so
  // a chain entry written as either alias resolves the configured model — every
  // consumer (preflight, buildProviderChain, ProviderManager) keys this map by
  // the raw chain name, so `PROVIDER_CHAIN=anthropic` would otherwise silently
  // fall back to the provider's hardcoded default model.
  const claudeAliasModel = providerModels["claude"] ?? providerModels["anthropic"];
  if (claudeAliasModel) {
    providerModels["claude"] = claudeAliasModel;
    providerModels["anthropic"] = claudeAliasModel;
  }

  // Update with resolved path + preset overrides
  // Preset overrides must be applied to the correct nested config paths
  // Only adopt the preset's embedding model/baseUrl when the provider also comes
  // from the preset. A user-supplied EMBEDDING_PROVIDER must not be paired with a
  // preset model/baseUrl that belongs to a different provider (provider/model mismatch).
  const presetProvidesEmbeddingProvider = !activeEnv["EMBEDDING_PROVIDER"];
  const presetRagOverrides = preset ? {
    ...(presetProvidesEmbeddingProvider ? { provider: preset.embeddingProvider } : {}),
    ...(presetProvidesEmbeddingProvider && !activeEnv["EMBEDDING_MODEL"] ? { model: preset.embeddingModel } : {}),
    ...(presetProvidesEmbeddingProvider && !activeEnv["EMBEDDING_BASE_URL"] && preset.embeddingBaseUrl ? { baseUrl: preset.embeddingBaseUrl } : {}),
  } : {};
  const presetDelegationTierOverrides = preset ? {
    ...(!activeEnv["DELEGATION_TIER_LOCAL"] ? { local: preset.delegationTierLocal } : {}),
    ...(!activeEnv["DELEGATION_TIER_CHEAP"] ? { cheap: preset.delegationTierCheap } : {}),
    ...(!activeEnv["DELEGATION_TIER_STANDARD"] ? { standard: preset.delegationTierStandard } : {}),
    ...(!activeEnv["DELEGATION_TIER_PREMIUM"] ? { premium: preset.delegationTierPremium } : {}),
  } : {};

  const resolved: Config = {
    ...config,
    unityProjectPath: pathResult.value,
    providerModels,
    ...(Object.keys(providerBaseUrls).length > 0 ? { providerBaseUrls } : {}),
    // Preset fills in defaults; explicit env vars take precedence (already parsed by Zod above)
    ...(preset && !activeEnv["PROVIDER_CHAIN"] ? { providerChain: preset.providerChain } : {}),
    // Apply embedding overrides to the nested rag config
    ...(Object.keys(presetRagOverrides).length > 0 ? {
      rag: { ...config.rag, ...presetRagOverrides },
    } : {}),
    // Apply delegation tier overrides to the nested delegation.tiers config
    ...(Object.keys(presetDelegationTierOverrides).length > 0 ? {
      delegation: {
        ...config.delegation,
        tiers: { ...config.delegation.tiers, ...presetDelegationTierOverrides },
      },
    } : {}),
  } as Config;
  if (!envOverride) {
    cachedConfig = resolved;
  }

  return resolved;
}

/**
 * Load config without throwing (returns Result)
 */
export function loadConfigSafe(): Result<Config, string> {
  try {
    return { kind: "ok", value: loadConfig() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "err", error: message };
  }
}

/**
 * Reset config cache (useful for testing)
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get cached config or undefined
 */
export function getCachedConfig(): Config | undefined {
  return cachedConfig ?? undefined;
}

/**
 * Check if required API keys are present
 */
/**
 * Map every known provider name to its resolved credential (or `undefined`
 * when the operator has not supplied one). Subscription-style auth counts as a
 * credential — it is a usable path to the API even without a raw key.
 *
 * `ollama` is deliberately absent: it needs no credential, so callers must
 * treat it as always-available rather than looking it up here.
 *
 * Exported so credential presence has ONE definition. `hasRequiredApiKeys`
 * validates against it, and delegation tier derivation uses it to avoid
 * pinning a tier to a provider this deployment cannot actually call.
 */
export function getProviderCredentialMap(config: Config): Record<string, string | undefined> {
  const anthropic = config.anthropicApiKey ?? (
    config.anthropicAuthMode === "claude-subscription" ? config.anthropicAuthToken : undefined
  );
  const openai =
    config.openaiApiKey ??
    (config.openaiAuthMode === "chatgpt-subscription" ||
    Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId) ||
    Boolean(config.openaiChatgptAuthFile)
      ? "[chatgpt-subscription]"
      : undefined);
  return {
    claude: anthropic,
    anthropic,
    openai,
    deepseek: config.deepseekApiKey,
    qwen: config.qwenApiKey,
    kimi: config.kimiApiKey,
    minimax: config.minimaxApiKey,
    groq: config.groqApiKey,
    mistral: config.mistralApiKey,
    together: config.togetherApiKey,
    fireworks: config.fireworksApiKey,
    gemini: config.geminiApiKey,
    opencode: config.opencodeApiKey,
    // Second OpenCode account: a DISTINCT provider so the supervisor's
    // node assigner can distribute wave work across both accounts in
    // parallel (and health/cooldowns track per account).
    opencode2: config.opencode2ApiKey,
    openrouter: config.openrouterApiKey,
  };
}

/**
 * Provider names this deployment can actually reach: every provider with a
 * credential, plus `ollama` (local, needs none).
 */
export function getAvailableProviderNames(config: Config): string[] {
  const names = Object.entries(getProviderCredentialMap(config))
    .filter(([, credential]) => Boolean(credential))
    .map(([name]) => name);
  // `claude` and `anthropic` are aliases of one credential; keep both so
  // catalog entries recorded under either name resolve.
  return [...new Set([...names, "ollama"])];
}

export function hasRequiredApiKeys(config: Config): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  // If a provider chain is specified, check that each provider in the chain has its key
  if (config.providerChain) {
    const names = config.providerChain.split(",").map((s) => s.trim());
    const keyMap = getProviderCredentialMap(config);
    for (const name of names) {
      if (name === "ollama") continue; // no key needed
      if (!keyMap[name]) {
        if (name === "claude" || name === "anthropic") {
          const hasSubscription =
            config.anthropicAuthMode === "claude-subscription"
            && Boolean(config.anthropicAuthToken);
          if (!hasSubscription) {
            missing.push("ANTHROPIC_API_KEY");
          }
          continue;
        }
        if (name === "openai") {
          const hasSubscription =
            config.openaiAuthMode === "chatgpt-subscription" ||
            Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId) ||
            Boolean(config.openaiChatgptAuthFile);
          if (!hasSubscription) {
            missing.push("OPENAI_API_KEY");
          }
          continue;
        }
        missing.push(`${name.toUpperCase()}_API_KEY`);
      }
    }
  } else if (
    !config.anthropicApiKey
    && !(config.anthropicAuthMode === "claude-subscription" && config.anthropicAuthToken)
  ) {
    // No chain specified and no Anthropic key — check if any key exists
    const hasAny = [
      config.anthropicApiKey ?? (
        config.anthropicAuthMode === "claude-subscription" ? config.anthropicAuthToken : undefined
      ),
      config.openaiApiKey ??
        (config.openaiAuthMode === "chatgpt-subscription" ||
        Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId) ||
        Boolean(config.openaiChatgptAuthFile)
          ? "[chatgpt-subscription]"
          : undefined),
      config.deepseekApiKey,
      config.qwenApiKey,
      config.kimiApiKey,
      config.minimaxApiKey,
      config.groqApiKey,
      config.mistralApiKey,
      config.togetherApiKey,
      config.fireworksApiKey,
      config.geminiApiKey,
      config.opencodeApiKey,
      config.openrouterApiKey,
    ].some((k) => k && k.length > 0);

    if (!hasAny) {
      missing.push("ANTHROPIC_API_KEY");
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Check channel-specific configuration
 */
export function checkChannelConfig(
  config: Config,
  channelType:
    | "telegram"
    | "discord"
    | "slack"
    | "teams"
    | "cli"
    | "web",
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  switch (channelType) {
    case "telegram":
      if (!config.telegram.botToken) {
        errors.push("TELEGRAM_BOT_TOKEN is required");
      }
      if (config.telegram.allowedUserIds.length === 0) {
        errors.push("ALLOWED_TELEGRAM_USER_IDS is empty - all users will be denied");
      }
      break;

    case "discord":
      if (!config.discord.botToken) {
        errors.push("DISCORD_BOT_TOKEN is required");
      }
      if (
        config.discord.allowedUserIds.length === 0 &&
        config.discord.allowedRoleIds.length === 0
      ) {
        errors.push("ALLOWED_DISCORD_USER_IDS or ALLOWED_DISCORD_ROLE_IDS must be set");
      }
      break;

    case "slack":
      if (!config.slack.botToken) {
        errors.push("SLACK_BOT_TOKEN is required");
      }
      if (!config.slack.socketMode && !config.slack.signingSecret) {
        errors.push("SLACK_SIGNING_SECRET is required when not using socket mode");
      }
      break;




    case "teams":
      if (!config.teams.appId || !config.teams.appPassword) {
        errors.push("TEAMS_APP_ID and TEAMS_APP_PASSWORD are required");
      }
      break;

    case "cli":
    case "web":
      // CLI and Web don't require any special config
      break;
  }

  return { valid: errors.length === 0, errors };
}
