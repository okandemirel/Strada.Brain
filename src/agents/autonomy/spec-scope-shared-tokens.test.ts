/**
 * AUT-5 (audited 2026-09-24): an element whose every spelling is shared with
 * a variant ("Gate" beside "Gate (two-way)") had no token of its own, and a
 * name of one or two letters ("Ox") was never searched at all. Both read as
 * missing whatever the code held, and the campaign's delivery refusal built
 * on that report could never clear.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessSpecScope } from "./spec-scope.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(rows: readonly string[], code: string): string {
  const root = mkdtempSync(join(tmpdir(), "spec-scope-own-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "GDD.md"),
    "## 4. GAME ELEMENTS\n\n| Unlock | Element | Pitch |\n|---|---|---|\n" +
      rows.map((row, i) => `| L${i + 1} | ${row} | pitch |`).join("\n") + "\n",
  );
  const scripts = join(root, "Assets", "Modules", "M", "Scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "Code.cs"), code);
  return root;
}

describe("spec scope finds elements with no token of their own (AUT-5)", () => {
  it("a base element, its variant and a two-letter element are all found", () => {
    const root = project(
      ["Gate", "Gate (two-way)", "Ox"],
      "public class Gate {}\npublic class GateTwoWay {}\npublic class Ox {}",
    );
    const report = assessSpecScope(root);
    expect(report.scheduled).toBe(3);
    expect(report.missing).toEqual([]);
  });

  it("the variant's class does not stand in for the base element", () => {
    const root = project(["Gate", "Gate (two-way)"], "public class GateTwoWay {}");
    expect(assessSpecScope(root).missing.map((m) => m.name)).toEqual(["Gate"]);
  });

  it("a two-letter element is not found inside a longer word or as a lowercase local", () => {
    const root = project(["Ox"], "public class Box { float ox = 1f; }");
    expect(assessSpecScope(root).missing.map((m) => m.name)).toEqual(["Ox"]);
  });
});
