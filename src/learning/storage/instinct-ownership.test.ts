/**
 * Round 10 #3 — ownership is a property of the INSTINCT, not of whichever scope
 * row a query happened to join.
 *
 * Two holes were open after the Wave 3 user-scoping work:
 *
 *  1. `scope_type='user'` with `user_id IS NULL` — a private row written before
 *     the owner was recorded — was handed to EVERY caller. The Wave 3 test
 *     asserted exactly that ("stays reachable"), on the theory that hiding it
 *     would make learning go dark. It does not make learning go dark; it makes
 *     one person's correction everybody's rule. Such a row is quarantined
 *     unless its owner can be recovered from another scope row.
 *
 *  2. The owner clause was evaluated against the JOINED row. `instinct_scopes`
 *     also holds BOOKKEEPING rows (`scope_type='session_hit'`, one per session
 *     that reused the instinct), and those carry no owner — so with
 *     `scopeFilter:'all'` a single bookkeeping row satisfied the clause and
 *     Alice's private instinct came back for Bob.
 *
 * The guard direction: shared project/global learning stays reachable by
 * everyone, including an unidentified caller, and an owner still sees their own.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LearningStorage } from "./learning-storage.js";
import type { Instinct, InstinctId } from "../types.js";
import type { TimestampMs } from "../../types/index.js";

const PROJECT = "/projects/pixelflow";

function makeInstinct(over: Partial<Instinct> = {}): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: `instinct_${Math.random().toString(36).slice(2)}` as InstinctId,
    name: "test instinct",
    type: "correction",
    status: "active",
    confidence: 0.8,
    triggerPattern: "some trigger pattern",
    action: "do the thing",
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
}

describe("instinct ownership is decided per instinct (round 10 #3)", () => {
  let storage: LearningStorage;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  const idsFor = (userId: string | undefined, scopeFilter: "project-only" | "project+universal" | "all" = "all") =>
    storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter, ...(userId ? { userId } : {}) })
      .map((i) => String(i.id));

  it("a private row whose owner was never recorded is quarantined, not broadcast", () => {
    const legacy = makeInstinct({ name: "legacy user rule", triggerPattern: "legacy trigger" });
    storage.createInstinct(legacy);
    storage.addInstinctScopeV2(legacy.id, PROJECT, "user");

    storage.quarantineOwnerlessPrivateInstincts();

    for (const userId of ["alice", "bob", undefined]) {
      expect(idsFor(userId), `ownerless private row reached ${userId ?? "an unidentified caller"}`)
        .not.toContain(String(legacy.id));
    }
    // Quarantined, not deleted: the row is still there to be audited or re-owned.
    expect(storage.getInstinct(legacy.id)?.status).toBe("quarantined");
  });

  it("a private row keeps its owner when the owner is recoverable from another scope row", () => {
    const recoverable = makeInstinct({ name: "alice rule", triggerPattern: "recoverable trigger" });
    storage.createInstinct(recoverable);
    // The ownerless legacy row, plus a later row that names the owner.
    storage.addInstinctScopeV2(recoverable.id, PROJECT, "user");
    storage.addInstinctScopeV2(recoverable.id, "/projects/other", "user", "alice");

    const recovered = storage.quarantineOwnerlessPrivateInstincts();

    expect(recovered.quarantined).toBe(0);
    expect(recovered.ownerRecovered).toBe(1);
    expect(storage.getInstinct(recoverable.id)?.status).toBe("active");
    expect(idsFor("alice")).toContain(String(recoverable.id));
    expect(idsFor("bob")).not.toContain(String(recoverable.id));
    expect(idsFor(undefined)).not.toContain(String(recoverable.id));
  });

  it("an ownerless private row is not returned even before the quarantine sweep runs", () => {
    const legacy = makeInstinct({ name: "legacy user rule", triggerPattern: "legacy trigger two" });
    storage.createInstinct(legacy);
    storage.addInstinctScopeV2(legacy.id, PROJECT, "user");

    for (const userId of ["alice", "bob", undefined]) {
      expect(idsFor(userId)).not.toContain(String(legacy.id));
    }
  });

  it("a bookkeeping (session_hit) row does not admit another owner's instinct", () => {
    const alices = makeInstinct({ name: "alice private", triggerPattern: "alice private trigger" });
    storage.createInstinct(alices);
    storage.addInstinctScopeV2(alices.id, PROJECT, "user", "alice");

    // A cross-session dedup marker: scope_type='session_hit', no owner.
    storage.incrementCrossSessionHitCount(String(alices.id), "session-xyz");

    expect(idsFor("bob", "all"), "a session_hit row let Bob through to Alice's instinct")
      .not.toContain(String(alices.id));
    expect(idsFor(undefined, "all")).not.toContain(String(alices.id));
    expect(idsFor("alice", "all")).toContain(String(alices.id));
  });

  it("GUARD: project and global learning stays reachable for every caller", () => {
    const projectRule = makeInstinct({ name: "project rule", triggerPattern: "project trigger" });
    storage.createInstinct(projectRule);
    storage.addInstinctScopeV2(projectRule.id, PROJECT, "project");

    const globalRule = makeInstinct({ name: "global rule", triggerPattern: "global trigger" });
    storage.createInstinct(globalRule);
    storage.addInstinctScopeV2(globalRule.id, "*", "global");

    // Bookkeeping rows must not hide shared learning either.
    storage.incrementCrossSessionHitCount(String(projectRule.id), "session-1");

    storage.quarantineOwnerlessPrivateInstincts();

    for (const userId of ["alice", "bob", undefined]) {
      const ids = idsFor(userId, "project+universal");
      expect(ids, `project rule went dark for ${userId ?? "an unidentified caller"}`).toContain(String(projectRule.id));
      expect(ids, `global rule went dark for ${userId ?? "an unidentified caller"}`).toContain(String(globalRule.id));
    }
    expect(storage.getInstinct(projectRule.id)?.status).toBe("active");
    expect(storage.getInstinct(globalRule.id)?.status).toBe("active");
  });

  it("GUARD: the quarantine sweep leaves an owned private instinct alone", () => {
    const owned = makeInstinct({ name: "owned private", triggerPattern: "owned trigger" });
    storage.createInstinct(owned);
    storage.addInstinctScopeV2(owned.id, PROJECT, "user", "alice");
    storage.incrementCrossSessionHitCount(String(owned.id), "session-2");

    const result = storage.quarantineOwnerlessPrivateInstincts();

    expect(result.quarantined).toBe(0);
    expect(storage.getInstinct(owned.id)?.status).toBe("active");
    expect(idsFor("alice")).toContain(String(owned.id));
  });
});
