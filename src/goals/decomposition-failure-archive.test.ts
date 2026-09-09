import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDecompositionFailure, DECOMPOSITION_FAILURE_CAP, decompositionFailureRoot } from "./decomposition-failure-archive.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const fresh = (): string => { const r = mkdtempSync(join(tmpdir(), "decomp-fail-")); roots.push(r); return r; };

describe("archiveDecompositionFailure", () => {
  it("keeps the whole reply, never overwrites, and stops at the cap", () => {
    const root = fresh();
    const at = new Date("2026-09-09T19:41:21.000Z");
    const a = archiveDecompositionFailure("<reasoning>x</reasoning>\n{not a plan}", root, at)!;
    const b = archiveDecompositionFailure("second", root, at)!;
    expect(a).not.toBe(b);
    expect(readFileSync(a, "utf8")).toContain("{not a plan}");
    expect(readdirSync(root)).toHaveLength(2);
    for (let i = 0; i < DECOMPOSITION_FAILURE_CAP; i++) writeFileSync(join(root, `pad-${i}.txt`), "x");
    expect(archiveDecompositionFailure("over cap", root, at)).toBeUndefined();
  });

  it("returns undefined instead of throwing when the root cannot be created", () => {
    expect(archiveDecompositionFailure("x", "/dev/null/impossible")).toBeUndefined();
  });

  it("lives under STRADA_HOME/.strada/analysis, under the temp root while vitest runs, or where the env says", () => {
    expect(decompositionFailureRoot({ STRADA_HOME: "/h" } as NodeJS.ProcessEnv)).toBe("/h/.strada/analysis/decomposition-failures");
    expect(decompositionFailureRoot({ VITEST: "true" } as NodeJS.ProcessEnv)).toBe(join(tmpdir(), "strada-decomposition-failures"));
    expect(decompositionFailureRoot({ STRADA_DECOMPOSITION_FAILURE_DIR: "/x" } as NodeJS.ProcessEnv)).toBe("/x");
    expect(existsSync("/x")).toBe(false);
  });
});
