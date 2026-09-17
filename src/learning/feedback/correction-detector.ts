/**
 * Correction Detector
 *
 * Detects a user correcting the agent in natural language. Consulted by the
 * orchestrator's message path, next to the teaching-intent check.
 *
 * audit 04.cap (2026-09-17): this class had NO production caller — corrections
 * were detected nowhere and learned never. It also carried isFileCorrection(),
 * which needed a log of agent tool-execution windows (timestamp/endTimestamp)
 * that nothing in the codebase produces: uncallable by construction, so it was
 * removed rather than left looking implemented. Re-add it WITH its producer if
 * file-level correction detection is wanted.
 */

/** One turn of the conversation, as the session stores it. */
interface AgentTurn {
  readonly role: string;
  readonly content: unknown;
}

// EN correction patterns
const EN_PATTERNS = [
  /^no[,\s]/i,
  /\bwrong\b/i,
  /\binstead\b/i,
  /\bincorrect\b/i,
  /\bactually[,\s]/i,
  /\bnot like that\b/i,
  /\bthat's not right\b/i,
  /\bdon'?t do that\b/i,
];

// TR correction patterns
const TR_PATTERNS = [
  /\bhayir\b/i,
  /\byanlis\b/i,
  /\bdogru degil\b/i,
];

const ALL_CORRECTION_PATTERNS = [...EN_PATTERNS, ...TR_PATTERNS];

/** Extract the text of one message, joining the text blocks of a structured one. */
function turnText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string" ? record["text"] : "";
    })
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
}

export class CorrectionDetector {
  /**
   * Returns true if the text contains contradiction/correction patterns.
   */
  static isCorrection(text: string): boolean {
    if (!text) return false;
    return ALL_CORRECTION_PATTERNS.some(pattern => pattern.test(text));
  }

  /**
   * The agent turn a correction is ABOUT: the text of the most recent assistant
   * message, or null when the agent has not said anything yet (an opening
   * "no, that's wrong" corrects nothing) or its last turn was tool calls only.
   */
  static lastAgentText(messages: ReadonlyArray<AgentTurn>): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message || message.role !== "assistant") continue;
      const text = turnText(message.content);
      return text.length > 0 ? text : null;
    }
    return null;
  }
}
