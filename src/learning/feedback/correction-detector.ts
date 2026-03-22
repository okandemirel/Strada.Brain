/**
 * Correction Detector
 *
 * Detects user corrections in natural language and file-level heuristics.
 */

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

/** Maximum time window (ms) for file correction detection */
const FILE_CORRECTION_WINDOW_MS = 60_000;

export class CorrectionDetector {
  /**
   * Returns true if the text contains contradiction/correction patterns.
   */
  static isCorrection(text: string): boolean {
    if (!text) return false;
    return ALL_CORRECTION_PATTERNS.some(pattern => pattern.test(text));
  }

  /**
   * Returns true if a file was modified within 60s of agent write
   * AND the modification did NOT occur during an agent tool execution window.
   */
  static isFileCorrection(
    agentWriteTime: number,
    fileModifyTime: number,
    toolExecutionLog: Array<{ timestamp: number; endTimestamp: number }>,
  ): boolean {
    const delta = fileModifyTime - agentWriteTime;

    // Must be after agent write and within window
    if (delta < 0 || delta > FILE_CORRECTION_WINDOW_MS) return false;

    // Reject if the modification happened during any agent tool execution
    for (const entry of toolExecutionLog) {
      if (fileModifyTime >= entry.timestamp && fileModifyTime <= entry.endTimestamp) {
        return false;
      }
    }

    return true;
  }
}
