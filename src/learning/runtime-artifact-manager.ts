import { randomUUID } from "node:crypto";
import type { TaskType } from "../agent-core/routing/routing-types.js";
import type { TimestampMs } from "../types/index.js";
import type {
  EvolutionProposal,
  Instinct,
  RuntimeArtifact,
  RuntimeArtifactKind,
  RuntimeArtifactMatch,
  RuntimeArtifactOwnerScope,
  RuntimeArtifactState,
  RuntimeArtifactStats,
  TrajectoryId,
} from "./types.js";
import { createRuntimeArtifactId } from "./types.js";
import type { LearningStorage } from "./storage/learning-storage.js";
import { projectScopeMatches } from "./project-scope.js";
export { projectScopeMatches } from "./project-scope.js";

const PROMOTION_MIN_SAMPLES = 5;
const PROMOTION_MIN_CLEAN_RATE = 0.8;
const REJECTION_HARMFUL_THRESHOLD = 3;
const RETIREMENT_WINDOW = 10;
const RETIREMENT_MIN_CLEAN_RATE = 0.6;
const RETIREMENT_RETRY_THRESHOLD = 4;
const MATCH_THRESHOLD = 0.42;
const GUIDANCE_THRESHOLD = 0.55;
/** Cap on identities tracked in recentArtifactActivityByIdentity (LRU eviction). */
const MAX_TRACKED_IDENTITIES = 256;

export interface RuntimeArtifactMatches {
  readonly active: RuntimeArtifactMatch[];
  readonly shadow: RuntimeArtifactMatch[];
}

export interface RuntimeArtifactEvaluationInput {
  readonly artifactIds: readonly string[];
  /**
   * The subset of {@link artifactIds} whose guidance the run was actually
   * SHOWN (rendered into the prompt). Only these count towards promotion.
   */
  readonly exposedArtifactIds?: readonly string[];
  /**
   * Instincts presented to the run. An artifact whose source instinct was in
   * the prompt was exposed through it, even though the artifact itself was not
   * rendered separately.
   */
  readonly presentedInstinctIds?: readonly string[];
  readonly identityKey?: string;
  readonly verdict: "clean" | "retry" | "failure";
  readonly blocker: boolean;
  readonly reason: string;
  readonly failureFingerprint?: string;
}

/**
 * ROUND 11 #1 — THE ARTIFACT INHERITS ITS SOURCE INSTINCT'S REACH.
 *
 * A private instinct that earns five clean exposures becomes a runtime artifact,
 * and the artifact row carried the project scope and the source instinct ids but
 * no owner — while matching accepted no identity. So Alice's private correction
 * was excluded from Bob's instinct retrieval (round 10 #3) and then handed to
 * him in the same prompt as "runtime self-improvement" guidance.
 *
 * The owner comes from the instinct the artifact is made of: a 'user'-scoped
 * instinct with a recorded owner makes a private artifact; a 'user'-scoped
 * instinct whose owner is unrecorded makes an artifact that reaches NOBODY
 * (round 10 #3's lesson — "keep it reachable or learning goes dark" is how one
 * person's correction became everybody's rule); anything else is public.
 */
export function runtimeArtifactOwnershipOf(instinct: Instinct): {
  ownerScope: RuntimeArtifactOwnerScope;
  ownerUserId?: string;
} {
  if (instinct.scopeType !== "user") return { ownerScope: "public" };
  const owner = instinct.userId?.trim();
  return owner ? { ownerScope: "user", ownerUserId: owner } : { ownerScope: "unknown" };
}

/**
 * May `userId` be shown this artifact's guidance? (round 11 #1)
 *
 * 'unknown' reaches nobody — including an unidentified caller — because an
 * artifact whose ownership could not be established may be carrying somebody's
 * private rule.
 */
export function runtimeArtifactVisibleTo(
  artifact: Pick<RuntimeArtifact, "ownerScope" | "ownerUserId">,
  userId: string | undefined,
): boolean {
  const scope = artifact.ownerScope ?? "unknown";
  if (scope === "public") return true;
  if (scope !== "user") return false;
  const asking = userId?.trim();
  return Boolean(asking) && artifact.ownerUserId === asking;
}

export function createProjectScopeFingerprint(projectPath: string | null | undefined): string | undefined {
  const normalizedPath = projectPath?.trim();
  if (!normalizedPath) {
    return undefined;
  }
  return normalizeArtifactFingerprint(`root=${normalizedPath}`);
}

export class RuntimeArtifactManager {
  private readonly recentArtifactActivityByIdentity = new Map<string, Array<{ artifactId: string; timestamp: number }>>();

  constructor(private readonly storage: LearningStorage) {}

  materializeShadowArtifact(instinct: Instinct, projectPath?: string): {
    artifact: RuntimeArtifact;
    proposal: EvolutionProposal | null;
    proposalCreated: boolean;
    created: boolean;
  } {
    const kind = this.determineArtifactKind(instinct);
    const existing = this.storage.getRuntimeArtifactBySourceInstinct(instinct.id, kind, ["shadow", "active"]);
    if (!existing) {
      // LRN-15: guidance judged harmful or worn out comes back only on new
      // evidence for its rule, never merely because the rule is still eligible.
      const closed = this.closedArtifactWithoutNewEvidence(instinct, kind);
      if (closed) return { artifact: closed, proposal: null, proposalCreated: false, created: false };
    }
    // r11 #1: the owner travels with the guidance from the moment the artifact
    // is made, and a merge that would widen the reach collapses to 'unknown'
    // rather than quietly publishing one person's rule.
    const ownership = mergeOwnership(existing, runtimeArtifactOwnershipOf(instinct));
    const scopeFingerprint = createProjectScopeFingerprint(projectPath);
    const now = Date.now();
    const guidance = this.buildGuidance(instinct, kind);
    const description = this.buildDescription(instinct, kind);
    const sourceTrajectoryIds = mergeIds(existing?.sourceTrajectoryIds ?? [], instinct.sourceTrajectoryIds);

    const artifact: RuntimeArtifact = existing
      ? {
          ...existing,
          kind,
          name: existing.name || instinct.name,
          description,
          guidance,
          taskTypes: this.inferTaskTypes(instinct),
          taskPatterns: this.buildTaskPatterns(instinct),
          projectWorldFingerprint: existing.projectWorldFingerprint ?? scopeFingerprint,
          requiredToolNames: this.extractRequiredToolNames(instinct),
          requiredCapabilities: this.inferRequiredCapabilities(kind),
          sourceInstinctIds: mergeIds(existing.sourceInstinctIds, [instinct.id]),
          sourceTrajectoryIds,
          ownerScope: ownership.ownerScope,
          ...(ownership.ownerUserId ? { ownerUserId: ownership.ownerUserId } : {}),
          updatedAt: now,
        }
      : {
          id: createRuntimeArtifactId(),
          kind,
          state: "shadow",
          name: instinct.name,
          description,
          guidance,
          taskTypes: this.inferTaskTypes(instinct),
          taskPatterns: this.buildTaskPatterns(instinct),
          projectWorldFingerprint: scopeFingerprint,
          requiredToolNames: this.extractRequiredToolNames(instinct),
          requiredCapabilities: this.inferRequiredCapabilities(kind),
          sourceInstinctIds: [instinct.id],
          sourceTrajectoryIds,
          stats: createDefaultRuntimeArtifactStats(),
          shadowActivatedAt: now,
          ownerScope: ownership.ownerScope,
          ...(ownership.ownerUserId ? { ownerUserId: ownership.ownerUserId } : {}),
          createdAt: now,
          updatedAt: now,
        };

    this.storage.upsertRuntimeArtifact(artifact);

    const proposal = existing ? null : ({
      id: `evolution_${randomUUID()}` as EvolutionProposal["id"],
      instinctId: instinct.id,
      targetType: kind,
      name: artifact.name,
      description: `Runtime ${kind.replace(/_/g, " ")} artifact derived from instinct "${instinct.name}".`,
      confidence: instinct.confidence,
      implementation: artifact.guidance,
      status: "implemented",
      proposedAt: now,
      decidedAt: now,
      affectedTrajectoryIds: sourceTrajectoryIds as TrajectoryId[],
    } satisfies EvolutionProposal);
    if (proposal) {
      this.storage.createEvolutionProposal(proposal);
    }

    return {
      artifact,
      proposal,
      proposalCreated: proposal !== null,
      created: existing == null,
    };
  }

  /**
   * The latest rejected or retired artifact of this kind from this instinct,
   * when the instinct has no more evidence (applications + failures) than it
   * had at the close. updatedAt is no measure: it moves on every use. A row
   * closed before the count was recorded gets today's count as its baseline.
   */
  private closedArtifactWithoutNewEvidence(instinct: Instinct, kind: RuntimeArtifactKind): RuntimeArtifact | null {
    const closed = this.storage.getRuntimeArtifactBySourceInstinct(instinct.id, kind, ["rejected", "retired"]);
    if (!closed) return null;
    const evidence = instinct.stats.timesApplied + instinct.stats.timesFailed;
    const atClose = closed.sourceEvidenceAtClose?.[instinct.id];
    if (atClose !== undefined) return evidence > atClose ? null : closed;
    const baselined: RuntimeArtifact = {
      ...closed,
      sourceEvidenceAtClose: { ...closed.sourceEvidenceAtClose, [instinct.id]: evidence },
    };
    this.storage.upsertRuntimeArtifact(baselined);
    return baselined;
  }

  matchForTask(params: {
    taskDescription: string;
    taskType: TaskType;
    projectWorldFingerprint?: string;
    availableToolNames?: readonly string[];
    maxMatches?: number;
    /**
     * ROUND 11 #1 — WHOSE TURN THIS IS. Omitted (or unknown) ⇒ only public
     * artifacts, exactly as instinct retrieval treats an unidentified caller.
     * The gate runs in storage, before the candidate LIMIT, so another person's
     * private artifacts cannot crowd out this caller's own.
     */
    userId?: string;
  }): RuntimeArtifactMatches {
    const availableTools = new Set((params.availableToolNames ?? []).map((name) => name.trim().toLowerCase()));
    const candidates = this.storage.getRuntimeArtifacts({
      states: ["shadow", "active"],
      limit: 64,
      visibility: { ...(params.userId?.trim() ? { userId: params.userId.trim() } : {}) },
    });
    const matches = candidates
      .map((artifact) => this.matchArtifact(artifact, params.taskDescription, params.taskType, params.projectWorldFingerprint, availableTools))
      .filter((match): match is RuntimeArtifactMatch => match !== null)
      .sort((left, right) => right.matchScore - left.matchScore);

    const limited = matches.slice(0, params.maxMatches ?? 6);
    return {
      active: limited.filter((match) => match.artifact.state === "active"),
      shadow: limited.filter((match) => match.artifact.state === "shadow"),
    };
  }

  recordEvaluation(input: RuntimeArtifactEvaluationInput): RuntimeArtifact[] {
    const updated: RuntimeArtifact[] = [];
    const now = Date.now();
    const exposedIds = new Set((input.exposedArtifactIds ?? []).map((id) => id.trim()).filter(Boolean));
    const presentedInstinctIds = new Set((input.presentedInstinctIds ?? []).map((id) => id.trim()).filter(Boolean));

    for (const artifactId of input.artifactIds) {
      const artifact = this.storage.getRuntimeArtifact(artifactId);
      if (!artifact) {
        continue;
      }

      // EXPOSURE, not coincidence. A shadow artifact is never rendered into a
      // prompt on its own, so "five clean runs that matched it" said nothing
      // about the guidance — it was promoted for outcomes it never touched
      // (D41 / audit 04.3a). An artifact counts as exposed only when the run
      // was shown it, directly or through the instinct it came from.
      const exposed =
        exposedIds.has(artifact.id) ||
        artifact.sourceInstinctIds.some((instinctId) => presentedInstinctIds.has(instinctId));

      const stats = updateStats(artifact.stats, {
        state: artifact.state,
        exposed,
        verdict: input.verdict,
        blocker: input.blocker,
        failureFingerprint: input.failureFingerprint,
        timestamp: now,
      });

      let state: RuntimeArtifactState = artifact.state;
      let promotedAt = artifact.promotedAt;
      let rejectedAt = artifact.rejectedAt;
      let retiredAt = artifact.retiredAt;
      let lastStateReason = input.reason;

      if (artifact.state === "shadow") {
        const exposureCount = stats.exposureCount ?? 0;
        const cleanRate = exposureCount > 0 ? (stats.exposedCleanCount ?? 0) / exposureCount : 0;
        const repeatedRegression = hasRepeatedRegression(stats);
        const blockerPatternRepeated = input.blocker && input.failureFingerprint
          ? (stats.regressionFingerprints[input.failureFingerprint] ?? 0) > 1
          : false;

        if (stats.harmfulCount >= REJECTION_HARMFUL_THRESHOLD || blockerPatternRepeated) {
          state = "rejected";
          rejectedAt = now;
          lastStateReason = blockerPatternRepeated
            ? `Rejected after repeated blocker fingerprint: ${input.failureFingerprint}`
            : `Rejected after ${stats.harmfulCount} harmful shadow outcomes.`;
        } else if (
          exposureCount >= PROMOTION_MIN_SAMPLES &&
          cleanRate >= PROMOTION_MIN_CLEAN_RATE &&
          stats.blockerCount === 0 &&
          !repeatedRegression
        ) {
          state = "active";
          promotedAt = now;
          lastStateReason = `Promoted after ${exposureCount} shadow runs that were shown the guidance, with ${(cleanRate * 100).toFixed(0)}% clean rate.`;
        }
      } else if (artifact.state === "active") {
        const recent = stats.recentEvaluations.slice(-RETIREMENT_WINDOW);
        const cleanRate = recent.length > 0
          ? recent.filter((item) => item.verdict === "clean").length / recent.length
          : 1;
        const retryCount = recent.filter((item) => item.verdict === "retry" || item.blocker).length;
        if (
          (recent.length >= RETIREMENT_WINDOW && cleanRate < RETIREMENT_MIN_CLEAN_RATE) ||
          retryCount >= RETIREMENT_RETRY_THRESHOLD
        ) {
          state = "retired";
          retiredAt = now;
          lastStateReason = recent.length >= RETIREMENT_WINDOW && cleanRate < RETIREMENT_MIN_CLEAN_RATE
            ? `Retired after clean rate fell to ${(cleanRate * 100).toFixed(0)}% over the last ${recent.length} uses.`
            : `Retired after repeated verifier-triggered replans tied to the artifact.`;
        }
      }

      const closing = state !== artifact.state && (state === "rejected" || state === "retired");
      const nextArtifact: RuntimeArtifact = {
        ...artifact,
        state,
        stats,
        promotedAt,
        rejectedAt,
        retiredAt,
        lastStateReason,
        // LRN-15: what a later re-materialization has to exceed.
        ...(closing
          ? { sourceEvidenceAtClose: this.storage.instinctEvidenceCounts(artifact.sourceInstinctIds) }
          : {}),
        updatedAt: now,
      };
      this.storage.upsertRuntimeArtifact(nextArtifact);
      updated.push(nextArtifact);

      if (input.identityKey) {
        this.recordIdentityArtifactActivity(input.identityKey, artifactId, now);
      }
    }

    return updated;
  }

  getRecentArtifactsForIdentity(identityKey: string, options: {
    states?: readonly RuntimeArtifact["state"][];
    limit?: number;
  } = {}): RuntimeArtifact[] {
    const normalizedIdentityKey = identityKey.trim();
    if (!normalizedIdentityKey) {
      return [];
    }

    const entries = this.recentArtifactActivityByIdentity.get(normalizedIdentityKey) ?? [];
    const uniqueArtifactIds = [...new Set(entries.map((entry) => entry.artifactId))].slice(0, options.limit ?? 12);
    const allowedStates = options.states ? new Set(options.states) : null;
    const artifacts: RuntimeArtifact[] = [];

    for (const artifactId of uniqueArtifactIds) {
      const artifact = this.storage.getRuntimeArtifact(artifactId);
      if (!artifact) {
        continue;
      }
      if (allowedStates && !allowedStates.has(artifact.state)) {
        continue;
      }
      // r11 #1: the identity key is the user id when one is known and the CHAT
      // id otherwise, so a private artifact evaluated in a shared chat used to
      // appear in that chat's activity for everybody. A private artifact is
      // listed only for the identity that owns it.
      if (!runtimeArtifactVisibleTo(artifact, normalizedIdentityKey)) {
        continue;
      }
      artifacts.push(artifact);
    }

    return artifacts;
  }

  private determineArtifactKind(instinct: Instinct): RuntimeArtifactKind {
    if (instinct.type === "tool_usage" || instinct.type === "tool_chain" || instinct.type === "verification") {
      return "workflow";
    }

    if (looksLikeKnowledgePatch(instinct)) {
      return "knowledge_patch";
    }

    return "skill";
  }

  private recordIdentityArtifactActivity(identityKey: string, artifactId: string, timestamp: number): void {
    const history = this.recentArtifactActivityByIdentity.get(identityKey) ?? [];
    const nextHistory = [
      { artifactId, timestamp },
      ...history.filter((entry) => entry.artifactId !== artifactId),
    ].slice(0, 32);
    // Re-insert at the end so this identity becomes most-recently-used (Map keeps
    // insertion order), then evict the coldest keys to bound the map. identityKey
    // is unbounded user/chat cardinality, so without this the map grows forever.
    this.recentArtifactActivityByIdentity.delete(identityKey);
    this.recentArtifactActivityByIdentity.set(identityKey, nextHistory);
    while (this.recentArtifactActivityByIdentity.size > MAX_TRACKED_IDENTITIES) {
      const oldestKey = this.recentArtifactActivityByIdentity.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.recentArtifactActivityByIdentity.delete(oldestKey);
    }
  }

  private inferTaskTypes(instinct: Instinct): TaskType[] {
    switch (instinct.type) {
      case "tool_usage":
      case "tool_chain":
        return ["code-generation", "refactoring", "debugging"];
      case "verification":
        return ["code-review", "analysis", "debugging"];
      case "optimization":
        return ["analysis", "refactoring", "code-generation"];
      case "correction":
        return ["analysis", "code-review", "debugging"];
      case "error_fix":
      default:
        return ["debugging", "code-generation", "refactoring"];
    }
  }

  private buildTaskPatterns(instinct: Instinct): string[] {
    const actionText = extractActionText(instinct.action);
    const tokens = tokenize(`${instinct.name} ${instinct.triggerPattern} ${actionText}`);
    return [...tokens].slice(0, 12);
  }

  private extractRequiredToolNames(instinct: Instinct): string[] {
    const contextTools = instinct.contextConditions
      .filter((condition) => condition.type === "tool_name" && condition.match === "include")
      .map((condition) => condition.value.trim().toLowerCase())
      .filter(Boolean);

    const parsedTools = extractActionToolNames(instinct.action);
    return [...new Set([...contextTools, ...parsedTools])];
  }

  private inferRequiredCapabilities(kind: RuntimeArtifactKind): string[] {
    switch (kind) {
      case "workflow":
        return ["tool-calling"];
      case "knowledge_patch":
        return ["reasoning", "long-context"];
      case "skill":
      default:
        return ["reasoning"];
    }
  }

  private buildDescription(instinct: Instinct, kind: RuntimeArtifactKind): string {
    const actionText = extractActionText(instinct.action);
    switch (kind) {
      case "workflow":
        return `Reusable execution/review workflow for ${instinct.name}. ${actionText}`.trim();
      case "knowledge_patch":
        return `Durable operational knowledge patch for ${instinct.name}. ${actionText}`.trim();
      case "skill":
      default:
        return `Reusable tactic derived from ${instinct.name}. ${actionText}`.trim();
    }
  }

  private buildGuidance(instinct: Instinct, kind: RuntimeArtifactKind): string {
    const actionText = extractActionText(instinct.action);
    const trigger = instinct.triggerPattern.trim();
    switch (kind) {
      case "workflow":
        return `Use this ordered workflow when the task resembles "${trigger}": ${actionText}`;
      case "knowledge_patch":
        return `Apply this factual correction when relevant: ${actionText}`;
      case "skill":
      default:
        return `Preferred tactic for tasks resembling "${trigger}": ${actionText}`;
    }
  }

  private matchArtifact(
    artifact: RuntimeArtifact,
    taskDescription: string,
    taskType: TaskType,
    projectWorldFingerprint: string | undefined,
    availableTools: ReadonlySet<string>,
  ): RuntimeArtifactMatch | null {
    const taskTypeMatched = artifact.taskTypes.includes(taskType);
    const keywordCoverage = scoreKeywordCoverage(taskDescription, artifact.taskPatterns, artifact.description, artifact.guidance);
    const projectWorldMatched = artifact.projectWorldFingerprint
      ? projectScopeMatches(artifact.projectWorldFingerprint, projectWorldFingerprint)
      : false;
    // A KNOWN scope mismatch is a gate, not a missing bonus: guidance learned
    // in another project is the wrong project's guidance, however well its
    // words happen to line up (D41 / audit 04.3b).
    const projectScopeKnown = Boolean(artifact.projectWorldFingerprint) && Boolean(projectWorldFingerprint?.trim());
    if (projectScopeKnown && !projectWorldMatched) {
      return null;
    }
    const toolCoverage = scoreToolCoverage(artifact.requiredToolNames, availableTools);
    const requiredToolsSatisfied = artifact.requiredToolNames.length === 0 || toolCoverage >= 1;
    const matchScore = clamp(
      (taskTypeMatched ? 0.45 : 0.12) +
      keywordCoverage * 0.25 +
      (projectWorldMatched ? 0.15 : 0) +
      // An artifact that needs NO tools earns no tool credit. Scoring the empty
      // requirement as full coverage put 0.45 + 0.15 = 0.60 over the 0.55
      // guidance bar on the task type alone, with zero keyword evidence.
      (artifact.requiredToolNames.length > 0 ? toolCoverage * 0.15 : 0),
    );

    if (matchScore < MATCH_THRESHOLD) {
      return null;
    }

    return {
      artifact,
      matchScore,
      taskTypeMatched,
      projectWorldMatched,
      toolCoverage,
      keywordCoverage,
      requiredToolsSatisfied,
      usableForExecutionGuidance: artifact.state === "active" && requiredToolsSatisfied && matchScore >= GUIDANCE_THRESHOLD,
    };
  }
}

/**
 * The ownership of an artifact that is being re-materialized (r11 #1).
 *
 * An existing artifact is looked up BY its source instinct, so in practice the
 * owner is the same one it already had. When it is not — a merged instinct, a
 * re-owned rule — the reach must not silently WIDEN: two different owners, or an
 * owner replaced by a public source, collapse to 'unknown' so a person decides.
 * Narrowing (public ⇒ a named owner) is always safe.
 */
function mergeOwnership(
  existing: RuntimeArtifact | null,
  incoming: { ownerScope: RuntimeArtifactOwnerScope; ownerUserId?: string },
): { ownerScope: RuntimeArtifactOwnerScope; ownerUserId?: string } {
  if (!existing || existing.ownerScope === undefined) return incoming;
  if (existing.ownerScope === incoming.ownerScope && existing.ownerUserId === incoming.ownerUserId) {
    return incoming;
  }
  if (existing.ownerScope === "public") return incoming;
  if (incoming.ownerScope === "user" && existing.ownerScope === "user" && existing.ownerUserId === incoming.ownerUserId) {
    return incoming;
  }
  return { ownerScope: "unknown" };
}

function createDefaultRuntimeArtifactStats(): RuntimeArtifactStats {
  return {
    shadowSampleCount: 0,
    exposureCount: 0,
    exposedCleanCount: 0,
    activeUseCount: 0,
    cleanCount: 0,
    retryCount: 0,
    failureCount: 0,
    blockerCount: 0,
    harmfulCount: 0,
    recentEvaluations: [],
    regressionFingerprints: {},
  };
}

function updateStats(
  stats: RuntimeArtifactStats,
  input: {
    state: RuntimeArtifactState;
    /** The run was actually shown this artifact's guidance. */
    exposed: boolean;
    verdict: RuntimeArtifactEvaluationInput["verdict"];
    blocker: boolean;
    failureFingerprint?: string;
    timestamp: number;
  },
): RuntimeArtifactStats {
  const regressionFingerprints = { ...stats.regressionFingerprints };
  if (input.failureFingerprint && input.verdict !== "clean") {
    regressionFingerprints[input.failureFingerprint] = (regressionFingerprints[input.failureFingerprint] ?? 0) + 1;
  }

  const recentEvaluations = [
    ...stats.recentEvaluations,
    {
      verdict: input.verdict,
      blocker: input.blocker,
      timestamp: input.timestamp as TimestampMs,
    },
  ].slice(-RETIREMENT_WINDOW);

  const exposedShadowSample = input.exposed && input.state === "shadow";

  return {
    shadowSampleCount: stats.shadowSampleCount + (input.state === "shadow" ? 1 : 0),
    exposureCount: (stats.exposureCount ?? 0) + (exposedShadowSample ? 1 : 0),
    exposedCleanCount:
      (stats.exposedCleanCount ?? 0) + (exposedShadowSample && input.verdict === "clean" ? 1 : 0),
    activeUseCount: stats.activeUseCount + (input.state === "active" ? 1 : 0),
    cleanCount: stats.cleanCount + (input.verdict === "clean" ? 1 : 0),
    retryCount: stats.retryCount + (input.verdict === "retry" ? 1 : 0),
    failureCount: stats.failureCount + (input.verdict === "failure" ? 1 : 0),
    blockerCount: stats.blockerCount + (input.blocker ? 1 : 0),
    harmfulCount: stats.harmfulCount + (input.verdict === "failure" || input.blocker ? 1 : 0),
    lastVerdict: input.verdict,
    lastEvaluatedAt: input.timestamp as TimestampMs,
    lastFailureFingerprint: input.failureFingerprint ?? stats.lastFailureFingerprint,
    recentEvaluations,
    regressionFingerprints,
  };
}

function hasRepeatedRegression(stats: RuntimeArtifactStats): boolean {
  return Object.values(stats.regressionFingerprints).some((count) => count > 1);
}

function scoreKeywordCoverage(
  taskDescription: string,
  taskPatterns: readonly string[],
  description: string,
  guidance: string,
): number {
  const taskTokens = tokenize(taskDescription);
  const artifactTokens = new Set([...taskPatterns, ...tokenize(description), ...tokenize(guidance)]);
  if (taskTokens.size === 0 || artifactTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of taskTokens) {
    if (artifactTokens.has(token)) {
      overlap += 1;
    }
  }
  return clamp(overlap / Math.max(3, Math.min(taskTokens.size, 8)));
}

function scoreToolCoverage(requiredToolNames: readonly string[], availableTools: ReadonlySet<string>): number {
  if (requiredToolNames.length === 0) {
    return 1;
  }
  let matched = 0;
  for (const toolName of requiredToolNames) {
    if (availableTools.has(toolName.trim().toLowerCase())) {
      matched += 1;
    }
  }
  return clamp(matched / requiredToolNames.length);
}

function extractActionText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const direct =
      asTrimmedString(parsed.description)
      ?? asTrimmedString(parsed.action)
      ?? asTrimmedString(parsed.summary)
      ?? asTrimmedString(parsed.instructions);
    if (direct) {
      return direct;
    }
    if (Array.isArray(parsed.steps)) {
      const text = parsed.steps
        .map((step) => typeof step === "string" ? step : asTrimmedString((step as Record<string, unknown>).description))
        .filter((value): value is string => Boolean(value))
        .join("; ");
      if (text) {
        return text;
      }
    }
    if (Array.isArray(parsed.toolSequence)) {
      const text = parsed.toolSequence.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" -> ");
      if (text) {
        return text;
      }
    }
  } catch {
    // Plain-text action; fall through.
  }
  return raw.trim();
}

function extractActionToolNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed.toolSequence)) {
      return parsed.toolSequence.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim().toLowerCase());
    }
    if (Array.isArray(parsed.steps)) {
      return parsed.steps
        .map((step) => typeof step === "string" ? "" : asTrimmedString((step as Record<string, unknown>).tool) ?? asTrimmedString((step as Record<string, unknown>).name) ?? "")
        .filter(Boolean)
        .map((value) => value.toLowerCase());
    }
  } catch {
    // Ignore malformed JSON action payloads.
  }
  return [];
}

function looksLikeKnowledgePatch(instinct: Instinct): boolean {
  const searchable = `${instinct.name} ${instinct.triggerPattern} ${extractActionText(instinct.action)}`.toLowerCase();
  const contextual =
    instinct.contextConditions.some((condition) =>
      condition.type === "project_type" ||
      condition.type === "language" ||
      condition.type === "custom" ||
      condition.type === "tool_name",
    );
  return contextual && /(provider|model|tool|setup|doctor|config|project|workspace|unity|embedding|rag|memory|channel|routing|portal)/.test(searchable);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_+-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function mergeIds<T extends string>(current: readonly T[], incoming: readonly T[]): T[] {
  return [...new Set([...current, ...incoming])];
}

function normalizeArtifactFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 220);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
