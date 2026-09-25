import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
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

  it("round-trips the session coverage accumulated across runs (Codex 2026-09-13 AJ#11)", () => {
    // One run plays a batch, so a game bigger than one batch is only fully
    // played across several — and nothing remembered which ones had been
    // played, so the last sessions were never played at all.
    const campaign = { ...makeCampaign(), verifiedSessions: { artifact: "a".repeat(64), indices: [1, 2, 13] } };
    storage.save(campaign);
    expect(storage.get(campaign.id)!.verifiedSessions).toEqual({ artifact: "a".repeat(64), indices: [1, 2, 13] });

    // A campaign that has played nothing carries nothing.
    storage.save(makeCampaign({ id: "c_none" }));
    expect(storage.get("c_none")!.verifiedSessions).toBeUndefined();

    // A ROW IT CANNOT READ IS NO COVERAGE: the next run then asks for the
    // first batch again, which measures more rather than claims more.
    const db = (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    for (const bad of [
      "{not json",
      JSON.stringify({ indices: [1] }),
      JSON.stringify({ artifact: "a", indices: "1,2" }),
      JSON.stringify({ artifact: "a", indices: [0] }),
      JSON.stringify({ artifact: "a", indices: [1.5] }),
      JSON.stringify({ artifact: "a", indices: [] }),
    ]) {
      db.prepare("UPDATE campaigns SET verified_sessions = ? WHERE id = ?").run(bad, campaign.id);
      expect(storage.get(campaign.id)!.verifiedSessions).toBeUndefined();
    }

    // …and duplicates are one session, in order.
    db.prepare("UPDATE campaigns SET verified_sessions = ? WHERE id = ?")
      .run(JSON.stringify({ artifact: "b".repeat(64), indices: [3, 1, 3] }), campaign.id);
    expect(storage.get(campaign.id)!.verifiedSessions).toEqual({ artifact: "b".repeat(64), indices: [1, 3] });
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

  it("chat lookups skip rows another project owns, newest first (CMP-7)", () => {
    const ours = (c: Campaign): boolean => c.projectRoot === "/tmp/game-b";
    const t = Date.now();
    storage.save(makeCampaign({ id: "b_old", projectRoot: "/tmp/game-b", state: "failed", updatedAt: t - 2_000 }));
    storage.save(makeCampaign({ id: "a_new", projectRoot: "/tmp/game-a", state: "failed", updatedAt: t - 1_000 }));
    storage.save(makeCampaign({ id: "a_live", projectRoot: "/tmp/game-a", state: "executing", updatedAt: t }));

    expect(storage.findLatestRevivable("cli-local")?.id).toBe("a_new");
    expect(storage.findLatestRevivable("cli-local", ours)?.id).toBe("b_old");
    expect(storage.hasActiveForChat("cli-local")).toBe(true);
    expect(storage.hasActiveForChat("cli-local", ours)).toBe(false);
    expect(storage.findActiveForChat("cli-local", ours)).toBeUndefined();
    storage.save(makeCampaign({ id: "b_gate", projectRoot: "/tmp/game-b", state: "awaiting-approval" }));
    storage.save(makeCampaign({ id: "a_gate", projectRoot: "/tmp/game-a", state: "awaiting-approval", createdAt: t + 1 }));
    expect(storage.findAwaitingApproval("cli-local", ours)?.id).toBe("b_gate");
  });

});

describe("schema migrations (CMP-15)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "campaign-migrate-")); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  /** A database from before any added column, holding one delivered campaign. */
  const legacyDatabase = (path: string): void => {
    const db = new Database(path);
    db.exec(`CREATE TABLE campaigns (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, channel_type TEXT NOT NULL, user_id TEXT NOT NULL,
      conversation_id TEXT, project_root TEXT NOT NULL, state TEXT NOT NULL, idea_text TEXT, gdd_path TEXT,
      gdd_text TEXT, draft_task_id TEXT, draft_attempts INTEGER NOT NULL DEFAULT 0,
      milestones_json TEXT NOT NULL DEFAULT '[]', current_milestone INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT)`);
    db.prepare(`INSERT INTO campaigns (id, chat_id, channel_type, user_id, project_root, state, created_at, updated_at)
      VALUES ('c_old', 'chat', 'cli', 'u', '/p', 'done', 1, 1)`).run();
    db.close();
  };

  it("a migration that fails is not read as 'already there', and its backfill lands with its column", () => {
    const path = join(dir, "campaigns.db");
    legacyDatabase(path);
    // The process fails between adding delivery_reported and backfilling it.
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes("SET delivery_reported = 1")) throw new Error("disk I/O error");
      return exec.call(this, sql);
    });
    expect(() => new CampaignStorage(path)).toThrow(/disk I\/O error/);
    vi.restoreAllMocks();
    // The next start adds the column AND backfills it: an old delivered
    // campaign is not re-announced at boot.
    const storage = new CampaignStorage(path);
    try {
      expect(storage.get("c_old")?.deliveryReported).toBe(true);
      expect(storage.get("c_old")?.state).toBe("done");
    } finally {
      storage.close();
    }
  });

  it("an up-to-date database opens again without altering anything", () => {
    const path = join(dir, "campaigns.db");
    new CampaignStorage(path).close();
    const exec = vi.spyOn(Database.prototype, "exec");
    new CampaignStorage(path).close();
    expect(exec.mock.calls.some(([sql]) => /ALTER TABLE/i.test(String(sql)))).toBe(false);
  });
});
