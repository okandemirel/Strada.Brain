/**
 * WHAT THE SYSTEM DECIDED THAT THE DOCUMENT DID NOT SAY.
 *
 * Measured 2026-10-14: a campaign resolves ambiguity by mandate ("do not ask
 * the person") and kept no record of having done so — campaigns.db had no
 * store for an assumption at all, so a delivered game carried choices nobody
 * could find, let alone change.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignStorage } from "./campaign-storage.js";
import { identityAnswersSpec } from "./project-identity.js";

const dirs: string[] = [];
function storage(): CampaignStorage {
  const dir = mkdtempSync(join(tmpdir(), "assumptions-"));
  dirs.push(dir);
  return new CampaignStorage(join(dir, "campaigns.db"));
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const row = {
  campaignId: "c1", atMs: 1_000, kind: "platform", what: "screen orientation",
  value: "portrait", why: "the document states none", source: "project-identity",
};

describe("the assumption store", () => {
  it("keeps what was decided, why, and what measured it", () => {
    const store = storage();
    store.recordAssumption({ ...row, milestoneId: "m1" });

    expect(store.listAssumptions("c1")).toEqual([
      { milestoneId: "m1", atMs: 1_000, kind: "platform", what: "screen orientation", value: "portrait", why: "the document states none", source: "project-identity" },
    ]);
    store.close();
  });

  it("records the same assumption once, however many rounds re-measure it", () => {
    const store = storage();
    store.recordAssumption(row);
    store.recordAssumption({ ...row, atMs: 2_000 });
    store.recordAssumption({ ...row, value: "landscape" });

    expect(store.listAssumptions("c1").map((a) => a.value)).toEqual(["portrait", "landscape"]);
    store.close();
  });

  it("is append-only, like the judgements beside it", () => {
    const store = storage();
    store.recordAssumption(row);
    const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;

    expect(() => db.prepare("UPDATE campaign_assumptions SET value = 'x'").run()).toThrow(/append-only/u);
    expect(() => db.prepare("DELETE FROM campaign_assumptions").run()).toThrow(/append-only/u);
    store.close();
  });

  it("keeps one campaign's assumptions out of another's", () => {
    const store = storage();
    store.recordAssumption(row);
    store.recordAssumption({ ...row, campaignId: "c2", value: "landscape" });

    expect(store.listAssumptions("c1").map((a) => a.value)).toEqual(["portrait"]);
    expect(store.listAssumptions("c2").map((a) => a.value)).toEqual(["landscape"]);
    store.close();
  });
});

describe("what the identity judge hands the store", () => {
  const read = (over: Record<string, unknown> = {}) =>
    ({ read: true, bundleIds: {}, ...over }) as Parameters<typeof identityAnswersSpec>[0];

  it("names the orientation it shipped when the document states none", () => {
    const verdict = identityAnswersSpec(
      read({ companyName: "W", bundleIds: { Android: "a.b" }, orientation: "landscape" }),
      "A raft drifts down a river.",
      true,
    );

    expect(verdict.assumptions).toEqual([
      expect.objectContaining({ kind: "platform", what: "screen orientation", value: "landscape" }),
    ]);
    expect(verdict.assumptions[0]?.why).toContain("states no orientation");
  });

  it("names shipping without an application identity on a desktop document", () => {
    const verdict = identityAnswersSpec(read({ orientation: "landscape" }), "Windows, landscape.", false);

    expect(verdict.assumptions.map((a) => a.what)).toContain("application identity");
  });

  it("assumes nothing where the document decided", () => {
    const verdict = identityAnswersSpec(
      read({ companyName: "W", bundleIds: { Android: "a.b" }, orientation: "portrait" }),
      "Portrait only. Android.",
      true,
    );

    expect(verdict.assumptions).toEqual([]);
  });

  it("assumes nothing it could not measure", () => {
    expect(identityAnswersSpec({ read: false, bundleIds: {} }, "Portrait only.", true).assumptions).toEqual([]);
  });
});
