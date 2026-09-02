/**
 * Orchestrator Write Gate — standalone function for requesting user confirmation
 * before executing destructive/write tool operations.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 */

import type { IChannelSender } from "../channels/channel-core.interface.js";
import { supportsInteractivity } from "../channels/channel-core.interface.js";

// ─── Functions ────────────────────────────────────────────────────────────────

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
