/**
 * Item 3.1 (audit 04.4 / D42) — user-scoped learning must keep its owner.
 *
 * A teaching or correction scoped to ONE user used to lose `userId` on the way
 * in (LearningPipeline.teachExplicit took `_userId` and threw it away),
 * `getInstinctsForScope` had no user filter, `rowToInstinct` never read
 * `scope_type`, and `mergeInstincts` copied only `project_path` — so the
 * loser's user-scoped row came back as a project-scoped row owned by nobody.
 * Net effect: one person's correction became everybody's rule.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LearningStorage } from "./learning-storage.js";
import { LearningPipeline } from "../pipeline/learning-pipeline.js";
import { PatternMatcher } from "../matching/pattern-matcher.js";
import { InstinctRetriever } from "../../agents/instinct-retriever.js";
import type { Instinct, InstinctId } from "../types.js";
import type { TimestampMs } from "../../types/index.js";

const PROJECT = "/projects/pixelflow";

function makeInstinct(over: Partial<Instinct> = {}): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: `instinct_${Math.random().toString(36).slice(2)}` as InstinctId,
    name: "test instinct",
    type: "user_teaching",
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

describe("user-scoped learning keeps its owner (item 3.1)", () => {
  let storage: LearningStorage;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  function makePipeline(): LearningPipeline {
    const pipeline = new LearningPipeline(storage, {
      enabled: true,
      detectionIntervalMs: 1000,
      evolutionIntervalMs: 5000,
      minConfidenceForCreation: 0.5,
      batchSize: 5,
    });
    pipeline.setProjectPath(PROJECT);
    return pipeline;
  }

  it("a teaching scoped to one user is not retrieved in another user's scope", async () => {
    const pipeline = makePipeline();
    const taughtId = await pipeline.teachExplicit(
      "always prefix feature branches with alice/",
      "user",
      "alice",
    );
    pipeline.stop();

    const forBob = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project+universal", userId: "bob" })
      .map((i) => i.id);
    expect(forBob).not.toContain(taughtId);

    const forAlice = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project+universal", userId: "alice" })
      .map((i) => i.id);
    expect(forAlice).toContain(taughtId);
  });

  it("neither user's teaching leaks into the other's scope", async () => {
    const pipeline = makePipeline();
    const aliceId = await pipeline.teachExplicit("alice prefers rebase over merge", "user", "alice");
    const bobId = await pipeline.teachExplicit("bob prefers squashing every branch", "user", "bob");
    pipeline.stop();

    const alice = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "all", userId: "alice" })
      .map((i) => i.id);
    const bob = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "all", userId: "bob" })
      .map((i) => i.id);

    expect(alice).toContain(aliceId);
    expect(alice).not.toContain(bobId);
    expect(bob).toContain(bobId);
    expect(bob).not.toContain(aliceId);
  });

  it("the scope type and owner of a user teaching survive the read path", async () => {
    const pipeline = makePipeline();
    const taughtId = await pipeline.teachExplicit("never edit generated assets", "user", "alice");
    pipeline.stop();

    const read = storage.getInstinct(taughtId);
    expect(read).not.toBeNull();
    expect(read!.scopeType).toBe("user");
    expect(read!.userId).toBe("alice");
  });

  it("a correction records the user who made it", async () => {
    const pipeline = makePipeline();
    await pipeline.recordCorrection({
      original: "Task.Run(() => DoWork())",
      corrected: "UniTask.Run(() => DoWork()) in every MonoBehaviour",
      source: "natural_language",
      userId: "alice",
    });
    pipeline.stop();

    const forAlice = storage.getInstinctsForScope({
      projectPath: PROJECT,
      scopeFilter: "all",
      status: ["proposed", "active", "permanent"],
      userId: "alice",
    });
    const forBob = storage.getInstinctsForScope({
      projectPath: PROJECT,
      scopeFilter: "all",
      status: ["proposed", "active", "permanent"],
      userId: "bob",
    });

    expect(forAlice.length).toBe(1);
    expect(forAlice[0]!.userId).toBe("alice");
    expect(forBob.length).toBe(0);
  });

  it("merging a user-scoped instinct into another does not widen it to the whole project", () => {
    const loser = makeInstinct({ name: "alice private", confidence: 0.6 });
    const winner = makeInstinct({ name: "shared elsewhere", confidence: 0.9 });
    storage.createInstinct(loser);
    storage.createInstinct(winner);
    storage.addInstinctScopeV2(loser.id, PROJECT, "user", "alice");
    storage.addInstinctScopeV2(winner.id, "/projects/other", "project");

    storage.mergeInstincts(winner.id, loser.id);

    const transferred = storage
      .getInstinctScopes(winner.id)
      .find((s) => s.projectPath === PROJECT);
    expect(transferred).toBeDefined();
    expect(transferred!.scopeType).toBe("user");
    expect(transferred!.userId).toBe("alice");

    const forBob = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project-only", userId: "bob" })
      .map((i) => i.id);
    expect(forBob).not.toContain(winner.id);

    const forAlice = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project-only", userId: "alice" })
      .map((i) => i.id);
    expect(forAlice).toContain(winner.id);
  });

  it("the matcher's scope context carries the user, so another user's teaching is no candidate", async () => {
    const pipeline = makePipeline();
    const aliceId = await pipeline.teachExplicit("alice rule about shader compilation", "user", "alice");
    pipeline.stop();

    const matcher = new PatternMatcher(storage);
    const forBob = await matcher.findSimilarInstincts("alice rule about shader compilation", {
      scope: {
        projectPath: PROJECT,
        scopeFilter: "project+universal",
        recencyBoost: 1.0,
        scopeBoost: 1.1,
        userId: "bob",
      },
    });
    expect(forBob.map((m) => m.id)).not.toContain(aliceId);

    const forAlice = await matcher.findSimilarInstincts("alice rule about shader compilation", {
      scope: {
        projectPath: PROJECT,
        scopeFilter: "project+universal",
        recencyBoost: 1.0,
        scopeBoost: 1.1,
        userId: "alice",
      },
    });
    expect(forAlice.map((m) => m.id)).toContain(aliceId);
  });

  it("the retriever asks for the turn's user, so the owner gets their own teaching back", async () => {
    const pipeline = makePipeline();
    const aliceId = await pipeline.teachExplicit("alice rule about shader compilation", "user", "alice");
    pipeline.stop();

    const scopeContext = {
      projectPath: PROJECT,
      scopeFilter: "project+universal" as const,
      recencyBoost: 1.0,
      scopeBoost: 1.1,
    };
    const retriever = new InstinctRetriever(new PatternMatcher(storage), { scopeContext, storage });

    const forAlice = await retriever.getMatchedInstincts(
      "alice rule about shader compilation",
      5,
      "alice",
    );
    expect(forAlice.map((i) => i.id)).toContain(aliceId);

    const forBob = await retriever.getMatchedInstincts(
      "alice rule about shader compilation",
      5,
      "bob",
    );
    expect(forBob.map((i) => i.id)).not.toContain(aliceId);
  });

  // ─── Guards: legitimate sharing still works ────────────────────────────────

  it("project- and global-scoped learning stays visible to every user", async () => {
    const pipeline = makePipeline();
    const projectId = await pipeline.teachExplicit("this repo builds with pnpm", "project");
    pipeline.stop();

    const universal = makeInstinct({ name: "universal rule", triggerPattern: "universal trigger" });
    storage.createInstinct(universal);
    storage.addInstinctScopeV2(universal.id, "*", "global");

    for (const userId of ["alice", "bob", undefined]) {
      const ids = storage
        .getInstinctsForScope({
          projectPath: PROJECT,
          scopeFilter: "project+universal",
          ...(userId ? { userId } : {}),
        })
        .map((i) => i.id);
      expect(ids).toContain(projectId);
      expect(ids).toContain(universal.id);
    }
  });

  it("a user-scoped row with no recorded owner (written before this fix) stays reachable", () => {
    const legacy = makeInstinct({ name: "legacy user rule", triggerPattern: "legacy trigger" });
    storage.createInstinct(legacy);
    storage.addInstinctScopeV2(legacy.id, PROJECT, "user");

    for (const userId of ["alice", "bob"]) {
      const ids = storage
        .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project-only", userId })
        .map((i) => i.id);
      expect(ids).toContain(legacy.id);
    }
  });

  it("an unscoped query (no userId) still returns the project's shared learning", async () => {
    const pipeline = makePipeline();
    const projectId = await pipeline.teachExplicit("run the unity tests before delivery", "project");
    pipeline.stop();

    const ids = storage
      .getInstinctsForScope({ projectPath: PROJECT, scopeFilter: "project-only" })
      .map((i) => i.id);
    expect(ids).toContain(projectId);
  });
});
