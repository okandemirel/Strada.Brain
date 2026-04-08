/**
 * Self-Verification Framework
 *
 * Tracks file mutations and verification state to ensure code changes
 * are always validated before the agent declares a task complete.
 *
 * Performance:
 *   - All operations O(1) per call via Set membership checks
 *   - File extension check: O(1) via Set.has() on extracted suffix
 *   - No iteration over pending files unless building the prompt
 */

import type { ToolResult } from "../providers/provider.interface.js";
import { sanitizePromptInjection } from "../orchestrator-text-utils.js";
import { MUTATION_TOOLS, COMPILABLE_EXT, extractFilePath, isVerificationToolName } from "./constants.js";
import { expandExecutedToolCalls } from "./executed-tools.js";
import type { WorkerRunResult } from "../supervisor/supervisor-types.js";

const VERIFICATION_SHELL_COMMAND_RE = /\b(?:test|build|check|lint|typecheck|verify|compile|tsc|eslint|vitest|jest|pytest)\b/iu;

// ─── State ──────────────────────────────────────────────────────────────────────

export interface VerificationState {
  readonly pendingFiles: ReadonlySet<string>;
  readonly touchedFiles: ReadonlySet<string>;
  readonly hasCompilableChanges: boolean;
  readonly lastBuildOk: boolean | null;
  readonly lastVerificationAt: number | null;
  readonly unityConsoleErrors: readonly string[];
  readonly unityErrorResolutionAttempts: number;
}

// ─── Verifier ───────────────────────────────────────────────────────────────────

export class SelfVerification {
  private pendingFiles = new Set<string>();
  private touchedFiles = new Set<string>();
  private hasCompilableChanges = false;
  private lastBuildOk: boolean | null = null;
  private lastVerificationAt: number | null = null;
  private unityConsoleErrors: string[] = [];
  private unityErrorResolutionAttempts = 0;
  private static readonly MAX_UNITY_ERROR_ATTEMPTS = 10;

  /** Reset for new task. */
  reset(): void {
    this.pendingFiles = new Set();
    this.touchedFiles = new Set();
    this.hasCompilableChanges = false;
    this.lastBuildOk = null;
    this.lastVerificationAt = null;
    this.unityConsoleErrors = [];
    this.unityErrorResolutionAttempts = 0;
  }

  /**
   * Track a tool execution. O(1).
   */
  track(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
  ): void {
    for (const executedTool of expandExecutedToolCalls(toolName, input, result)) {
      // Track mutations — O(1) set add + extension check
      if (MUTATION_TOOLS.has(executedTool.toolName)) {
        const file = extractFilePath(executedTool.input);
        if (file) {
          this.pendingFiles.add(file);
          this.touchedFiles.add(file);
          const dotIdx = file.lastIndexOf(".");
          if (dotIdx !== -1 && COMPILABLE_EXT.has(file.slice(dotIdx))) {
            this.hasCompilableChanges = true;
          }
        }
      }

      // Track build results — O(1)
      if (isVerificationTool(executedTool.toolName, executedTool.input)) {
        const ok = !executedTool.isError;
        this.lastBuildOk = ok;
        this.lastVerificationAt = Date.now();
        if (ok) {
          this.pendingFiles.clear();
          this.hasCompilableChanges = false;
        }
      }

      // Parse Unity console errors from verification results
      if (
        executedTool.toolName === "unity_verify_change" ||
        executedTool.toolName === "unity_compile_status" ||
        executedTool.toolName === "unity_compile_wait" ||
        executedTool.toolName === "unity_console_read" ||
        executedTool.toolName === "unity_console_analyze"
      ) {
        const content = typeof result.content === "string" ? result.content : "";
        this.parseUnityConsoleErrors(content);
      }
    }
  }

  /**
   * Check if verification is needed before exit. O(1).
   */
  needsVerification(): boolean {
    return (this.hasCompilableChanges && this.lastBuildOk !== true) || this.hasUnresolvedUnityErrors();
  }

  /** Check if there are unresolved Unity console errors. */
  hasUnresolvedUnityErrors(): boolean {
    return this.unityConsoleErrors.length > 0
      && this.unityErrorResolutionAttempts < SelfVerification.MAX_UNITY_ERROR_ATTEMPTS;
  }

  /** Get current Unity console errors for injection into prompts. */
  getUnityConsoleErrors(): readonly string[] {
    return this.unityConsoleErrors;
  }

  /** Get Unity error attempt count. */
  getUnityErrorAttempts(): number {
    return this.unityErrorResolutionAttempts;
  }

  /**
   * Parse Unity console output for errors.
   * Matches CS error codes, CompilerError, and positional error lines.
   */
  private parseUnityConsoleErrors(content: string): void {
    const errorSet = new Set<string>();
    const patterns = [
      /^.*error\s+CS\d+:.*$/gim,
      /^.*CompilerError:.*$/gim,
      /^.*\(\d+,\d+\):\s*error\b.*$/gim,
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        for (const m of matches) {
          const line = m.trim();
          if (line) errorSet.add(sanitizePromptInjection(line));
        }
      }
    }

    if (errorSet.size > 0) {
      const newErrors = [...errorSet];
      // Only increment attempts when new errors differ from previous (avoid double-counting
      // when multiple verification tools report the same errors in the same pass)
      const changed = newErrors.length !== this.unityConsoleErrors.length ||
        newErrors.some((e, i) => e !== this.unityConsoleErrors[i]);
      if (changed) {
        this.unityErrorResolutionAttempts++;
      }
      this.unityConsoleErrors = newErrors;
    } else if (
      content.includes("0 errors") ||
      content.includes("Build succeeded") ||
      content.includes("Compilation successful") ||
      content.includes("Compile succeeded") ||
      content.includes("No errors")
    ) {
      // Explicit success signal — clear errors
      this.unityConsoleErrors = [];
      this.unityErrorResolutionAttempts = 0;
    } else if (this.unityConsoleErrors.length > 0 && content.length > 0) {
      // Ambiguous output (no errors found, no success signal) — increment attempt
      // to avoid freezing on stale errors from connection issues or format changes
      this.unityErrorResolutionAttempts++;
    }
  }

  hasTouchedFiles(): boolean {
    return this.touchedFiles.size > 0;
  }

  ingestWorkerResult(result: WorkerRunResult): void {
    for (const file of result.touchedFiles) {
      this.touchedFiles.add(file);
      const dotIdx = file.lastIndexOf(".");
      if (dotIdx !== -1 && COMPILABLE_EXT.has(file.slice(dotIdx))) {
        this.hasCompilableChanges = true;
      }
    }

    const hasVerificationIssues = result.verificationResults.some(
      (entry) => entry.status === "issues",
    );
    const hasReviewErrors = result.reviewFindings.some(
      (finding) => finding.severity === "error",
    );

    if (hasVerificationIssues || hasReviewErrors || result.status !== "completed") {
      for (const file of result.touchedFiles) {
        this.pendingFiles.add(file);
      }
      this.lastBuildOk = false;
      return;
    }

    if (result.touchedFiles.length > 0) {
      this.lastVerificationAt = Date.now();
    }
  }

  /**
   * Build a verification reminder message.
   * Only called when needsVerification() is true (rare path).
   */
  getPrompt(): string {
    const files = [...this.pendingFiles];
    const shown = files.slice(0, 8);
    const rest = files.length - shown.length;
    const hasCsFiles = files.some(f => {
      const dotIdx = f.lastIndexOf(".");
      return dotIdx !== -1 && COMPILABLE_EXT.has(f.slice(dotIdx));
    });

    const lines: string[] = [
      `[VERIFICATION REQUIRED] You modified compilable files without verifying:`,
      ...shown.map(f => `  - ${f}`),
    ];
    if (rest > 0) lines.push(`  ... and ${rest} more`);

    if (this.unityConsoleErrors.length > 0) {
      lines.push(
        `\n[UNITY CONSOLE ERRORS - Attempt ${this.unityErrorResolutionAttempts}/${SelfVerification.MAX_UNITY_ERROR_ATTEMPTS}]`,
        `Unity console still has ${this.unityConsoleErrors.length} error(s):`,
        ...this.unityConsoleErrors.slice(0, 5).map(e => `  ✗ ${e}`),
      );
      if (this.unityConsoleErrors.length > 5) {
        lines.push(`  ... and ${this.unityConsoleErrors.length - 5} more`);
      }
      lines.push(`Fix these errors and run unity_verify_change again. Do NOT declare DONE until Unity console is clean.`);
    } else {
      lines.push(
        hasCsFiles
          ? `\nUse unity_verify_change (preferred when bridge is connected) or dotnet_build to verify compilation and check Unity console for errors.`
          : `\nRun the most relevant verification tool or command before declaring the task complete.`,
      );
    }

    return lines.join("\n");
  }

  /** Read-only state snapshot for testing. */
  getState(): VerificationState {
    return {
      pendingFiles: new Set(this.pendingFiles),
      touchedFiles: new Set(this.touchedFiles),
      hasCompilableChanges: this.hasCompilableChanges,
      lastBuildOk: this.lastBuildOk,
      lastVerificationAt: this.lastVerificationAt,
      unityConsoleErrors: [...this.unityConsoleErrors],
      unityErrorResolutionAttempts: this.unityErrorResolutionAttempts,
    };
  }
}

function isVerificationTool(toolName: string, input: Record<string, unknown>): boolean {
  if (isVerificationToolName(toolName)) {
    return true;
  }
  if (toolName !== "shell_exec") {
    return false;
  }

  const command = typeof input["command"] === "string" ? input["command"].trim() : "";
  return command.length > 0 && VERIFICATION_SHELL_COMMAND_RE.test(command);
}
