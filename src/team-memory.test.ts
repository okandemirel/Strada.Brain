/**
 * Holds docs/memory/ to its policy (docs/memory/POLICY.md).
 *
 * The team's decisions, gotchas and spike results used to live in one agent's
 * private notes: other agents could not see them, and nothing checked them. They
 * now live in docs/memory/entries/, from which CORE.md (read every session)
 * and INDEX.md (scanned before entering an area) are derived by
 * scripts/memory-index.mjs. This file fails when an entry breaks the format,
 * when a derived file is stale or hand-edited, when CORE outgrows 40 lines,
 * or when nothing tells an agent to read CORE.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MEMORY = join(REPO, "docs", "memory");

interface Entry {
  file: string;
  fields: Record<string, unknown>;
  body: string;
  problems: string[];
}
interface MemoryIndex {
  CORE_LINE_LIMIT: number;
  parseEntry(text: string, file: string): Entry;
  validate(entries: Entry[], topics: string[]): string[];
  derive(memoryDir: string): { problems: string[]; core: string; index: string };
}

const mi = (await import(pathToFileURL(join(REPO, "scripts/memory-index.mjs")).href)) as MemoryIndex;

const TOPICS = ["process", "evidence"];
const entry = (file: string, fields: Record<string, string>, body = SECTIONS) =>
  mi.parseEntry(
    `---\n${Object.entries({ ...BASE, ...fields })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n---\n${body}`,
    file,
  );
const BASE: Record<string, string> = {
  id: "x",
  kind: "decision",
  tier: "1",
  status: "active",
  topics: '["process"]',
  paths: '["src/**"]',
  purpose: '"Stop a thing."',
  summary: '"A thing was decided"',
  decided_on: "2026-01-02",
  conflicts_with: "[]",
};
const SECTIONS =
  "## Context\nWhy.\n## Decision\nWhat.\n## Rejected alternatives\n- **Another way.** It failed for a stated reason.\n## Consequences\nThen.\n";

describe("team memory is held to its policy (docs/memory/POLICY.md)", () => {
  it("every entry is valid and both derived files match what the entries produce", () => {
    const { problems, core, index } = mi.derive(MEMORY);
    expect(problems).toEqual([]);
    expect(readFileSync(join(MEMORY, "CORE.md"), "utf8"), "CORE.md is stale or hand-edited — run node scripts/memory-index.mjs").toBe(core);
    expect(readFileSync(join(MEMORY, "INDEX.md"), "utf8"), "INDEX.md is stale or hand-edited — run node scripts/memory-index.mjs").toBe(index);
  });

  it(`CORE.md stays within ${40} lines`, () => {
    expect(mi.CORE_LINE_LIMIT).toBe(40);
    expect(readFileSync(join(MEMORY, "CORE.md"), "utf8").trimEnd().split("\n").length).toBeLessThanOrEqual(mi.CORE_LINE_LIMIT);
  });

  it("AGENTS.md tells every agent to read CORE.md and points at the policy", () => {
    const agents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    expect(agents).toContain("docs/memory/CORE.md");
    expect(agents).toContain("docs/memory/POLICY.md");
  });

  it("accepts a well-formed entry", () => {
    expect(mi.validate([entry("2026-01-02-x.md", {})], TOPICS)).toEqual([]);
  });

  it("refuses an entry whose rejected alternatives are empty — that section is the point", () => {
    const thin = SECTIONS.replace("- **Another way.** It failed for a stated reason.\n", "\n");
    expect(mi.validate([entry("2026-01-02-x.md", {}, thin)], TOPICS)).toEqual([
      "2026-01-02-x.md: Rejected alternatives is empty — list what was rejected, or say why nothing was",
    ]);
  });

  it("refuses an unregistered topic, a tier-0 entry with no reason, and a misnamed file", () => {
    const problems = mi.validate(
      [entry("2026-01-02-y.md", { topics: '["vibes"]', tier: "0" })],
      TOPICS,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "2026-01-02-y.md: file name must end with -x.md",
        "2026-01-02-y.md: tier 0 needs a tier_reason",
        "2026-01-02-y.md: topic vibes is not in topics.yaml",
      ]),
    );
  });

  it("refuses a contradiction recorded on one side only — no silent conflicts", () => {
    const a = entry("2026-01-02-a.md", { id: "a", conflicts_with: '["b"]' });
    const b = entry("2026-01-02-b.md", { id: "b" });
    expect(mi.validate([a, b], TOPICS)).toEqual(["2026-01-02-a.md: conflict with b is not recorded on both sides"]);
  });
});
