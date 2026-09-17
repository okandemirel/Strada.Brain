/**
 * ROUND 11 #6 — LEGACY OWNERSHIP RECOVERY MUST NOT PICK AN OWNER.
 *
 * `quarantineOwnerlessPrivateInstincts` (round 10 #3) recovers the owner of an
 * ownerless private row from the instinct's other scope rows. It took the FIRST
 * non-null `user_id` it found, ordered by `created_at`, with no uniqueness
 * check and no restriction on which KIND of row it came from. Two consequences:
 *
 *  1. An instinct with private rows for two different people was ADOPTED by
 *     whichever row happened to sort first — it stayed active for that person
 *     and silently vanished for the other, instead of being held out as
 *     ambiguous.
 *  2. A `project` row (or any other bookkeeping association) that happens to
 *     carry a `user_id` established PRIVATE ownership, which it has no
 *     authority to do.
 *
 * Retrieval had the same hole independently: the effective-owner subquery
 * ordered by scope then `project_path` and took one row, so a two-owner
 * instinct answered "the owner is whoever sorts first" even before any sweep.
 *
 * The guard direction: a single recorded owner is still recovered, shared
 * project/global learning is untouched, and an owned private instinct keeps
 * working for its owner.
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

describe("legacy ownership recovery recovers a UNIQUE owner or quarantines (r11 #6)", () => {
  let storage: LearningStorage;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  const idsFor = (userId: string | undefined) =>
    storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "all", ...(userId ? { userId } : {}) })
      .map((i) => String(i.id));

  it("PROOF: two private owners are quarantined as ambiguous, not adopted by one of them", () => {
    const disputed = makeInstinct({ name: "disputed rule", triggerPattern: "disputed trigger" });
    storage.createInstinct(disputed);
    // The legacy ownerless private row, plus private rows for two people.
    storage.addInstinctScopeV2(disputed.id, PROJECT, "user");
    storage.addInstinctScopeV2(disputed.id, "/projects/a-alice", "user", "alice");
    storage.addInstinctScopeV2(disputed.id, "/projects/z-bob", "user", "bob");

    const swept = storage.quarantineOwnerlessPrivateInstincts();

    // TEETH: the unfixed sweep reported ownerRecovered=1 and left the instinct
    // active for whichever owner sorted first.
    expect(swept.ownerRecovered).toBe(0);
    expect(swept.quarantined).toBe(1);
    expect(storage.getInstinct(disputed.id)?.status).toBe("quarantined");
    for (const userId of ["alice", "bob", undefined]) {
      expect(idsFor(userId), `an ambiguously-owned rule was assigned to ${userId ?? "an unidentified caller"}`)
        .not.toContain(String(disputed.id));
    }
  });

  it("PROOF (reversed insertion and project-path order): the answer does not depend on row order", () => {
    const disputed = makeInstinct({ name: "disputed reversed", triggerPattern: "disputed reversed trigger" });
    storage.createInstinct(disputed);
    // Bob first, and on the project path that sorts FIRST — the two levers the
    // unfixed code's answer depended on.
    storage.addInstinctScopeV2(disputed.id, "/projects/a-bob", "user", "bob");
    storage.addInstinctScopeV2(disputed.id, "/projects/z-alice", "user", "alice");
    storage.addInstinctScopeV2(disputed.id, PROJECT, "user");

    expect(storage.quarantineOwnerlessPrivateInstincts().quarantined).toBe(1);
    for (const userId of ["alice", "bob", undefined]) {
      expect(idsFor(userId)).not.toContain(String(disputed.id));
    }
  });

  it("PROOF: a project row carrying a user id does not establish private ownership", () => {
    const legacy = makeInstinct({ name: "project row owner", triggerPattern: "project row trigger" });
    storage.createInstinct(legacy);
    storage.addInstinctScopeV2(legacy.id, PROJECT, "user");
    // A project association that happens to name a user — not an ownership record.
    storage.addInstinctScopeV2(legacy.id, "/projects/other", "project", "alice");

    const swept = storage.quarantineOwnerlessPrivateInstincts();

    // TEETH: the unfixed sweep adopted 'alice' from the PROJECT row.
    expect(swept.ownerRecovered).toBe(0);
    expect(swept.quarantined).toBe(1);
    expect(idsFor("alice")).not.toContain(String(legacy.id));
  });

  it("an ambiguously-owned private rule reaches nobody even before the sweep runs", () => {
    const disputed = makeInstinct({ name: "disputed unswept", triggerPattern: "disputed unswept trigger" });
    storage.createInstinct(disputed);
    storage.addInstinctScopeV2(disputed.id, "/projects/a-alice", "user", "alice");
    storage.addInstinctScopeV2(disputed.id, "/projects/z-bob", "user", "bob");

    for (const userId of ["alice", "bob", undefined]) {
      expect(idsFor(userId), `retrieval handed a two-owner rule to ${userId ?? "an unidentified caller"}`)
        .not.toContain(String(disputed.id));
    }
  });

  it("a bookkeeping-only instinct has no recoverable owner and is quarantined", () => {
    const legacy = makeInstinct({ name: "bookkeeping only", triggerPattern: "bookkeeping trigger" });
    storage.createInstinct(legacy);
    storage.addInstinctScopeV2(legacy.id, PROJECT, "user");
    storage.incrementCrossSessionHitCount(String(legacy.id), "session-abc");

    expect(storage.quarantineOwnerlessPrivateInstincts()).toMatchObject({ ownerRecovered: 0, quarantined: 1 });
  });

  it("GUARD: a single recorded owner is still recovered and the rule keeps working for her", () => {
    const recoverable = makeInstinct({ name: "alice rule", triggerPattern: "recoverable trigger" });
    storage.createInstinct(recoverable);
    storage.addInstinctScopeV2(recoverable.id, PROJECT, "user");
    storage.addInstinctScopeV2(recoverable.id, "/projects/other", "user", "alice");
    // The same owner recorded twice is still ONE owner.
    storage.addInstinctScopeV2(recoverable.id, "/projects/third", "user", "alice");

    const swept = storage.quarantineOwnerlessPrivateInstincts();

    expect(swept).toMatchObject({ ownerRecovered: 1, quarantined: 0 });
    expect(storage.getInstinct(recoverable.id)?.status).toBe("active");
    expect(idsFor("alice")).toContain(String(recoverable.id));
    expect(idsFor("bob")).not.toContain(String(recoverable.id));
  });

  it("GUARD: shared project and global learning is untouched by the sweep", () => {
    const projectRule = makeInstinct({ name: "project rule", triggerPattern: "project trigger" });
    storage.createInstinct(projectRule);
    storage.addInstinctScopeV2(projectRule.id, PROJECT, "project", "alice");

    const globalRule = makeInstinct({ name: "global rule", triggerPattern: "global trigger" });
    storage.createInstinct(globalRule);
    storage.addInstinctScopeV2(globalRule.id, "*", "global");

    expect(storage.quarantineOwnerlessPrivateInstincts()).toMatchObject({ ownerRecovered: 0, quarantined: 0 });
    for (const userId of ["alice", "bob", undefined]) {
      const ids = storage
        .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project+universal", ...(userId ? { userId } : {}) })
        .map((i) => String(i.id));
      expect(ids, `project rule went dark for ${userId ?? "an unidentified caller"}`).toContain(String(projectRule.id));
      expect(ids, `global rule went dark for ${userId ?? "an unidentified caller"}`).toContain(String(globalRule.id));
    }
  });
});
