/**
 * Command Detector
 *
 * Deterministic command detection without LLM.
 * Supports prefix commands (/status, /cancel, etc.) and
 * bilingual keyword fallback (Turkish + English).
 */

import type { TaskCommand, ClassificationResult } from "./types.js";

// ─── Prefix Commands ─────────────────────────────────────────────────────────────

const PREFIX_COMMANDS: Record<string, TaskCommand> = {
  "/status": "status",
  "/cancel": "cancel",
  "/tasks": "tasks",
  "/detail": "detail",
  "/help": "help",
  "/pause": "pause",
  "/resume": "resume",
  "/model": "model",
  "/iptal": "cancel",
  "/durum": "status",
  "/gorevler": "tasks",
  "/detay": "detail",
  "/yardim": "help",
  "/duraklat": "pause",
  "/devam": "resume",
  "/goal": "goal",
  "/hedef": "goal",
  "/autonomous": "autonomous",
  "/autonomy": "autonomous",
  "/otonom": "autonomous",
  "/otonomi": "autonomous",
  "/persona": "persona",
  "/kisilik": "persona",
};

// ─── Keyword Patterns (bilingual TR/EN) ──────────────────────────────────────────

const KEYWORD_PATTERNS: Array<{ pattern: RegExp; command: TaskCommand }> = [
  // Cancel
  { pattern: /^iptal\s+et/i, command: "cancel" },
  { pattern: /^cancel\s+(task|it)/i, command: "cancel" },
  // Status
  { pattern: /^durumu?\s+ne/i, command: "status" },
  { pattern: /^(ne\s+)?durumdas?[ıi]?n?/i, command: "status" },
  { pattern: /^task\s+status/i, command: "status" },
  { pattern: /^what('s| is) the status/i, command: "status" },
  // Tasks list
  { pattern: /^görevleri?(mi?)?\s+(göster|listele)/i, command: "tasks" },
  { pattern: /^(show|list)\s+(my\s+)?tasks/i, command: "tasks" },
  // Pause
  { pattern: /^duraklat/i, command: "pause" },
  { pattern: /^pause\s+(task|it)/i, command: "pause" },
  // Resume
  { pattern: /^devam\s+et/i, command: "resume" },
  { pattern: /^resume\s+(task|it)/i, command: "resume" },
];

// ─── Detector ────────────────────────────────────────────────────────────────────

export function detectCommand(text: string): ClassificationResult {
  const trimmed = text.trim();

  // 1. Check prefix commands
  const firstWord = trimmed.split(/\s+/)[0]!.toLowerCase();
  const prefixCmd = PREFIX_COMMANDS[firstWord];
  if (prefixCmd) {
    const args = trimmed.split(/\s+/).slice(1);
    return { type: "command", command: prefixCmd, args };
  }

  // 2. Check keyword patterns
  for (const { pattern, command } of KEYWORD_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const afterMatch = trimmed.slice(match[0].length).trim();
      const args = afterMatch ? afterMatch.split(/\s+/) : [];
      return { type: "command", command, args };
    }
  }

  // 3. Default: treat as task request
  return { type: "task_request", prompt: trimmed };
}
