/**
 * Orchestrator Write Gate — standalone function for requesting user confirmation
 * before executing destructive/write tool operations.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 */

import type { IChannelSender } from "../channels/channel-core.interface.js";
import { supportsInteractivity } from "../channels/channel-core.interface.js";

// ─── Functions ────────────────────────────────────────────────────────────────

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
): Promise<boolean> {
  if (!supportsInteractivity(channel)) {
    return false;
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

  return response === "Yes";
}
