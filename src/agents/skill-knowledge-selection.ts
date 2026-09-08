/**
 * Which skills' SKILL.md bodies belong in THIS task's system prompt.
 *
 * Measured 2026-09-08 04:42 on a PixelFlow sprint turn: the "Skill Knowledge"
 * layer carried three project skills the agent itself had written with
 * create_skill on Aug 27, Sep 2 and Sep 3 — a UFO set-piece plan, a replan
 * for a PlayfieldBuilder compile error, a verification plan — ~7.4k chars on
 * every turn of every task since, none of it about the task at hand. A
 * skill body is injected when the task names the skill (or one of its
 * declared triggers), or the skill says `inject: always`.
 */

import type { SkillEntry } from "../skills/types.js";

export type SkillKnowledgeEntry = Pick<SkillEntry, "manifest" | "status" | "body">;

export interface SkillKnowledgeSelection<T extends SkillKnowledgeEntry> {
  readonly included: T[];
  /** Active skills with a body that this prompt did not call for. */
  readonly withheld: Array<{ name: string; chars: number }>;
}

function mentions(prompt: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return n.length > 0 && prompt.includes(n);
}

export function selectSkillKnowledge<T extends SkillKnowledgeEntry>(
  entries: ReadonlyArray<T>,
  prompt: string,
): SkillKnowledgeSelection<T> {
  const haystack = prompt.toLowerCase();
  const included: T[] = [];
  const withheld: Array<{ name: string; chars: number }> = [];
  for (const skill of entries) {
    if (skill.status !== "active" || !skill.body) continue;
    const m = skill.manifest;
    const wanted =
      m.inject === "always" ||
      mentions(haystack, m.name) ||
      (m.triggers ?? []).some((t) => mentions(haystack, t));
    if (wanted) included.push(skill);
    else withheld.push({ name: m.name, chars: skill.body.length });
  }
  return { included, withheld };
}

/**
 * How much of one retrieved memory the "Relevant Memory" layer may carry.
 * Measured 2026-09-08 04:42: five entries came to 10 485 chars — ~2.1k each —
 * on every turn, most of it the tail of long task summaries. The first
 * MAX_MEMORY_ENTRY_CHARS say what the memory is about; the rest is the
 * vault's job.
 */
export const MAX_MEMORY_ENTRY_CHARS = 1_200;

export function clampMemoryEntry(content: string, max: number = MAX_MEMORY_ENTRY_CHARS): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n… (${content.length - max} more chars in memory)`;
}
