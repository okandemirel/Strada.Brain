import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager, type CompileVerdict } from "./campaign-manager.js";

/**
 * Measured live 2026-09-04 21:37. Sprint 7 was committed green — 1296 files,
 * f674e8d — and the campaign declared delivery while the tree carried 37
 * compile errors, found seconds later by the real-tree guardian and by no gate
 * at all. Every other gate reads what a run REPORTED; none asked the compiler.
 */
describe("the delivery gate asks the compiler", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "compile-gate-")); mkdirSync(join(dir, "Assets"), { recursive: true }); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const measure = async (verify?: (root: string) => Promise<CompileVerdict>): Promise<CompileVerdict> => {
    const m = Object.create(CampaignManager.prototype) as CampaignManager;
    Object.assign(m, { projectRoot: dir, verifyCompile: verify });
    return await (m as unknown as { measureCompile(): Promise<CompileVerdict> }).measureCompile();
  };

  it("a missing verifier is NOT a pass", async () => {
    const v = await measure(undefined);
    expect(v.ran).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("no compile verifier");
  });

  it("a verifier that throws is NOT a pass either", async () => {
    const v = await measure(async () => { throw new Error("bridge died"); });
    expect(v.ran).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("bridge died");
  });

  it("carries the error count through when the compiler answers", async () => {
    const v = await measure(async () => ({ ok: false, ran: true, errors: 37, detail: "37 error(s)" }));
    expect(v).toEqual({ ok: false, ran: true, errors: 37, detail: "37 error(s)" });
  });

  it("a clean compile passes", async () => {
    const v = await measure(async () => ({ ok: true, ran: true, errors: 0 }));
    expect(v.ok).toBe(true);
    expect(v.ran).toBe(true);
  });

  it("does not let one project's verifier be asked about another root", async () => {
    const seen: string[] = [];
    await measure(async (root) => { seen.push(root); return { ok: true, ran: true }; });
    expect(seen).toEqual([dir]);
  });
});

describe("what the report says about the compiler", () => {
  const render = (verdict: CompileVerdict | undefined): string => {
    const m = Object.create(CampaignManager.prototype) as CampaignManager;
    Object.assign(m, { projectRoot: "/tmp", maxMilestoneAttempts: 2 });
    const campaign = {
      id: "c1", gddPath: "docs/G.md", milestones: [
        { id: "m1", title: "Sprint 1", status: "green", ...(verdict ? { compileVerdict: verdict } : {}) },
      ],
    };
    return (m as unknown as { buildDeliveryReport(c: unknown): string }).buildDeliveryReport(campaign);
  };

  it("prints DOES NOT COMPILE with the count", () => {
    const r = render({ ok: false, ran: true, errors: 37, detail: "37 error(s)" });
    expect(r).toContain("DOES NOT COMPILE (37 errors)");
    expect(r).toContain("did not compile");
  });

  it("prints NOT measured rather than staying silent", () => {
    // Silence would read as "it compiled" — the exact false green this stops.
    const r = render({ ok: false, ran: false, detail: "no verifier" });
    expect(r).toContain("compile NOT measured");
    expect(r).toContain("never compiled at the delivery gate");
  });

  it("says so when it compiles", () => {
    expect(render({ ok: true, ran: true, errors: 0 })).toContain("compiles");
  });
});
