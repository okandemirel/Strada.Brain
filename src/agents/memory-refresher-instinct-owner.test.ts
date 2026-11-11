/**
 * In-run re-retrieval of instincts asks for the same person the run's setup
 * asked for (board #60).
 *
 * A delegated run is started as userId "sub-agent" and names its caller in
 * `instinctOwner`. Setup retrieves the caller's instincts; the refresher the
 * session manager builds for the same run re-retrieves them mid-run, so it
 * must ask for the same person, while its memory recall stays the run's own.
 * Real InstinctRetriever, PatternMatcher and LearningStorage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionManagerDeps } from "./orchestrator-session-manager.js";
import { InstinctRetriever } from "./instinct-retriever.js";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import { PatternMatcher } from "../learning/matching/pattern-matcher.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { Instinct, InstinctId } from "../learning/types.js";
import type { TimestampMs } from "../types/index.js";

const PROJECT = "/projects/harbour-stations";
const CHAT = "delegation-chat";
const TRIGGER = "calibrate the anemometer against the reference mast";
const ALICE_RULE = "Alice wants every anemometer calibration logged in knots.";
const BOB_RULE = "Bob wants every anemometer calibration logged in metres per second.";

describe("the in-run refresher re-retrieves instincts for the run's instinct owner", () => {
  let storage: LearningStorage;

  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
    for (const [id, action, owner] of [["inst-alice", ALICE_RULE, "alice"], ["inst-bob", BOB_RULE, "bob"]] as const) {
      const now = Date.now() as TimestampMs;
      storage.createInstinct({
        id: id as InstinctId,
        name: id,
        type: "user_teaching",
        status: "active",
        confidence: 0.9,
        triggerPattern: TRIGGER,
        action,
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
        createdAt: now,
        updatedAt: now,
        sourceTrajectoryIds: [],
        tags: [],
      } as Instinct);
      storage.addInstinctScopeV2(id, PROJECT, "user", owner);
    }
  });

  afterEach(() => {
    storage.close();
  });

  function refresherFor(identity: Parameters<SessionManager["createMemoryRefresher"]>[2]) {
    const retrieve = vi.fn(async () => ({ kind: "ok", value: [] }));
    const sm = new SessionManager({
      channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
      interactionPolicy: { get: vi.fn() },
      activeGoalTrees: new Map(),
      pendingResumeTrees: new Map(),
      instinctRetriever: new InstinctRetriever(new PatternMatcher(storage), {
        scopeContext: { projectPath: PROJECT, scopeFilter: "project+universal", recencyBoost: 1.0, scopeBoost: 1.1 },
        storage,
      }),
      eventEmitter: null,
      memoryManager: { retrieve } as unknown as IMemoryManager,
      reRetrievalConfig: {
        enabled: true,
        interval: 5,
        topicShiftEnabled: true,
        topicShiftThreshold: 0.4,
        maxReRetrievals: 10,
        timeoutMs: 5000,
        memoryLimit: 5,
        ragTopK: 6,
      },
    } as unknown as SessionManagerDeps);
    const refresher = sm.createMemoryRefresher([], CHAT, identity);
    expect(refresher).not.toBeNull();
    return { refresher: refresher!, retrieve };
  }

  it("a delegated run's refresher returns its caller's instinct and keeps recall on the sub-agent", async () => {
    const { refresher, retrieve } = refresherFor({ userId: "sub-agent", instinctOwner: { userId: "alice" }, projectId: PROJECT });

    const result = await refresher.refresh(TRIGGER, "session-1");

    expect(result.newInsights?.join("\n"), "the caller's own learning was not re-retrieved").toContain(ALICE_RULE);
    expect(result.newInsights?.join("\n") ?? "", "another user's private learning was re-retrieved").not.toContain(BOB_RULE);
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ userId: "sub-agent" }) }));
  });

  it("an instinct owner with no person re-retrieves no private learning", async () => {
    const { refresher } = refresherFor({ userId: "alice", instinctOwner: {}, projectId: PROJECT });

    const result = await refresher.refresh(TRIGGER, "session-1");

    const insights = result.newInsights?.join("\n") ?? "";
    expect(insights).not.toContain(ALICE_RULE);
    expect(insights).not.toContain(BOB_RULE);
  });

  it("with no instinct owner the run's own user is asked, as before", async () => {
    const { refresher } = refresherFor({ userId: "bob", projectId: PROJECT });

    const result = await refresher.refresh(TRIGGER, "session-1");

    expect(result.newInsights?.join("\n")).toContain(BOB_RULE);
    expect(result.newInsights?.join("\n")).not.toContain(ALICE_RULE);
  });
});
