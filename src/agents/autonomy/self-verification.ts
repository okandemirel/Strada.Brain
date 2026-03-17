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
import { MUTATION_TOOLS, COMPILABLE_EXT, extractFilePath, isVerificationToolName } from "./constants.js";
import { expandExecutedToolCalls } from "./executed-tools.js";

const VERIFICATION_SHELL_COMMAND_RE = /\b(?:test|build|check|lint|typecheck|verify|compile|tsc|eslint|vitest|jest|pytest)\b/iu;

// ─── State ──────────────────────────────────────────────────────────────────────

export interface VerificationState {
  readonly pendingFiles: ReadonlySet<string>;
  readonly hasCompilableChanges: boolean;
  readonly lastBuildOk: boolean | null;
}

// ─── Verifier ───────────────────────────────────────────────────────────────────

export class SelfVerification {
  private pendingFiles = new Set<string>();
  private hasCompilableChanges = false;
  private lastBuildOk: boolean | null = null;

  /** Reset for new task. */
  reset(): void {
    this.pendingFiles = new Set();
    this.hasCompilableChanges = false;
    this.lastBuildOk = null;
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
        if (ok) {
          this.pendingFiles.clear();
          this.hasCompilableChanges = false;
        }
      }
    }
  }

  /**
   * Check if verification is needed before exit. O(1).
   */
  needsVerification(): boolean {
    return this.hasCompilableChanges && this.lastBuildOk !== true;
  }

  /**
   * Build a verification reminder message.
   * Only called when needsVerification() is true (rare path).
   */
  getPrompt(): string {
    const files = [...this.pendingFiles];
    const shown = files.slice(0, 8);
    const rest = files.length - shown.length;
    return (
      `[VERIFICATION REQUIRED] You modified compilable files without verifying:\n` +
      shown.map(f => `  - ${f}`).join("\n") +
      (rest > 0 ? `\n  ... and ${rest} more` : "") +
      `\nRun the most relevant verification tool or command before declaring the task complete.`
    );
  }

  /** Read-only state snapshot for testing. */
  getState(): VerificationState {
    return {
      pendingFiles: new Set(this.pendingFiles),
      hasCompilableChanges: this.hasCompilableChanges,
      lastBuildOk: this.lastBuildOk,
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
