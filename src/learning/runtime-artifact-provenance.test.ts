/**
 * ROUND 12 #6 — AN ARTIFACT NOBODY CAN BE ATTRIBUTED TO IS NOT PUBLIC LEARNING.
 *
 * The round 11 #1 boot sweep re-derives ownership for every legacy
 * `owner_scope='unknown'` runtime artifact from the source instincts still on
 * disk. Its own doc says "a row whose sources are all gone cannot be attributed
 * to anybody, and guessing 'public' is the leak" — but that guard only fired for
 * a source list that NAMED somebody. A row whose provenance is
 *
 *   - `[]`                 (no source recorded at all),
 *   - `{oops`              (unreadable JSON), or
 *   - `"instinct_a"`       (not even a list),
 *
 * carried no ids to check, so the sweep fell through to `public` and published
 * it to every caller, identified or not — exactly what 'unknown' exists to
 * prevent. Production never writes an empty source list (a runtime artifact is
 * materialized FROM an instinct), so such a row is either corruption or a
 * hand-written row: unattributable either way.
 *
 * THE OPPOSITE ERROR IS THE OTHER HALF OF THE TEST. Refusing to publish what
 * cannot be attributed must NOT narrow shared learning: a legacy row whose
 * source is a project-scoped instinct still reaches everybody, and one whose
 * source is Alice's private rule still reaches Alice.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "./storage/learning-storage.js";
import { RuntimeArtifactManager, createProjectScopeFingerprint } from "./runtime-artifact-manager.js";
import type { Instinct, InstinctId, RuntimeArtifact } from "./types.js";
import type { TimestampMs } from "../types/index.js";

const PROJECT = "/projects/pixelflow";
const SCOPE = createProjectScopeFingerprint(PROJECT);

const TASK = {
  taskDescription: "Fix the pooling compile error and rerun the build",
  taskType: "debugging" as const,
  projectWorldFingerprint: SCOPE,
  availableToolNames: [] as readonly string[],
};

let dir: string;
let dbPath: string;
let storage: LearningStorage;
let manager: RuntimeArtifactManager;

function makeInstinct(over: Partial<Instinct> & { id: string }): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: over.id as InstinctId,
    name: over.name ?? "pooling compile rule",
    type: over.type ?? "tool_usage",
    status: over.status ?? "active",
    confidence: over.confidence ?? 0.95,
    triggerPattern: over.triggerPattern ?? "pooling compile error in the build",
    action: over.action ?? "Read the compile output, inspect the pooling files, rerun the build",
    contextConditions: over.contextConditions ?? [],
    stats: { timesSuggested: 9, timesApplied: 9, timesFailed: 0, successRate: 1, averageExecutionMs: 10 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
}

/** Materialize `instinct`'s artifact and take it through to `active`. */
function promote(instinct: Instinct): RuntimeArtifact {
  const { artifact } = manager.materializeShadowArtifact(instinct, PROJECT);
  for (let i = 0; i < 5; i++) {
    manager.recordEvaluation({
      artifactIds: [artifact.id],
      presentedInstinctIds: [String(instinct.id)],
      verdict: "clean",
      blocker: false,
      reason: "Verifier clean with the guidance in the prompt.",
    });
  }
  const promoted = storage.getRuntimeArtifact(artifact.id);
  expect(promoted?.state, "fixture did not reach 'active'").toBe("active");
  return promoted!;
}

/**
 * Put a row on disk in the shape the finding describes: ownership never
 * recorded, provenance unusable. Written through a second connection because
 * the typed API cannot express malformed JSON — the same SQLite probe the
 * finding used.
 */
function corruptProvenance(artifactId: string, rawSourceInstinctIds: string): void {
  storage.flush();
  const probe = new Database(dbPath);
  try {
    probe
      .prepare(
        "UPDATE runtime_artifacts SET source_instinct_ids = ?, owner_scope = 'unknown', owner_user_id = NULL WHERE id = ?",
      )
      .run(rawSourceInstinctIds, artifactId);
  } finally {
    probe.close();
  }
}

/** What is actually stored, read past every typed accessor. */
function storedOwnership(artifactId: string): { owner_scope: string | null; owner_user_id: string | null } {
  storage.flush();
  const probe = new Database(dbPath, { readonly: true });
  try {
    return probe.prepare("SELECT owner_scope, owner_user_id FROM runtime_artifacts WHERE id = ?").get(artifactId) as {
      owner_scope: string | null;
      owner_user_id: string | null;
    };
  } finally {
    probe.close();
  }
}

function guidanceIdsFor(userId: string | undefined): string[] {
  const matches = manager.matchForTask({ ...TASK, ...(userId ? { userId } : {}) });
  return [...matches.active, ...matches.shadow].map((m) => String(m.artifact.id));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-provenance-"));
  dbPath = join(dir, "learning.db");
  storage = new LearningStorage(dbPath);
  storage.initialize();
  manager = new RuntimeArtifactManager(storage);
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the boot sweep publishes only what it can attribute (round 12 #6)", () => {
  /** A promoted artifact whose provenance is then made unusable. */
  function legacyArtifactWith(rawSources: string): string {
    const instinct = makeInstinct({ id: `instinct_${Math.random().toString(36).slice(2, 8)}`, scopeType: "project" });
    storage.createInstinct(instinct, PROJECT);
    const artifact = promote(instinct);
    corruptProvenance(String(artifact.id), rawSources);
    return String(artifact.id);
  }

  it("PROOF: a legacy row with NO recorded source is quarantined, not published", () => {
    const id = legacyArtifactWith("[]");

    const swept = storage.quarantineUnownedRuntimeArtifacts();

    // TEETH: before the fix this was { madePublic: 1, quarantined: 0 }.
    expect(swept, "an artifact with no provenance at all was published").toMatchObject({
      madePublic: 0,
      ownerRecovered: 0,
      quarantined: 1,
    });
    expect(storedOwnership(id).owner_scope).toBe("unknown");
    for (const userId of ["alice", "bob", undefined]) {
      expect(guidanceIdsFor(userId), `an unattributable artifact reached ${userId ?? "an unidentified caller"}`)
        .not.toContain(id);
    }
  });

  it("PROOF: a legacy row whose source list is unreadable JSON is quarantined, not published", () => {
    const id = legacyArtifactWith("{oops");

    const swept = storage.quarantineUnownedRuntimeArtifacts();

    expect(swept, "an artifact with malformed provenance was published").toMatchObject({
      madePublic: 0,
      quarantined: 1,
    });
    expect(storedOwnership(id).owner_scope).toBe("unknown");
  });

  it("PROOF: a legacy row whose source list is not a list is quarantined, not published", () => {
    const id = legacyArtifactWith('"instinct_a"');

    const swept = storage.quarantineUnownedRuntimeArtifacts();

    expect(swept, "an artifact whose provenance is not a list was published").toMatchObject({
      madePublic: 0,
      quarantined: 1,
    });
    expect(storedOwnership(id).owner_scope).toBe("unknown");
    for (const userId of ["alice", "bob", undefined]) {
      expect(guidanceIdsFor(userId), `an unattributable artifact reached ${userId ?? "an unidentified caller"}`)
        .not.toContain(id);
    }
  });

  it("GUARD: shared learning is still published — a legacy row with a live project source reaches everybody", () => {
    const shared = makeInstinct({ id: "instinct_shared_legacy", scopeType: "project" });
    storage.createInstinct(shared, PROJECT);
    const artifact = promote(shared);
    storage.debugClearRuntimeArtifactOwnership(String(artifact.id));

    const swept = storage.quarantineUnownedRuntimeArtifacts();

    // The privacy fix must not take attributable learning dark.
    expect(swept, "shared legacy learning was quarantined instead of published").toMatchObject({
      madePublic: 1,
      quarantined: 0,
    });
    expect(storedOwnership(String(artifact.id)).owner_scope).toBe("public");
    for (const userId of ["alice", "bob", undefined]) {
      expect(guidanceIdsFor(userId), `shared learning went dark for ${userId ?? "an unidentified caller"}`).toContain(
        String(artifact.id),
      );
    }
  });

  it("GUARD: a legacy row with one live private source is still adopted by its owner, not quarantined", () => {
    const alices = makeInstinct({ id: "instinct_alice_legacy", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const artifact = promote(alices);
    storage.debugClearRuntimeArtifactOwnership(String(artifact.id));

    const swept = storage.quarantineUnownedRuntimeArtifacts();

    expect(swept).toMatchObject({ ownerRecovered: 1, madePublic: 0, quarantined: 0 });
    expect(storedOwnership(String(artifact.id))).toMatchObject({ owner_scope: "user", owner_user_id: "alice" });
    expect(guidanceIdsFor("alice")).toContain(String(artifact.id));
    expect(guidanceIdsFor("bob")).not.toContain(String(artifact.id));
  });

  it("a quarantined row stays auditable: a corrupt source list does not make it unreadable", () => {
    // The human who has to decide whose it was must be able to SEE it. An
    // ungated audit read used to throw on the malformed JSON, so the row that
    // most needs a decision was the one nobody could list.
    const id = legacyArtifactWith("{oops");
    storage.quarantineUnownedRuntimeArtifacts();

    const all = storage.getRuntimeArtifacts({}).map((a) => String(a.id));
    expect(all, "a corrupt provenance row cannot be audited at all").toContain(id);
    expect(storage.getRuntimeArtifact(id as RuntimeArtifact["id"])?.sourceInstinctIds).toEqual([]);
  });
});
