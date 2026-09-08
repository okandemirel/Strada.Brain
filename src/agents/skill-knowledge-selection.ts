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
