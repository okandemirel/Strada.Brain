/**
 * Session history trimming, extracted from SessionManager.trimSession so the
 * baselined session manager does not grow (docs/contracts/file-size.md).
 */

import type { ConversationMessage } from "./providers/provider.interface.js";
import type { AssistantMessage } from "./providers/provider-core.interface.js";
import { getLogger } from "../utils/logger.js";

/** The part of a Session that trimming reads and rewrites. */
export interface TrimmableSession {
  messages: ConversationMessage[];
  visibleMessages?: ConversationMessage[];
}

/**
 * A surviving conversation must START on a message the provider accepts:
 * a user turn that is not an orphaned tool result. Anthropic and OpenAI
 * both reject a history whose first message is an assistant turn, or whose
 * `tool_result` has no preceding `tool_use` — with a 400, not a warning.
 */
function isValidHead(msg: ConversationMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return true;
  // Multimodal user turns (images/documents) are fine; a tool_result block
  // is not, because its matching tool_use has just been trimmed away.
  return !(Array.isArray(msg.content)
    && msg.content.some((b) => (b as { type?: string })?.type === "tool_result"));
}

/** Removed messages leave the visible transcript too. */
function dropFromVisible(session: TrimmableSession, removed: ConversationMessage[]): ConversationMessage[] {
  if (removed.length > 0 && session.visibleMessages?.length) {
    const removedSet = new Set(removed);
    session.visibleMessages = session.visibleMessages.filter((message) => !removedSet.has(message));
  }
  return removed;
}

/**
 * Trim session history to keep context manageable.
 * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
 * Returns the trimmed (removed) messages for persistence.
 */
export function trimSessionMessages(session: TrimmableSession, maxMessages: number): ConversationMessage[] {
  if (session.messages.length <= maxMessages) return [];

  const overflow = session.messages.length - maxMessages;

  const trimMessages = (count: number): ConversationMessage[] => {
    const allRemoved = session.messages.splice(0, count);
    // Repair the head after ANY trim. The safe-boundary path above already
    // lands on a valid user turn so this is a no-op there, but the hard-cap
    // fallbacks below cut at an arbitrary index and previously left the
    // session permanently un-sendable: the trim is persisted, so every later
    // request in that session repeated the same 400.
    while (session.messages.length > 0 && !isValidHead(session.messages[0]!)) {
      allRemoved.push(session.messages.shift()!);
    }
    return dropFromVisible(session, allRemoved);
  };

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
    return trimMessages(trimTo);
  }

  // Fallback: if no safe boundary found and session exceeds hard cap (2x max),
  // force trim at the oldest complete tool pair boundary to prevent unbounded growth
  const hardCap = maxMessages * 2;
  if (session.messages.length > hardCap) {
    getLogger().warn("Session exceeds hard cap, force-trimming", {
      size: session.messages.length,
      hardCap,
    });
    // Keep the task turn — the first message a history may start on — and drop the
    // oldest whole turns after it, cutting just before an assistant turn so every
    // kept tool_result still follows its tool_use. Cutting at the overflow index
    // instead left a tool_result head that the repair shifted off, then the
    // assistant turn, and so on until a pure tool loop had no history at all
    // (board #30): the next call carried neither the task nor the tool results.
    const anchor = session.messages.findIndex(isValidHead);
    if (anchor >= 0) {
      const firstKept = Math.max(session.messages.length - (maxMessages - 1), anchor + 1);
      for (let cut = firstKept; cut < session.messages.length; cut++) {
        if (session.messages[cut]!.role !== "assistant") continue;
        // In place, like trimMessages: callers hold this array, not the session.
        const between = session.messages.splice(anchor + 1, cut - anchor - 1);
        const before = session.messages.splice(0, anchor);
        return dropFromVisible(session, [...before, ...between]);
      }
    }
    // Last resort (no task turn, or no assistant turn to cut before): trim at
    // overflow. trimMessages repairs the head, so this never orphans a tool_result.
    return trimMessages(overflow);
  }

  return [];
}
