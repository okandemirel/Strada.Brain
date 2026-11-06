/**
 * The text of a conversation as memory stores it: one "[role] text" line per
 * message for the transcript, and a short preview of one message for the
 * structured fields. Extracted from orchestrator-session-manager.ts
 * (storeSessionInMemory), which is past the file-size limit
 * (docs/contracts/file-size.md).
 */

import type { ConversationMessage } from "./providers/provider.interface.js";
import type { MessageContent } from "./providers/provider-core.interface.js";

/** One "[role] text" line per message; a message with no text is named, not dropped. */
export function conversationTranscript(messages: readonly ConversationMessage[]): string {
  return messages
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
}

/** The first 500 characters of a message's text; undefined when there is no message or no text. */
export function messageTextPreview(msg: ConversationMessage | undefined): string | undefined {
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
}
