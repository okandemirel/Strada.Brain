import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";

/**
 * Measured live 2026-09-04: told not to audit, the final sprint answered
 * three times with DOCUMENTS — a gap analysis, an entry-scene audit, a
 * "vertical slice" write-up — and its commit touched 0 code, scene, prefab or
 * asset files. The no-work gate sees a dirty tree and passes it.
 */
const dirs: string[] = [];
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "prose-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
  execFileSync("git", ["config", "user.name", "t"], { cwd: d });
  return d;
}
function commit(root: string, rel: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", `add ${rel}`], { cwd: root });
}
function judge(root: string): boolean {
  const manager = Object.create(CampaignManager.prototype) as CampaignManager;
  (manager as unknown as { projectRoot: string }).projectRoot = root;
  return (manager as unknown as { changedOnlyProse(m: unknown): boolean })
    .changedOnlyProse({ startedAtMs: Date.now() - 3_600_000 });
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("documents are not delivery", () => {
  it("flags a sprint whose only commits are docs", () => {
    const root = repo();
    commit(root, "docs/GapAnalysis.md");
    commit(root, "docs/DELIVERY_REPORT.md");
    expect(judge(root)).toBe(true);
  });

  it("passes a sprint that touched code or a scene", () => {
    const root = repo();
    commit(root, "docs/Notes.md");
    commit(root, "Assets/Modules/Board/Board.cs");
    expect(judge(root)).toBe(false);
  });

  it("leaves an empty sprint to the no-work gate", () => {
    expect(judge(repo())).toBe(false);
  });
});
