import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CampaignStorage } from "./campaign-storage.js";
import type { Campaign } from "./types.js";
import type {
  AcceptanceSource,
  GreenInput,
  Judgement,
  RequirementLedger,
  RequirementRow,
  RequirementStatus,
} from "./scope-types.js";

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

// =============================================================================
// GDD plan W03: the requirement ledger, the acceptance files and the judge's
// verdicts. Every one of them goes through real SQLite: a field that only
// lives in memory is gone at the next restart, and with it the obligation.
// =============================================================================

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function makeRow(rid: string, status: RequirementStatus, overrides: Partial<RequirementRow> = {}): RequirementRow {
  return {
    rid,
    encoded: `A graft never takes on a dead branch. [${rid}]`,
    label: "G-04",
    text: "A graft never takes on a dead branch.",
    section: "7.4 Grafting",
    sectionPath: ["7 Season Play", "7.4 Grafting"],
    sectionNumber: "7.4",
    line: 120,
    span: { start: 4000, end: 4037 },
    kind: "rule",
    source: "extracted",
    owner: "m1",
    ownership: [{ milestoneId: "m1", reason: "covered-section", detail: "7.4 Grafting", atMs: 1 }],
    status,
    checks: [{ kind: "test", testName: `Strada.Acceptance.M1.Acceptance_M1.R1_${rid}`, path: "Assets/StradaAcceptance/M1/Acceptance_M1.cs", bodySha: "b".repeat(64) }],
    last: { revision: "abc12345", runId: "run-1", atMs: 2, outcome: status === "passing" ? "pass" : "fail", detail: "observed 3" },
    gddSha256: "a".repeat(64),
    gddRevision: 1,
    ...overrides,
  };
}

function makeLedger(rows: RequirementRow[]): RequirementLedger {
  return {
    version: 1,
    gddSha256: "a".repeat(64),
    gddRevision: 1,
    extractedAtMs: 1_700_000_000_000,
    rows,
    overflow: { count: 2, sections: ["9 Appendix"] },
    numberingGaps: [{ series: "G-", missing: ["G-07"], detail: "6 G-* label(s) defined (G-01…G-06); the document names G-01 to G-07; G-07 is never defined" }],
    llmAdded: 1,
  };
}

/** Bytes a renderer could plausibly emit: BOM, CRLF, a NUL, Turkish, an emoji, tabs, trailing spaces. */
const TRICKY_SOURCE =
  "﻿using NUnit.Framework;\r\nnamespace Strada.Acceptance.M1 {\r\n\t// REQ r1 — ölü dala aşı tutmaz 🎮\u0000\r\n}\n  ";

function makeAcceptance(overrides: Partial<AcceptanceSource> = {}): AcceptanceSource {
  const source = overrides.source ?? TRICKY_SOURCE;
  return {
    milestoneId: "m1",
    path: "Assets/StradaAcceptance/M1/Acceptance_M1.cs",
    sha256: sha256(Buffer.from(source, "utf8")),
    source,
    writer: { provider: "opencode", model: "cheap-model", independence: "different-model" },
    revisions: 1,
    tests: [{ rid: "r1", testName: "Strada.Acceptance.M1.Acceptance_M1.R1_r1", bodySha: "c".repeat(64) }],
    ...overrides,
  };
}

function makeInput(milestoneId = "m1"): GreenInput {
  return {
    milestoneId,
    mode: "shadow",
    revision: "abc12345",
    compile: { ran: true, ok: true },
    tamper: [],
    own: [makeRow("r1", "failing")],
    regression: [],
    results: { r1: { revision: "abc12345", runId: "run-1", atMs: 5, outcome: "fail", detail: "Expected 3 but was 4 — ünlü" } },
    sources: [makeAcceptance()],
    integrity: { terminalKeys: ["task_stuck"], worst: "task_stuck", source: "spine", workerModels: ["worker-model"] },
    gates: { visualEvidence: "pass", noWork: "pass", art: "not-armed", prosOnly: "pass" },
    proseFailure: false,
  };
}

const RED: Judgement = {
  green: false,
  state: "red",
  reasons: [{ reasonClass: "red", code: "row-failing", detail: "G-04 failed", rid: "r1", testName: "Strada.Acceptance.M1.Acceptance_M1.R1_r1" }],
};
const GREEN: Judgement = { green: true, basis: "proven", caveats: ["terminal key task_stuck overridden: scope proven"] };

type RawDb = { prepare(sql: string): { run(...args: unknown[]): { changes: number }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
const rawDb = (storage: CampaignStorage): RawDb => (storage as unknown as { db: RawDb }).db;

describe("the requirement ledger on the campaign row (GDD plan W03)", () => {
  let dir: string;
  let storage: CampaignStorage;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "campaign-ledger-")); storage = new CampaignStorage(join(dir, "c.db")); });
  afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("round-trips the ledger and when the scope gate first ran", () => {
    const ledger = makeLedger([makeRow("r1", "passing"), makeRow("r2", "open", { bounds: { kind: "range", lo: 0.17, hi: 0.29, unit: "s" } })]);
    storage.save(makeCampaign({ id: "c_ledger", requirements: ledger, scopeGateSince: 1_700_000_123_456 }));

    // Through a second connection, so nothing is served from this one's memory.
    storage.close();
    storage = new CampaignStorage(join(dir, "c.db"));
    const loaded = storage.get("c_ledger")!;
    expect(loaded.requirements).toEqual(ledger);
    expect(loaded.scopeGateSince).toBe(1_700_000_123_456);
    expect(loaded.requirementsUnreadable).toBeUndefined();

    // A campaign with no ledger has none — not an empty one.
    storage.save(makeCampaign({ id: "c_none" }));
    const none = storage.get("c_none")!;
    expect(none.requirements).toBeUndefined();
    expect(none.requirementsUnreadable).toBeUndefined();
    expect(none.scopeGateSince).toBeUndefined();
    expect(none.checkFaults).toBeUndefined();
  });

  it("derives check faults from the rows' status, so the list and the rows cannot disagree", () => {
    // checkFaults is not a column: a row repaired, waived or reopened by an
    // amendment would otherwise stay listed as a fault in a second record.
    const ledger = makeLedger([makeRow("r1", "check-fault"), makeRow("r2", "passing"), makeRow("r3", "check-fault")]);
    storage.save(makeCampaign({ id: "c_faults", requirements: ledger, checkFaults: ["stale-rid"] }));
    expect(storage.get("c_faults")!.checkFaults).toEqual(["r1", "r3"]);

    // The repair landed: the row passes, and the fault is gone with it.
    storage.save(makeCampaign({ id: "c_faults", requirements: makeLedger([makeRow("r1", "passing"), makeRow("r3", "waived")]) }));
    expect(storage.get("c_faults")!.checkFaults).toBeUndefined();
  });

  it("flags an unreadable ledger instead of reading it as no ledger, and a save keeps its bytes", () => {
    const valid = makeLedger([makeRow("r1", "passing")]);
    const withRow = (row: Record<string, unknown>): string => JSON.stringify({ ...valid, rows: [row] });
    const damaged = [
      '{"version":1,"rows":[',
      "[]",
      "null",
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, rows: "r1" }),
      JSON.stringify({ ...valid, gddSha256: 7 }),
      JSON.stringify({ ...valid, overflow: null }),
      withRow({ ...makeRow("r1", "passing"), status: "closed" }),
      withRow({ ...makeRow("r1", "passing"), kind: "vibe" }),
      withRow({ ...makeRow("r1", "passing"), rid: "" }),
      withRow({ ...makeRow("r1", "passing"), checks: undefined }),
      withRow({ ...makeRow("r1", "passing"), ownership: {} }),
      JSON.stringify({ ...valid, rows: [makeRow("r1", "passing"), makeRow("r1", "failing")] }),
      JSON.stringify({ ...valid, rows: [makeRow("r1", "passing"), null] }),
    ];
    for (const [i, raw] of damaged.entries()) {
      const id = `c_bad_${i}`;
      storage.save(makeCampaign({ id, requirements: valid }));
      rawDb(storage).prepare("UPDATE campaigns SET requirements_json = ? WHERE id = ?").run(raw, id);
      const loaded = storage.get(id)!;
      expect({ raw, unreadable: loaded.requirementsUnreadable }).toEqual({ raw, unreadable: true });
      expect(loaded.requirements).toBeUndefined();

      // The next save must not write NULL over the damage (the AF#2 shape):
      // the bytes stay for a person to read, and the flag stays with them.
      storage.save({ ...loaded, state: "failed" });
      const stored = rawDb(storage).prepare("SELECT requirements_json AS r FROM campaigns WHERE id = ?").get(id) as { r: string };
      expect(stored.r).toBe(raw);
      expect(storage.get(id)!.requirementsUnreadable).toBe(true);
      expect(storage.get(id)!.state).toBe("failed");
    }

    // A rebuilt ledger replaces the damage, and the flag clears with it.
    const loaded = storage.get("c_bad_0")!;
    storage.save({ ...loaded, requirements: valid });
    const recovered = storage.get("c_bad_0")!;
    expect(recovered.requirements).toEqual(valid);
    expect(recovered.requirementsUnreadable).toBeUndefined();
  });
});

describe("acceptance files: the canonical bytes (GDD plan W03)", () => {
  let dir: string;
  let storage: CampaignStorage;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "campaign-acceptance-")); storage = new CampaignStorage(join(dir, "c.db")); });
  afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("listAcceptance returns exactly the bytes that were put", () => {
    const file = makeAcceptance();
    storage.putAcceptance("c1", file, 1_000);
    storage.close();
    storage = new CampaignStorage(join(dir, "c.db"));

    const [listed, ...rest] = storage.listAcceptance("c1");
    expect(rest).toEqual([]);
    expect(listed!.source).toBe(TRICKY_SOURCE);
    expect(Buffer.from(listed!.source, "utf8").equals(Buffer.from(TRICKY_SOURCE, "utf8"))).toBe(true);
    expect(sha256(Buffer.from(listed!.source, "utf8"))).toBe(file.sha256);
    expect(listed).toEqual({ ...file, writtenAtMs: 1_000 });
    // The bytes are stored as bytes, not as text an SQL function could cut at the NUL.
    const stored = rawDb(storage).prepare("SELECT typeof(source) AS t, length(source) AS n FROM campaign_acceptance").get() as { t: string; n: number };
    expect(stored).toEqual({ t: "blob", n: Buffer.byteLength(TRICKY_SOURCE, "utf8") });
  });

  it("keys files by campaign and path: a rewrite replaces, other campaigns and milestones are untouched", () => {
    storage.putAcceptance("c1", makeAcceptance(), 1_000);
    storage.putAcceptance("c1", makeAcceptance({ milestoneId: "m2", path: "Assets/StradaAcceptance/M2/Acceptance_M2.cs" }), 1_001);
    storage.putAcceptance("c2", makeAcceptance(), 1_002);

    const rewritten = "namespace Strada.Acceptance.M1 { }\n";
    storage.putAcceptance("c1", makeAcceptance({ source: rewritten, sha256: sha256(rewritten), revisions: 2 }), 2_000);

    const c1 = storage.listAcceptance("c1");
    expect(c1.map((f) => [f.path, f.revisions, f.writtenAtMs])).toEqual([
      ["Assets/StradaAcceptance/M1/Acceptance_M1.cs", 2, 2_000],
      ["Assets/StradaAcceptance/M2/Acceptance_M2.cs", 1, 1_001],
    ]);
    expect(c1[0]!.source).toBe(rewritten);
    expect(storage.listAcceptance("c1", "m2").map((f) => f.milestoneId)).toEqual(["m2"]);
    expect(storage.listAcceptance("c2")[0]!.source).toBe(TRICKY_SOURCE);

    expect(storage.deleteAcceptance("c1", "Assets/StradaAcceptance/M1/Acceptance_M1.cs")).toBe(true);
    expect(storage.deleteAcceptance("c1", "Assets/StradaAcceptance/M1/Acceptance_M1.cs")).toBe(false);
    expect(storage.listAcceptance("c1").map((f) => f.milestoneId)).toEqual(["m2"]);
    expect(storage.listAcceptance("c2")).toHaveLength(1);
  });

  it("refuses to store a file it could not give back identically, or one outside the acceptance folder", () => {
    // A hash that is not the hash of these bytes would make every restore
    // either miss tampering or call a clean file tampered.
    expect(() => storage.putAcceptance("c1", makeAcceptance({ sha256: "0".repeat(64) }), 1)).toThrow(/sha256/);
    // A lone surrogate has no UTF-8 encoding; what came back would not be what was put.
    const lone = "class A { /* \uD800 */ }";
    expect(() => storage.putAcceptance("c1", makeAcceptance({ source: lone, sha256: sha256(Buffer.from(lone, "utf8")) }), 1)).toThrow(/UTF-8/);
    for (const path of [
      "Assets/Scripts/Player.cs",
      "Assets/StradaAcceptance",
      "Assets/StradaAcceptance/../Scripts/Player.cs",
      "Assets/StradaAcceptance/M1/./x.cs",
      "Assets/StradaAcceptance//x.cs",
      "/Assets/StradaAcceptance/M1/x.cs",
      "Assets\\StradaAcceptance\\M1\\x.cs",
      "Assets/StradaAcceptanceX/x.cs",
    ]) {
      expect(() => storage.putAcceptance("c1", makeAcceptance({ path }), 1), path).toThrow(/Assets\/StradaAcceptance/);
    }
    expect(storage.listAcceptance("c1")).toEqual([]);
  });

  it("fails loudly when a stored file no longer hashes to its sha256", () => {
    storage.putAcceptance("c1", makeAcceptance(), 1);
    rawDb(storage).prepare("UPDATE campaign_acceptance SET source = ?").run(Buffer.from("tampered", "utf8"));
    expect(() => storage.listAcceptance("c1")).toThrow(/Acceptance_M1\.cs.*sha256/);
  });

  it("fails loudly when a stored file's writer and tests cannot be read", () => {
    storage.putAcceptance("c1", makeAcceptance(), 1);
    rawDb(storage).prepare("UPDATE campaign_acceptance SET meta_json = ?").run('{"writer":');
    expect(() => storage.listAcceptance("c1")).toThrow(/Acceptance_M1\.cs/);
  });
});

describe("the judge's verdicts are an append-only log (GDD plan W03)", () => {
  let dir: string;
  let storage: CampaignStorage;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "campaign-judgements-")); storage = new CampaignStorage(join(dir, "c.db")); });
  afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("keeps every verdict with the whole input that reached it", () => {
    const input = makeInput();
    const first = storage.appendJudgement({ campaignId: "c1", attemptKey: "m1#2", atMs: 10, input, judgement: RED });
    // The same attempt judged again in the same millisecond (a frozen test
    // clock, a re-measure inside one settle) is a second entry, not an error.
    storage.appendJudgement({ campaignId: "c1", attemptKey: "m1#2", atMs: 10, input, judgement: GREEN });
    storage.appendJudgement({ campaignId: "c1", attemptKey: "m2#1", atMs: 5, input: makeInput("m2"), judgement: GREEN });
    storage.appendJudgement({ campaignId: "c2", attemptKey: "m1#1", atMs: 1, input, judgement: RED });

    storage.close();
    storage = new CampaignStorage(join(dir, "c.db"));
    const m1 = storage.listJudgements("c1", "m1");
    expect(m1.map((j) => j.judgement)).toEqual([RED, GREEN]);
    expect(m1[0]).toEqual({
      campaignId: "c1",
      milestoneId: "m1",
      attemptKey: "m1#2",
      atMs: 10,
      mode: "shadow",
      revision: "abc12345",
      judgement: RED,
      input,
      inputSha256: first.inputSha256,
    });
    expect(first.inputSha256).toBe(sha256(JSON.stringify(input)));
    expect(storage.listJudgements("c1").map((j) => [j.milestoneId, j.atMs])).toEqual([["m2", 5], ["m1", 10], ["m1", 10]]);
    expect(storage.listJudgements("c2")).toHaveLength(1);
    expect(storage.listJudgements("c3")).toEqual([]);
  });

  it("refuses to change or remove a verdict once it is written", () => {
    storage.appendJudgement({ campaignId: "c1", attemptKey: "m1#1", atMs: 1, input: makeInput(), judgement: RED });
    expect(() => rawDb(storage).prepare("UPDATE campaign_judgements SET green = 1").run()).toThrow(/append-only/);
    expect(() => rawDb(storage).prepare("DELETE FROM campaign_judgements").run()).toThrow(/append-only/);
    expect(storage.listJudgements("c1").map((j) => j.judgement)).toEqual([RED]);
    expect(Object.getOwnPropertyNames(CampaignStorage.prototype).filter((m) => /judgement/i.test(m)).sort())
      .toEqual(["appendJudgement", "listJudgements"]);
  });

  it("lists a verdict whose stored input no longer replays, and says why", () => {
    // The verdict stands in the log; only a replay of it is impossible. A
    // dropped entry would read as "never judged".
    storage.appendJudgement({ campaignId: "c1", attemptKey: "m1#1", atMs: 1, input: makeInput(), judgement: RED });
    const db = new Database(join(dir, "c.db"));
    try {
      db.exec("DROP TRIGGER campaign_judgements_no_update");
      db.prepare("UPDATE campaign_judgements SET input_json = ?").run(JSON.stringify({ ...makeInput(), revision: "forged" }));
    } finally {
      db.close();
    }
    const [entry] = storage.listJudgements("c1");
    expect(entry!.judgement).toEqual(RED);
    expect(entry!.input).toBeUndefined();
    expect(entry!.unreadable).toMatch(/sha256/);
  });
});

describe("W03 migrations: an older database gains the ledger columns and the two tables", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "campaign-w03-migrate-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** campaigns.db as every release before W03 left it: all earlier columns, none of W03's. */
  const preW03Database = (path: string): void => {
    new CampaignStorage(path).close();
    const db = new Database(path);
    db.exec("DROP TABLE IF EXISTS campaign_acceptance; DROP TABLE IF EXISTS campaign_judgements;");
    for (const col of ["requirements_json", "scope_gate_since"]) {
      const has = (db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>).some((c) => c.name === col);
      if (has) db.exec(`ALTER TABLE campaigns DROP COLUMN ${col}`);
    }
    db.prepare(`INSERT INTO campaigns (id, chat_id, channel_type, user_id, project_root, state, created_at, updated_at)
      VALUES ('c_old', 'chat', 'cli', 'u', '/p', 'executing', 1, 1)`).run();
    db.close();
  };

  it("opens, gains the columns and tables, and reads NULL as no ledger", () => {
    const path = join(dir, "campaigns.db");
    preW03Database(path);
    const storage = new CampaignStorage(path);
    try {
      const db = rawDb(storage);
      const columns = (db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(["requirements_json", "scope_gate_since"]));
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(["campaign_acceptance", "campaign_judgements"]));

      const old = storage.get("c_old")!;
      expect(old.requirements).toBeUndefined();
      expect(old.requirementsUnreadable).toBeUndefined();
      expect(old.checkFaults).toBeUndefined();
      expect(old.scopeGateSince).toBeUndefined();
      expect(storage.listAcceptance("c_old")).toEqual([]);
      expect(storage.listJudgements("c_old")).toEqual([]);

      // …and the migrated database takes everything W03 stores.
      storage.save({ ...old, requirements: makeLedger([makeRow("r1", "open")]), scopeGateSince: 7 });
      storage.putAcceptance("c_old", makeAcceptance(), 8);
      storage.appendJudgement({ campaignId: "c_old", attemptKey: "m1#1", atMs: 9, input: makeInput(), judgement: RED });
      expect(storage.get("c_old")!.scopeGateSince).toBe(7);
      expect(storage.listAcceptance("c_old")).toHaveLength(1);
      expect(storage.listJudgements("c_old")).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  it("a read-only open of an older database reads no checks and no verdicts instead of throwing", () => {
    // `strada status` opens the daemon's database read-only and never migrates it (COR-22).
    const path = join(dir, "campaigns.db");
    preW03Database(path);
    const storage = new CampaignStorage(path, { readOnly: true });
    try {
      expect(storage.get("c_old")!.requirements).toBeUndefined();
      expect(storage.listAcceptance("c_old")).toEqual([]);
      expect(storage.listJudgements("c_old")).toEqual([]);
    } finally {
      storage.close();
    }
  });
});
