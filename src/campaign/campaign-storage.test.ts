import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignStorage } from "./campaign-storage.js";
import type { Campaign } from "./types.js";

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  const now = Date.now();
  return {
    id: "campaign_test_1",
    chatId: "cli-local",
    channelType: "cli",
    userId: "u1",
    projectRoot: "/tmp/project",
    state: "executing",
    draftAttempts: 0,
    milestones: [
      { id: "m1", title: "Sprint A", prompt: "build foundations", status: "running", attempts: 1, taskId: "task_1" },
      { id: "m2", title: "Sprint B", prompt: "build mechanics", status: "pending", attempts: 0 },
    ],
    currentMilestone: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("CampaignStorage", () => {
  let dir: string;
  let storage: CampaignStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "campaign-storage-"));
    storage = new CampaignStorage(join(dir, "campaigns.db"));
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a campaign with its milestone ladder", () => {
    const campaign = makeCampaign();
    storage.save(campaign);

    const loaded = storage.get(campaign.id);
    expect(loaded).toBeDefined();
    expect(loaded!.state).toBe("executing");
    expect(loaded!.milestones).toHaveLength(2);
    expect(loaded!.milestones[0]!.taskId).toBe("task_1");
    expect(loaded!.chatId).toBe("cli-local");
  });

  it("round-trips the revive counters — a field with no column reads back undefined", () => {
    // Every Campaign field needs its own column, migration, bind and row
    // mapping; a new counter that silently vanished on reload is how a bound
    // loop became unbounded (F#1 added implementation_revives).
    const campaign = { ...makeCampaign(), unmeasurableRevives: 2, implementationRevives: 1 };
    storage.save(campaign);
    const loaded = storage.get(campaign.id)!;
    expect(loaded.unmeasurableRevives).toBe(2);
    expect(loaded.implementationRevives).toBe(1);
    // …and an absent counter stays absent rather than becoming 0.
    const fresh = makeCampaign();
    storage.save(fresh);
    expect(storage.get(fresh.id)!.implementationRevives).toBeUndefined();
  });

  it("updates state on re-save (upsert)", () => {
    const campaign = makeCampaign();
    storage.save(campaign);
    campaign.state = "awaiting-approval";
    campaign.gddPath = "docs/Game_GDD.md";
    storage.save(campaign);

    const loaded = storage.get(campaign.id);
    expect(loaded!.state).toBe("awaiting-approval");
    expect(loaded!.gddPath).toBe("docs/Game_GDD.md");
  });

  it("listActive returns only non-terminal campaigns", () => {
    storage.save(makeCampaign({ id: "c_active", state: "executing" }));
    storage.save(makeCampaign({ id: "c_waiting", state: "awaiting-approval" }));
    storage.save(makeCampaign({ id: "c_done", state: "done" }));
    storage.save(makeCampaign({ id: "c_failed", state: "failed" }));

    const active = storage.listActive().map((c) => c.id);
    expect(active).toContain("c_active");
    expect(active).toContain("c_waiting");
    expect(active).not.toContain("c_done");
    expect(active).not.toContain("c_failed");
  });

  it("findAwaitingApproval scopes to the conversation", () => {
    storage.save(makeCampaign({ id: "c1", chatId: "chat-a", state: "awaiting-approval" }));
    storage.save(makeCampaign({ id: "c2", chatId: "chat-b", state: "awaiting-approval" }));

    expect(storage.findAwaitingApproval("chat-a")!.id).toBe("c1");
    expect(storage.findAwaitingApproval("chat-b")!.id).toBe("c2");
    expect(storage.findAwaitingApproval("chat-c")).toBeUndefined();
  });

  it("survives a corrupt milestones column instead of crashing boot resume", () => {
    storage.save(makeCampaign({ id: "c_corrupt" }));
    const db = (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("UPDATE campaigns SET milestones_json = ? WHERE id = ?").run("{not json", "c_corrupt");

    const loaded = storage.get("c_corrupt");
    expect(loaded).toBeDefined();
    expect(loaded!.milestones).toEqual([]);
  });
});

describe("findLatestRevivable", () => {
  /**
   * Audited 2026-09-06: a campaign the OLD delivery path had marked `done`
   * while the structural refusal still stood ("delivered" a game that renders
   * nothing) answered "kampanya devam" with silence — the query only looked
   * at failed/cancelled, the user was told nothing, and the only way forward
   * was a hand edit of this database.
   */
  let dir: string;
  let storage: CampaignStorage;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "revivable-")); storage = new CampaignStorage(join(dir, "c.db")); });
  afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("revives a `done` campaign whose final sprint still carries the structural refusal", () => {
    storage.save(makeCampaign({
      id: "c_done_refused", state: "done",
      milestones: [{ id: "m1", title: "Sprint", prompt: "p", status: "green", attempts: 2, structureRefused: true }],
    }));
    expect(storage.findLatestRevivable("cli-local")?.id).toBe("c_done_refused");
  });

  it("leaves a plain `done` campaign final", () => {
    storage.save(makeCampaign({
      id: "c_done_clean", state: "done",
      milestones: [{ id: "m1", title: "Sprint", prompt: "p", status: "green", attempts: 1 }],
    }));
    expect(storage.findLatestRevivable("cli-local")).toBeUndefined();
  });

  it("still finds a failed campaign", () => {
    storage.save(makeCampaign({ id: "c_failed", state: "failed" }));
    expect(storage.findLatestRevivable("cli-local")?.id).toBe("c_failed");
  });

  /**
   * The independent opinion was gathered, rendered into the delivery report and
   * then thrown away: nothing wrote it. The boot resend assumes it is there, so
   * a lost report meant a campaign that had already paid for a review paid for
   * another one (Codex 2026-09-12 X).
   */
  describe("the independent review survives a round trip", () => {
    it("comes back exactly as it was stored", () => {
      storage.save(makeCampaign({
        id: "c_review",
        independentReview: { ok: true, model: "fixture", text: "Keep this exact opinion", ms: 2 },
      }));
      expect(storage.get("c_review")!.independentReview).toEqual({
        ok: true, model: "fixture", text: "Keep this exact opinion", ms: 2,
      });
      // A failed review keeps its cause, so the report can say why.
      storage.save(makeCampaign({
        id: "c_review_failed",
        independentReview: { ok: false, model: "unknown", text: "", ms: 0, error: "no reviewer configured" },
      }));
      expect(storage.get("c_review_failed")!.independentReview).toMatchObject({ ok: false, error: "no reviewer configured" });
      // …and a campaign with none says none.
      storage.save(makeCampaign({ id: "c_no_review" }));
      expect(storage.get("c_no_review")!.independentReview).toBeUndefined();
    });
  });

  /**
   * Codex round AD#18, reproduced through SQLite: a truncated or malformed
   * requirement queue hydrated as `undefined`, which the campaign reads as
   * "nothing is waiting" — the obligations a previous run discovered simply
   * stopped existing.
   */
  describe("an unreadable requirement queue is not an empty one (Codex 2026-09-12 AD#18)", () => {
    const storedQueue = (raw: string, id: string): Campaign => {
      storage.save(makeCampaign({ id, pendingCoverageGaps: ["Save: absent"] }));
      // Reach past the API the way a half-written row or an older writer does.
      (storage as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
        .prepare("UPDATE campaigns SET pending_coverage_gaps = ? WHERE id = ?")
        .run(raw, id);
      return storage.get(id)!;
    };

    it("says so for truncated JSON, a non-array and entries it cannot use", () => {
      const truncated = storedQueue('["Save: absent"', "c_truncated");
      expect(truncated.coverageQueueUnreadable).toBe(true);
      expect(truncated.pendingCoverageGaps).toBeUndefined();

      const notAnArray = storedQueue('{"Save": "absent"}', "c_object");
      expect(notAnArray.coverageQueueUnreadable).toBe(true);

      const nulls = storedQueue("[null, null]", "c_nulls");
      expect(nulls.coverageQueueUnreadable).toBe(true);

      // PARTIAL is still a loss: the readable entries are kept AND the row is
      // flagged, so nothing claims the lost ones were satisfied.
      const partial = storedQueue('["Save: absent", null, 7]', "c_partial");
      expect(partial.pendingCoverageGaps).toEqual(["Save: absent"]);
      expect(partial.coverageQueueUnreadable).toBe(true);
    });

    it("keeps the flag across a save (Codex 2026-09-13 AF#2)", () => {
      // The flag was derived at load and dropped at save: the very next save
      // wrote NULL over the damaged row and the obligation was gone.
      const loaded = storedQueue('["Save: absent"', "c_survives");
      expect(loaded.coverageQueueUnreadable).toBe(true);
      storage.save(loaded);
      expect(storage.get("c_survives")!.coverageQueueUnreadable).toBe(true);
      // …and a campaign that writes a readable queue is not flagged for ever.
      storage.save({ ...loaded, coverageQueueUnreadable: undefined, pendingCoverageGaps: ["Save: absent"] });
      const recovered = storage.get("c_survives")!;
      expect(recovered.coverageQueueUnreadable).toBeUndefined();
      expect(recovered.pendingCoverageGaps).toEqual(["Save: absent"]);
    });

    it("keeps the flag across a save (Codex 2026-09-13 AF#2)", () => {
      // The flag was derived at load and dropped at save: the very next save
      // wrote NULL over the damaged row and the obligation was gone.
      const loaded = storedQueue('["Save: absent"', "c_survives");
      expect(loaded.coverageQueueUnreadable).toBe(true);
      storage.save(loaded);
      expect(storage.get("c_survives")!.coverageQueueUnreadable).toBe(true);
      // …and a campaign that writes a readable queue is not flagged for ever.
      storage.save({ ...loaded, coverageQueueUnreadable: undefined, pendingCoverageGaps: ["Save: absent"] });
      const recovered = storage.get("c_survives")!;
      expect(recovered.coverageQueueUnreadable).toBeUndefined();
      expect(recovered.pendingCoverageGaps).toEqual(["Save: absent"]);
    });

    it("says nothing of the kind for a queue that is genuinely empty or readable", () => {
      expect(storedQueue("[]", "c_empty").coverageQueueUnreadable).toBeUndefined();
      expect(storedQueue("", "c_blank").coverageQueueUnreadable).toBeUndefined();
      const good = storedQueue('["Save: absent", "Audio: absent"]', "c_good");
      expect(good.pendingCoverageGaps).toEqual(["Save: absent", "Audio: absent"]);
      expect(good.coverageQueueUnreadable).toBeUndefined();
      // A campaign that never queued anything.
      storage.save(makeCampaign({ id: "c_none" }));
      expect(storage.get("c_none")!.coverageQueueUnreadable).toBeUndefined();
    });
  });

});
