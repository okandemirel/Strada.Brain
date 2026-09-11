/**
 * Strada.Brain is universal: a test vehicle's names may not sit in system
 * code — defaults, schema examples, prompts, fixtures a run reads, refusal
 * wording. Comments recording a measurement are history and are ignored;
 * this scans CODE lines (comments and JSDoc stripped) outside tests.
 * Measured 2026-09-10: the prerender tool described itself as the
 * casual-game chibi pipeline with a pink default and a user's own prefab
 * path as the example. The rule was written; nothing enforced it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Names of the test vehicle and its assets. Extend when a new vehicle is used. */
const VEHICLE_NAMES = /\b(?:pixel ?flow|pigs?|piglets?|conveyors?|frozen ?pig|pig ?body|stage ?block|music_farm|boar_cub(?:_ip)?|pig_real|neon ?city)\b/i;
/** Files whose whole purpose is the vehicle's own knowledge and are configured, not defaulted. */
const ALLOWED = new Set<string>([]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    // Python comments inside an embedded script (assets-local/local-model-runner.ts)
    // record measurements too; a TS line never starts with "# ".
    .replace(/^\s*# .*$/gm, "");
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "tests" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
}

describe("universality: no test-vehicle names in system code", () => {
  it("finds none outside comments and tests", () => {
    const root = join(process.cwd(), "src");
    const files: string[] = [];
    walk(root, files);
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(root, file);
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      code.split("\n").forEach((line, i) => {
        if (VEHICLE_NAMES.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits, `test-vehicle names in system code:\n${hits.join("\n")}`).toEqual([]);
  });
});
