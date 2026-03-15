/**
 * SessionSummarizer — LLM-based conversation summarization
 *
 * Uses the configured AI provider to generate structured summaries
 * of conversation sessions. Summaries include narrative text,
 * key decisions, open items, and topic tags.
 *
 * All operations are non-fatal: failures return empty summaries
 * rather than throwing, so callers never need to handle errors.
 */

import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type {
  ConversationMessage,
  MessageContent,
} from "../../agents/providers/provider-core.interface.js";
import type { UserProfileStore } from "./user-profile-store.js";

import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

// =============================================================================
// TYPES
// =============================================================================

export interface SessionSummary {
  /** LLM-generated narrative summary */
  summary: string;
  /** Important decisions made during the session */
  keyDecisions: string[];
  /** Unfinished tasks or open questions */
  openItems: string[];
  /** Main topics discussed */
  topics: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const EMPTY_SUMMARY: Readonly<SessionSummary> = Object.freeze({
  summary: "",
  keyDecisions: [],
  openItems: [],
  topics: [],
});

const SYSTEM_PROMPT = `You are a conversation summarizer. Analyze the following conversation and produce a JSON object with exactly these fields:

{
  "summary": "A concise narrative summary of what was discussed (1-3 sentences)",
  "keyDecisions": ["Array of important decisions made during the conversation"],
  "openItems": ["Array of unfinished tasks, unanswered questions, or next steps"],
  "topics": ["Array of main topic keywords/tags discussed"]
}

Respond ONLY with the JSON object. No additional text or explanation.`;

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class SessionSummarizer {
  constructor(
    private readonly llmProvider: IAIProvider,
    private readonly profileStore: UserProfileStore,
  ) {}

  /**
   * Summarize a conversation session using the LLM.
   *
   * Returns an empty summary if messages is empty or if the LLM call fails.
   * Never throws.
   */
  async summarize(
    _chatId: string,
    messages: ConversationMessage[],
  ): Promise<SessionSummary> {
    if (messages.length === 0) {
      return { ...EMPTY_SUMMARY };
    }

    try {
      const formattedTranscript = this.formatMessages(messages);
      const userMessage: ConversationMessage = {
        role: "user",
        content: formattedTranscript,
      };

      const response = await this.llmProvider.chat(
        SYSTEM_PROMPT,
        [userMessage],
        [],
      );

      return this.parseResponse(response.text);
    } catch (err) {
      getLoggerSafe().warn("Session summarization failed", { error: err });
      return { ...EMPTY_SUMMARY };
    }
  }

  /**
   * Summarize the conversation and persist the result to the user profile store.
   *
   * Profile update failure is non-fatal; the summary is still returned.
   */
  async summarizeAndUpdateProfile(
    chatId: string,
    messages: ConversationMessage[],
  ): Promise<SessionSummary> {
    const summary = await this.summarize(chatId, messages);

    if (summary.summary) {
      try {
        // Append open items to summary so they're preserved for next session context
        let fullSummary = summary.summary;
        if (summary.openItems.length > 0) {
          fullSummary += "\n\nOpen items: " + summary.openItems.join("; ");
        }
        this.profileStore.updateContextSummary(
          chatId,
          fullSummary,
          summary.topics,
        );
      } catch (err) {
        getLoggerSafe().warn("Failed to update profile after summarization", { error: err });
      }
    }

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Format conversation messages into a readable transcript string.
   * Handles both string content and MessageContent[] arrays.
   */
  private formatMessages(messages: ConversationMessage[]): string {
    return messages
      .map((msg) => {
        const role = msg.role === "user" ? "[user]" : "[assistant]";
        const text = this.extractTextContent(msg.content);
        return `${role} ${text}`;
      })
      .join("\n");
  }

  /**
   * Extract plain text from message content.
   * Supports both string content and structured MessageContent[] arrays.
   */
  private extractTextContent(content: string | MessageContent[]): string {
    if (typeof content === "string") {
      return content;
    }

    // Extract text from MessageContent[] — skip non-text blocks
    return content
      .filter((block): block is Extract<MessageContent, { type: "text" }> =>
        block.type === "text",
      )
      .map((block) => block.text)
      .join(" ");
  }

  /**
   * Parse and validate the LLM response into a SessionSummary.
   * Strips markdown code fencing if present.
   * Defaults missing fields to empty arrays.
   */
  private parseResponse(responseText: string): SessionSummary {
    const cleaned = this.stripMarkdownFencing(responseText).trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ...EMPTY_SUMMARY };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { ...EMPTY_SUMMARY };
    }

    const obj = parsed as Record<string, unknown>;

    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      keyDecisions: Array.isArray(obj.keyDecisions) ? obj.keyDecisions : [],
      openItems: Array.isArray(obj.openItems) ? obj.openItems : [],
      topics: Array.isArray(obj.topics) ? obj.topics : [],
    };
  }

  /**
   * Strip markdown code fencing (```json ... ```) from LLM output.
   */
  private stripMarkdownFencing(text: string): string {
    const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
    const match = fencePattern.exec(text.trim());
    return match ? match[1]! : text;
  }
}
