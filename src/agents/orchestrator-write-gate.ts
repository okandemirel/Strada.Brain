/**
 * Orchestrator Write Gate — standalone function for requesting user confirmation
 * before executing destructive/write tool operations.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 */

import type { IChannelSender } from "../channels/channel-core.interface.js";
import { supportsInteractivity } from "../channels/channel-core.interface.js";

// ─── Functions ────────────────────────────────────────────────────────────────

const CONTENT_FIELDS = ["content", "new_string", "new_text", "text", "body", "data"] as const;
const OLD_FIELDS = ["old_string", "old_text"] as const;

function lineCount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

/**
 * How many lines a write would change, derived from the tool input.
 *
 * audited 2026-09-02: the confirmation gate used to hand DMPolicy a stub diff
 * with `totalChanges: 1`, so the SMART line threshold compared 1 >= 50 on every
 * write ever made and could never fire. This derives a real count where one
 * exists and says `known: false` where it does not, so the caller can treat
 * an unmeasurable write as exceeding the threshold rather than as one line.
 */
export function estimateWriteChangeLines(
  toolName: string,
  input: Record<string, unknown>,
): { totalChanges: number; known: boolean } {
  if (toolName === "batch_execute") {
    const ops = Array.isArray(input["operations"]) ? (input["operations"] as unknown[]) : [];
    let total = 0;
    for (const op of ops) {
      if (typeof op !== "object" || op === null) return { totalChanges: 0, known: false };
      const rec = op as Record<string, unknown>;
      const nested = estimateWriteChangeLines(
        String(rec["tool"] ?? ""),
        (typeof rec["input"] === "object" && rec["input"] !== null ? rec["input"] : {}) as Record<string, unknown>,
      );
      if (!nested.known) return { totalChanges: 0, known: false };
      total += nested.totalChanges;
    }
    return { totalChanges: total, known: ops.length > 0 };
  }
  if (toolName === "file_delete" || toolName === "file_delete_directory" || toolName === "file_rename") {
    // Destructive by classification; the prompt fires on that, not on size.
    return { totalChanges: 0, known: true };
  }
  let newest: number | null = null;
  for (const field of CONTENT_FIELDS) {
    const n = lineCount(input[field]);
    if (n !== null) { newest = n; break; }
  }
  if (newest === null) return { totalChanges: 0, known: false };
  let oldest = 0;
  for (const field of OLD_FIELDS) {
    const n = lineCount(input[field]);
    if (n !== null) { oldest = n; break; }
  }
  return { totalChanges: Math.max(newest, oldest), known: true };
}

/** Tri-state so callers can tell a human "No" from "no human was reachable". */
export type WriteConfirmationOutcome = "approved" | "denied" | "unavailable";

export async function requestWriteConfirmation(
  // Typed as the minimal IChannelSender: the gate relies entirely on the
  // runtime `supportsInteractivity` guard below to widen to the interactive
  // surface, so it never touches an IChannelAdapter-only member. Accepting the
  // narrower type lets non-adapter callers (e.g. CommandHandler) reuse it.
  channel: IChannelSender,
  chatId: string,
  userId: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): Promise<WriteConfirmationOutcome> {
  if (!supportsInteractivity(channel)) {
    return "unavailable";
  }

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
    case "batch_execute": {
      // audited 2026-09-02: a batch used to fall to the default and ask
      // "Confirm file edit: unknown?" — the human could not see what they
      // were approving. Name the operations.
      const ops = Array.isArray(input["operations"]) ? (input["operations"] as unknown[]) : [];
      const names = ops
        .map((op) => (typeof op === "object" && op !== null ? String((op as Record<string, unknown>)["tool"] ?? "?") : "?"));
      const counts = new Map<string, number>();
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
      const summary = Array.from(counts.entries()).map(([n, c]) => `${c}× ${n}`).join(", ");
      question = `Confirm batch of ${ops.length} operation${ops.length === 1 ? "" : "s"} (${summary || "unreadable"})?`;
      details = `Running batch_execute: ${summary || "operations could not be read"}`;
      break;
    }
    default: {
      const path = String(input["path"] ?? "unknown");
      question = `Confirm file ${toolName === "file_write" ? "create/overwrite" : "edit"}: \`${path}\`?`;
      details = toolName === "file_edit" ? `Replacing text in ${path}` : `Writing to ${path}`;
    }
  }

  const response = await channel.requestConfirmation({
    chatId,
    userId,
    question,
    options: ["Yes", "No"],
    details,
  });

  if (response === "Yes") return "approved";
  // A confirmation that timed out (e.g. the web portal tab was closed, so no
  // client ever saw the question) is NOT a human saying no — reporting it as
  // "cancelled by user" was a lie that also read as non-retryable guidance.
  if (response === "timeout") return "unavailable";
  return "denied";
}
