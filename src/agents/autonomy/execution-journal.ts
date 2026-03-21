import { AgentPhase, type AgentState, type StepResult } from "../agent-state.js";
import type { PhaseOutcomeStatus } from "../../agent-core/routing/routing-types.js";
import type { ToolCall, ToolResult } from "../providers/provider.interface.js";
import type { VerifierPipelineResult } from "./verifier-pipeline.js";
import type { LoopRecoveryBrief, LoopRecoveryDecisionKind } from "./loop-recovery-review.js";

type JournalEntryKind =
  | "plan"
  | "tool-batch"
  | "reflection"
  | "verifier"
  | "rollback"
  | "loop-recovery"
  | "delegated-diagnosis";

interface JournalEntry {
  readonly kind: JournalEntryKind;
  readonly branchId: string;
  readonly summary: string;
  readonly phase?: AgentPhase;
  readonly providerName?: string;
  readonly modelId?: string;
  readonly timestamp: number;
}

interface JournalBranch {
  readonly id: string;
  readonly parentId: string | null;
  readonly openedAt: number;
  readonly trigger: string;
  readonly rollbackTo: string | null;
}

interface StrategyFailureMemory {
  readonly fingerprint: string;
  readonly failures: number;
  readonly lastReason: string;
  readonly lastSeenAt: number;
}

export interface ExecutionJournalSnapshot {
  branchSummary?: string;
  verifierSummary?: string;
  learnedInsights: string[];
}

const MAX_ENTRIES = 120;
const MAX_FAILURES = 6;

export class ExecutionJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly branches = new Map<string, JournalBranch>();
  private readonly strategyFailures = new Map<string, StrategyFailureMemory>();
  private currentBranchId = "root";
  private branchCounter = 0;
  private lastStableCheckpoint: string | null = null;
  private lastVerifierSummary: string | null = null;
  private lastRequiredActions: readonly string[] = [];
  private projectWorldSummary: string | null = null;
  private projectWorldFingerprint: string | null = null;
  private readonly learnedInsights = new Set<string>();
  private readonly recentUserFacingProgress: string[] = [];
  private readonly recentRecoveryNotes: string[] = [];

  constructor(taskDescription: string) {
    this.branches.set("root", {
      id: "root",
      parentId: null,
      openedAt: Date.now(),
      trigger: summarizeText(taskDescription, 180),
      rollbackTo: null,
    });
  }

  recordPlan(
    plan: string | null | undefined,
    phase: AgentPhase,
    providerName?: string,
    modelId?: string,
  ): void {
    const summary = summarizeText(plan, 240);
    if (!summary) {
      return;
    }
    this.pushEntry({
      kind: "plan",
      branchId: this.currentBranchId,
      summary,
      phase,
      providerName,
      modelId,
      timestamp: Date.now(),
    });
  }

  recordToolBatch(params: {
    phase: AgentPhase;
    toolCalls: readonly ToolCall[];
    toolResults: readonly ToolResult[];
    providerName?: string;
    modelId?: string;
  }): void {
    if (params.toolCalls.length === 0 || params.toolResults.length === 0) {
      return;
    }

    const summary = params.toolCalls
      .map((call, index) => {
        const result = params.toolResults[index];
        if (!result) {
          return null;
        }
        return `${result.isError ? "FAIL" : "OK"} ${call.name}: ${summarizeText(result.content, 120)}`;
      })
      .filter(Boolean)
      .slice(0, 4)
      .join(" | ");

    if (!summary) {
      return;
    }

    this.pushEntry({
      kind: "tool-batch",
      branchId: this.currentBranchId,
      summary,
      phase: params.phase,
      providerName: params.providerName,
      modelId: params.modelId,
      timestamp: Date.now(),
    });
  }

  recordReflection(
    decision: "CONTINUE" | "REPLAN" | "DONE" | "DONE_WITH_SUGGESTIONS",
    text: string | null | undefined,
    providerName?: string,
    modelId?: string,
  ): void {
    const summary = `${decision}: ${summarizeText(text, 180) || "no reflection details"}`;
    this.pushEntry({
      kind: "reflection",
      branchId: this.currentBranchId,
      summary,
      phase: AgentPhase.REFLECTING,
      providerName,
      modelId,
      timestamp: Date.now(),
    });
  }

  recordVerifierResult(
    result: VerifierPipelineResult,
    providerName?: string,
    modelId?: string,
  ): void {
    this.lastVerifierSummary = result.summary;
    this.lastRequiredActions = extractRequiredActions(result.gate);

    if (result.decision === "approve") {
      this.lastStableCheckpoint = result.summary;
    } else {
      this.learnedInsights.add(`Verifier pipeline: ${result.summary}`);
      for (const action of this.lastRequiredActions.slice(0, 3)) {
        this.learnedInsights.add(action);
      }
    }

    this.pushEntry({
      kind: "verifier",
      branchId: this.currentBranchId,
      summary: `${result.decision.toUpperCase()}: ${result.summary}`,
      providerName,
      modelId,
      timestamp: Date.now(),
    });
  }

  recordPhaseOutcome(params: {
    phase: string;
    status: PhaseOutcomeStatus;
    reason: string;
  }): void {
    if (params.status === "approved") {
      this.lastStableCheckpoint = `${params.phase}: ${summarizeText(params.reason, 160)}`;
      return;
    }
    if (params.status === "replanned" || params.status === "failed" || params.status === "blocked") {
      this.learnedInsights.add(`${params.phase}: ${summarizeText(params.reason, 160)}`);
    }
  }

  attachProjectWorldContext(params: {
    summary: string;
    fingerprint: string;
  }): void {
    const summary = summarizeText(params.summary, 220);
    const fingerprint = summarizeText(params.fingerprint, 220);
    if (!summary || !fingerprint) {
      return;
    }
    this.projectWorldSummary = summary;
    this.projectWorldFingerprint = fingerprint;
  }

  beginReplan(params: {
    state: AgentState;
    reason: string;
    providerName?: string;
    modelId?: string;
  }): void {
    const failedApproach = summarizeApproach(params.state);
    const fingerprint = fingerprintApproach([
      this.projectWorldFingerprint ? `world=${this.projectWorldFingerprint}` : null,
      failedApproach,
    ].filter(Boolean).join(" | "));
    const existing = this.strategyFailures.get(fingerprint);
    const failures = Math.min(MAX_FAILURES, (existing?.failures ?? 0) + 1);
    this.strategyFailures.set(fingerprint, {
      fingerprint: [
        this.projectWorldSummary ? `world=${this.projectWorldSummary}` : null,
        failedApproach,
      ].filter(Boolean).join(" | "),
      failures,
      lastReason: summarizeText(params.reason, 200) || "replan requested",
      lastSeenAt: Date.now(),
    });

    this.learnedInsights.add(`Avoid repeating this failed path: ${failedApproach}`);
    this.learnedInsights.add(`Replan trigger: ${summarizeText(params.reason, 160) || "internal verifier requested a new approach"}`);
    if (this.projectWorldSummary) {
      this.learnedInsights.add(`Project/world anchor: ${this.projectWorldSummary}`);
    }

    const branchId = `branch-${++this.branchCounter}`;
    this.branches.set(branchId, {
      id: branchId,
      parentId: this.currentBranchId,
      openedAt: Date.now(),
      trigger: summarizeText(params.reason, 200) || "replan",
      rollbackTo: this.lastStableCheckpoint,
    });
    this.currentBranchId = branchId;

    this.pushEntry({
      kind: "rollback",
      branchId,
      summary: `Replan branch opened. Failed path: ${failedApproach}`,
      phase: AgentPhase.REPLANNING,
      providerName: params.providerName,
      modelId: params.modelId,
      timestamp: Date.now(),
    });
  }

  getLearnedInsights(): string[] {
    return [...this.learnedInsights].slice(-8);
  }

  recordUserFacingProgress(summary: string): void {
    const normalized = summarizeText(summary, 180);
    if (!normalized) {
      return;
    }
    this.recentUserFacingProgress.push(normalized);
    if (this.recentUserFacingProgress.length > 6) {
      this.recentUserFacingProgress.splice(0, this.recentUserFacingProgress.length - 6);
    }
  }

  recordLoopRecoveryEpisode(params: {
    fingerprint: string;
    decision: LoopRecoveryDecisionKind;
    summary: string;
  }): void {
    const line = `[${params.decision}] ${summarizeText(params.summary, 200) || params.fingerprint}`;
    this.recentRecoveryNotes.push(line);
    if (this.recentRecoveryNotes.length > 4) {
      this.recentRecoveryNotes.splice(0, this.recentRecoveryNotes.length - 4);
    }
    this.learnedInsights.add(`Avoid repeating loop fingerprint: ${params.fingerprint}`);
    this.learnedInsights.add(`Recovery decision: ${line}`);
    this.pushEntry({
      kind: "loop-recovery",
      branchId: this.currentBranchId,
      summary: `${params.fingerprint} -> ${line}`,
      phase: AgentPhase.REFLECTING,
      timestamp: Date.now(),
    });
  }

  recordDelegatedDiagnosis(type: string, summary: string): void {
    const normalized = summarizeText(summary, 220);
    if (!normalized) {
      return;
    }
    this.learnedInsights.add(`Delegated ${type} diagnosis: ${normalized}`);
    this.pushEntry({
      kind: "delegated-diagnosis",
      branchId: this.currentBranchId,
      summary: `${type}: ${normalized}`,
      phase: AgentPhase.REPLANNING,
      timestamp: Date.now(),
    });
  }

  buildRecoveryBrief(params: {
    fingerprint: string;
    latestReason?: string;
    touchedFiles?: readonly string[];
    recoveryEpisode: number;
    availableDelegations: readonly string[];
  }): LoopRecoveryBrief {
    const recentToolSummaries = this.entries
      .filter((entry) => entry.kind === "tool-batch")
      .slice(-3)
      .map((entry) => entry.summary);
    return {
      fingerprint: params.fingerprint,
      latestReason: params.latestReason,
      verifierSummary: this.lastVerifierSummary ?? undefined,
      requiredActions: [...this.lastRequiredActions].slice(0, 4),
      recentToolSummaries,
      touchedFiles: [...(params.touchedFiles ?? [])].slice(0, 5),
      recentUserFacingProgress: [...this.recentUserFacingProgress].slice(-3),
      recoveryEpisode: params.recoveryEpisode,
      availableDelegations: [...params.availableDelegations],
    };
  }

  snapshot(): ExecutionJournalSnapshot {
    const branch = this.branches.get(this.currentBranchId);
    const branchSummary = branch
      ? [
          `Branch ${branch.id}`,
          branch.parentId ? `parent ${branch.parentId}` : "",
          this.lastStableCheckpoint ? `stable checkpoint: ${this.lastStableCheckpoint}` : "",
          this.projectWorldSummary ? `world anchor: ${this.projectWorldSummary}` : "",
        ].filter(Boolean).join(" | ")
      : undefined;

    return {
      branchSummary,
      verifierSummary: this.lastVerifierSummary ?? undefined,
      learnedInsights: this.getLearnedInsights(),
    };
  }

  buildPromptSection(phase: AgentPhase): string {
    const lines: string[] = [];

    const branch = this.branches.get(this.currentBranchId);
    if (branch) {
      lines.push(`Current branch: ${branch.id}`);
      if (branch.parentId) {
        lines.push(`Parent branch: ${branch.parentId}`);
      }
    }
    if (this.projectWorldSummary) {
      lines.push(`Project/world anchor: ${this.projectWorldSummary}`);
    }

    if (phase === AgentPhase.REPLANNING) {
      if (this.lastStableCheckpoint) {
        lines.push(`Last stable checkpoint: ${this.lastStableCheckpoint}`);
      }
      if (this.lastVerifierSummary) {
        lines.push(`Latest verifier result: ${this.lastVerifierSummary}`);
      }
      const exhausted = this.getTopFailedStrategies();
      if (exhausted.length > 0) {
        lines.push("Avoid repeating exhausted strategies:");
        for (const item of exhausted) {
          lines.push(`- ${item}`);
        }
      }
      if (this.lastRequiredActions.length > 0) {
        lines.push("Required verifier actions:");
        for (const action of this.lastRequiredActions.slice(0, 4)) {
          lines.push(`- ${action}`);
        }
      }
      if (this.recentRecoveryNotes.length > 0) {
        lines.push("Recent loop recovery notes:");
        for (const note of this.recentRecoveryNotes.slice(-3)) {
          lines.push(`- ${note}`);
        }
      }
    } else if (phase === AgentPhase.EXECUTING || phase === AgentPhase.REFLECTING) {
      if (this.lastVerifierSummary) {
        lines.push(`Verifier memory: ${this.lastVerifierSummary}`);
      }
      const recent = this.entries.slice(-3).map((entry) => `- ${entry.summary}`);
      if (recent.length > 0) {
        lines.push("Recent execution memory:");
        lines.push(...recent);
      }
      if (this.recentRecoveryNotes.length > 0) {
        lines.push("Loop recovery memory:");
        for (const note of this.recentRecoveryNotes.slice(-2)) {
          lines.push(`- ${note}`);
        }
      }
    }

    if (lines.length === 0) {
      return "";
    }

    return `\n\n## Execution Journal\n${lines.join("\n")}\n`;
  }

  private getTopFailedStrategies(): string[] {
    return [...this.strategyFailures.values()]
      .sort((left, right) => right.failures - left.failures || right.lastSeenAt - left.lastSeenAt)
      .slice(0, 3)
      .map((entry) => `${entry.fingerprint} (failed ${entry.failures}x; last reason: ${entry.lastReason})`);
  }

  private pushEntry(entry: JournalEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }
}

function summarizeApproach(state: AgentState): string {
  const recentSteps = state.stepResults.slice(-4).map(formatStepResult);
  const plan = summarizeText(state.plan, 120);
  const reflection = summarizeText(state.lastReflection, 120);
  return [
    plan ? `plan=${plan}` : null,
    reflection ? `reflection=${reflection}` : null,
    recentSteps.length > 0 ? `steps=${recentSteps.join(" -> ")}` : null,
  ].filter(Boolean).join(" | ") || "unclassified failed approach";
}

function formatStepResult(step: StepResult): string {
  return `${step.toolName}:${step.success ? "ok" : "fail"}`;
}

function fingerprintApproach(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 220);
}

function summarizeText(text: string | null | undefined, maxLength: number): string {
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractRequiredActions(gate: string | undefined): string[] {
  if (!gate) {
    return [];
  }
  const lines = gate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  return lines.slice(0, 6);
}
