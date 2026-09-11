import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherStatusReport, readProviderBenches, renderStatusReport, snapshotOf } from "./status-report.js";
import { recordUpdateEvent, readUpdateHistory, HISTORY_LIMIT, describeUpdateEvent } from "./update-history.js";
import { CampaignStorage } from "../campaign/campaign-storage.js";
import type { Campaign } from "../campaign/types.js";

const NOW = 1_800_000_000_000;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "strada-status-"));
}

function campaign(over: Partial<Campaign>): Campaign {
  return {
    id: over.id ?? "cmp_1",
    chatId: "chat",
    channelType: "cli",
    userId: "u",
    projectRoot: "/proj",
    state: "executing",
    draftAttempts: 0,
    milestones: [
      { id: "m1", title: "Board", prompt: "p", status: "green" },
      { id: "m2", title: "Levels", prompt: "p", status: "running" },
    ] as Campaign["milestones"],
    currentMilestone: 1,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 120_000,
    ...over,
  } as Campaign;
}

describe("strada status read-out", () => {
  it("lists only providers whose cooldown is still ahead, newest bench first", () => {
    const d = dir();
    const file = join(d, "provider-health.json");
    writeFileSync(file, JSON.stringify({ entries: [
      ["openai", { status: "down", consecutiveFailures: 1, cooldownUntil: NOW + 3_600_000, lastError: "quota exhausted" }],
      ["kimi", { status: "down", consecutiveFailures: 40, cooldownUntil: NOW - 1000, lastError: "401" }],
      ["opencode", { status: "healthy", consecutiveFailures: 0, cooldownUntil: 0, lastError: "" }],
    ] }));
    const r = readProviderBenches(file, NOW);
    expect(r.readable).toBe(true);
    expect(r.total).toBe(3);
    expect(r.benched.map((b) => b.name)).toEqual(["openai"]);
    const lines = renderStatusReport({
      now: NOW, health: { reachable: false, detail: "ECONNREFUSED" }, providers: r,
      ceilings: { opencode: { ceiling: 45_600, observedTokens: 57_000, learnedAt: NOW - 600_000 } },
      campaigns: { readable: false, path: "/x/campaigns.db", active: [], awaitingRevive: [] }, update: { path: d },
    });
    expect(lines).toContain("Health: unreachable — ECONNREFUSED");
    expect(lines.find((l) => l.startsWith("- openai"))).toMatch(/down, 1 failure, retry in 1 h — quota exhausted/);
    expect(lines).toContain("Campaign: /x/campaigns.db not readable");
    expect(lines).toContain("Context ceiling learned: opencode answers below 57000 tokens — planning at 45600 (10 min ago)");
    expect(lines).toContain("Last auto-update: none recorded");
  });

  it("says when the health file is missing instead of pretending all is healthy", () => {
    const r = readProviderBenches(join(dir(), "provider-health.json"), NOW);
    expect(r.readable).toBe(false);
    const lines = renderStatusReport({
      now: NOW, health: { reachable: true, status: "ok", uptimeSeconds: 5400 }, providers: r, ceilings: {},
      campaigns: { readable: true, path: "p", active: [], awaitingRevive: [] }, update: { path: "/none" },
    });
    expect(lines[0]).toBe("Health: ok (up 1 h 30 min)");
    expect(lines[1]).toMatch(/not readable — no bench record/);
    expect(lines).toContain("Campaign: none active");
  });

  it("reads the live campaign, the revive appointment and the last terminal one from the database", async () => {
    const d = dir();
    const storage = new CampaignStorage(join(d, "campaigns.db"));
    storage.save(campaign({ id: "cmp_active" }));
    storage.save(campaign({ id: "cmp_failed", state: "failed", lastError: "NOT DELIVERED — proofs missing", autoReviveAt: NOW + 900_000, updatedAt: NOW - 60_000 }));
    storage.save(campaign({ id: "cmp_done", state: "done", updatedAt: NOW - 7_200_000 }));
    storage.close();
    const report = await gatherStatusReport({
      memoryDbPath: d, installRoot: d, now: NOW,
      healthUrl: "http://127.0.0.1:1/health",
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ status: "ok", uptime: 42 }) })) as unknown as typeof fetch,
    });
    expect(report.campaigns.readable).toBe(true);
    expect(report.campaigns.active.map((c) => c.id)).toEqual(["cmp_active"]);
    expect(report.campaigns.awaitingRevive.map((c) => c.id)).toEqual(["cmp_failed"]);
    expect(report.campaigns.lastTerminal?.id).toBe("cmp_done");
    const lines = renderStatusReport(report);
    expect(lines[0]).toBe("Health: ok (up 42 s)");
    expect(lines).toContain('Campaign cmp_active: executing, milestone 2/2 "Levels" (running), updated 2 min ago');
    expect(lines).toContain("Campaign cmp_failed: failed, auto-revive in 15 min — NOT DELIVERED — proofs missing");
    // an active campaign exists, so the terminal one is not repeated as "last"
    expect(lines.some((l) => l.startsWith("Last campaign"))).toBe(false);
  });

  it("falls back to the last terminal campaign when nothing is active", () => {
    const lines = renderStatusReport({
      now: NOW, health: { reachable: false }, providers: { readable: true, path: "p", benched: [], total: 2 }, ceilings: {},
      campaigns: { readable: true, path: "p", active: [], awaitingRevive: [], lastTerminal: snapshotOf(campaign({ id: "cmp_done", state: "done", updatedAt: NOW - 7_200_000 })) },
      update: { path: "/none" },
    });
    expect(lines).toContain("Providers: no bench in effect (2 tracked)");
    expect(lines).toContain("Last campaign cmp_done: done 2 h ago");
  });

  it("a health endpoint that sends headers and then never finishes its body does not hang status (Codex 2026-09-11 #13)", async () => {
    const d = dir();
    const trickle = ((url: string, init?: { signal?: AbortSignal }) => Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted: body never finished")))),
    })) as unknown as typeof fetch;
    const started = Date.now();
    const report = await gatherStatusReport({ memoryDbPath: d, installRoot: d, now: NOW, healthUrl: "http://127.0.0.1:1/health", fetchImpl: trickle });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.health.reachable).toBe(false);
    expect(report.health.detail).toContain("aborted");
  });

  it("update history: appends, caps at the limit, and the last event is what status prints", () => {
    const d = dir();
    mkdirSync(join(d, ".strada"), { recursive: true });
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      recordUpdateEvent(d, { at: NOW + i, kind: "pulled", from: "aaaaaaaa1", to: "bbbbbbbb2" });
    }
    recordUpdateEvent(d, { at: NOW + 100, kind: "rolled-back", from: "bbbbbbbb2", to: "aaaaaaaa1", reason: "npm run build failed" });
    const history = readUpdateHistory(d);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history.at(-1)?.kind).toBe("rolled-back");
    expect(describeUpdateEvent(history.at(-1), NOW + 100 + 30_000)).toBe(
      "Last auto-update: rolled-back bbbbbbbb → aaaaaaaa 30 s ago (npm run build failed)",
    );
  });

  it("update history: a corrupt file reads as empty and is overwritten, never thrown", () => {
    const d = dir();
    mkdirSync(join(d, ".strada"), { recursive: true });
    writeFileSync(join(d, ".strada", "auto-update.json"), "{not json");
    expect(readUpdateHistory(d)).toEqual([]);
    recordUpdateEvent(d, { at: NOW, kind: "deferred", reason: "local changes" });
    expect(readUpdateHistory(d).map((e) => e.kind)).toEqual(["deferred"]);
  });
});
