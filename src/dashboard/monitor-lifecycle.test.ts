import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMonitorLifecycle } from "./monitor-lifecycle.js";
import type { WorkspaceBus } from "./workspace-bus.js";
import type { GoalTree, GoalNode, GoalNodeId } from "../goals/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBus(): WorkspaceBus & { calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  return {
    calls,
    emit(event: string, payload: unknown) {
      calls.push({ event, payload });
    },
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceBus & { calls: Array<{ event: string; payload: unknown }> };
}

function makeGoalTree(overrides?: Partial<GoalTree>): GoalTree {
  const rootId = "goal_root" as GoalNodeId;
  const childId = "goal_child_1" as GoalNodeId;
  const now = Date.now();
  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, {
    id: rootId,
    parentId: null,
    task: "Root task",
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  nodes.set(childId, {
    id: childId,
    parentId: rootId,
    task: "Child task",
    dependsOn: [],
    depth: 1,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return {
    rootId,
    sessionId: "test-session",
    taskDescription: "Test goal tree",
    nodes,
    createdAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMonitorLifecycle", () => {
  let bus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    bus = createMockBus();
  });

  it("returns an object with the expected methods", () => {
    const lc = createMonitorLifecycle(bus);
    expect(typeof lc.requestStart).toBe("function");
    expect(typeof lc.goalDecomposed).toBe("function");
    expect(typeof lc.goalRestructured).toBe("function");
    expect(typeof lc.requestEnd).toBe("function");
  });

  // =========================================================================
  // requestStart
  // =========================================================================

  describe("requestStart", () => {
    it("emits a monitor:dag_init event with a single executing node", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "Hello world");

      expect(bus.calls).toHaveLength(1);
      const { event, payload } = bus.calls[0]!;
      expect(event).toBe("monitor:dag_init");

      const p = payload as { rootId: string; conversationId?: string; nodes: Array<Record<string, unknown>>; edges: unknown[] };
      expect(p.nodes).toHaveLength(1);
      expect(p.edges).toHaveLength(0);
      // Conversation scope is attached for per-conversation root grouping.
      expect(p.conversationId).toBe("scope-1");

      const node = p.nodes[0]!;
      // The episode model decouples the episode root (`ep-…`) from the per-request
      // Kanban card node (`req-…`): a continued request adds a NEW card to the SAME
      // episode root, so the card node id is distinct from the rootId.
      expect(p.rootId).toMatch(/^ep-/);
      expect(node.id).toMatch(/^req-/);
      expect(node.id).not.toBe(p.rootId);
      expect(node.status).toBe("executing");
      expect(node.reviewStatus).toBe("none");
      expect(node.depth).toBe(1);
      expect(node.dependsOn).toEqual([]);
    });

    it("emits an episode rootId matching the ep-<uuid> pattern with a req-<uuid> node id", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");

      const p = bus.calls[0]!.payload as { rootId: string; nodes: Array<{ id: string }> };
      expect(p.rootId).toMatch(/^ep-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(p.nodes[0]!.id).toMatch(/^req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("truncates messages longer than 200 characters and appends ellipsis", () => {
      const lc = createMonitorLifecycle(bus);
      const longMessage = "A".repeat(250);
      lc.requestStart("scope-1", longMessage);

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      const task = p.nodes[0]!.task;
      expect(task).toHaveLength(201); // 200 chars + 1 ellipsis char
      expect(task.endsWith("\u2026")).toBe(true);
      expect(task.startsWith("A")).toBe(true);
    });

    it("preserves messages exactly at the 200-character limit", () => {
      const lc = createMonitorLifecycle(bus);
      const exactMessage = "B".repeat(200);
      lc.requestStart("scope-1", exactMessage);

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      expect(p.nodes[0]!.task).toBe(exactMessage);
    });

    it("preserves short messages without truncation", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "Short msg");

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      expect(p.nodes[0]!.task).toBe("Short msg");
    });

    it("continues the SAME episode for a follow-up request that arrives while the prior one is still in-progress", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      // No requestEnd between them: the active episode is still in-progress, so the
      // follow-up JOINS it (same episode root) with its own fresh Kanban card.
      lc.requestStart("scope-1", "second");

      const first = bus.calls[0]!.payload as { rootId: string; nodes: Array<{ id: string }> };
      const second = bus.calls[1]!.payload as { rootId: string; nodes: Array<{ id: string }> };
      // Same EPISODE root → the follow-up updates the existing board in place.
      expect(second.rootId).toBe(first.rootId);
      // Distinct CARD node ids → the follow-up is its own Kanban item, not a clobber.
      expect(second.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
    });

    it("opens a NEW episode after the prior one went terminal (complete)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      const firstEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;
      // The active task goes terminal → the episode is closed (kept, marked terminal).
      lc.requestEnd("scope-1");
      // The next request rolls over to a fresh episode/workspace.
      lc.requestStart("scope-1", "second");
      const secondEpisode = (bus.calls[bus.calls.length - 1]!.payload as { rootId: string }).rootId;

      expect(secondEpisode).not.toBe(firstEpisode);
      expect(secondEpisode).toMatch(/^ep-/);
    });

    it("opens a NEW episode after the prior one went terminal (failed)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      const firstEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;
      // ANY terminal status closes the episode (uniform any-terminal-closes policy).
      lc.requestEnd("scope-1", true);
      lc.requestStart("scope-1", "second");
      const secondEpisode = (bus.calls[bus.calls.length - 1]!.payload as { rootId: string }).rootId;

      expect(secondEpisode).not.toBe(firstEpisode);
    });

    it("rolls over even on a same-tick re-entrant requestStart after requestEnd (terminal entry kept, not deleted)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      const firstEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;
      // requestEnd marks terminal without deleting the entry, so a synchronous
      // re-entrant requestStart still observes `terminal` and rolls over.
      lc.requestEnd("scope-1");
      lc.requestStart("scope-1", "second");
      const secondEpisode = (bus.calls[bus.calls.length - 1]!.payload as { rootId: string }).rootId;
      expect(secondEpisode).not.toBe(firstEpisode);
    });
  });

  // =========================================================================
  // requestEnd
  // =========================================================================

  describe("requestEnd", () => {
    it("emits monitor:task_update with status completed on success", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const startPayload = bus.calls[0]!.payload as { rootId: string; nodes: Array<{ id: string }> };
      const episodeId = startPayload.rootId;
      const cardId = startPayload.nodes[0]!.id;

      lc.requestEnd("scope-1");

      expect(bus.calls).toHaveLength(2);
      const { event, payload } = bus.calls[1]!;
      expect(event).toBe("monitor:task_update");
      // The settle targets the EPISODE root + the request's CARD node id.
      expect(payload).toEqual({
        rootId: episodeId,
        nodeId: cardId,
        status: "completed",
        conversationId: "scope-1",
      });
    });

    it("emits monitor:task_update with status failed when failed=true", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const startPayload = bus.calls[0]!.payload as { rootId: string; nodes: Array<{ id: string }> };
      const episodeId = startPayload.rootId;
      const cardId = startPayload.nodes[0]!.id;

      lc.requestEnd("scope-1", true);

      const { payload } = bus.calls[1]!;
      expect(payload).toEqual({
        rootId: episodeId,
        nodeId: cardId,
        status: "failed",
        conversationId: "scope-1",
      });
    });

    it("is a no-op when called without a prior requestStart", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestEnd("unknown-scope");

      expect(bus.calls).toHaveLength(0);
    });

    it("is a no-op on the second call (already cleaned up)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      lc.requestEnd("scope-1");
      lc.requestEnd("scope-1"); // second call

      // Only dag_init + one task_update
      expect(bus.calls).toHaveLength(2);
    });
  });

  // =========================================================================
  // goalDecomposed
  // =========================================================================

  describe("goalDecomposed", () => {
    it("emits monitor:dag_init with the converted goal tree payload", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const episodeId = (bus.calls[0]!.payload as { rootId: string }).rootId;
      const goalTree = makeGoalTree();

      lc.goalDecomposed("scope-1", goalTree);

      // requestStart (dag_init) + settle the simple node (task_update) + the
      // decomposed tree (dag_init).
      expect(bus.calls).toHaveLength(3);
      const { event, payload } = bus.calls[2]!;
      expect(event).toBe("monitor:dag_init");

      const p = payload as { rootId: string; conversationId?: string; nodes: unknown[]; edges: unknown[] };
      // rootId is overridden to the EPISODE id so decomposition grows the active
      // board rather than spraying a sibling root keyed by the goal tree's own id.
      expect(p.rootId).toBe(episodeId);
      expect(p.rootId).not.toBe("goal_root");
      // goalTreeToDagPayload skips the root node, so only child is included
      expect(p.nodes).toHaveLength(1);
      // Conversation scope threaded through for per-conversation grouping.
      expect(p.conversationId).toBe("scope-1");
    });

    it("settles the superseded simple node to completed before emitting the tree", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const startPayload = bus.calls[0]!.payload as { rootId: string; nodes: Array<{ id: string }> };
      const episodeId = startPayload.rootId;
      const cardId = startPayload.nodes[0]!.id;

      lc.goalDecomposed("scope-1", makeGoalTree());

      // The settle is the second emit: a terminal task_update for the simple node
      // so its Kanban card doesn't linger "executing" once the tree replaces it.
      // It targets the EPISODE root + the request's CARD node id.
      const settle = bus.calls[1]!;
      expect(settle.event).toBe("monitor:task_update");
      expect(settle.payload).toMatchObject({
        rootId: episodeId,
        nodeId: cardId,
        status: "completed",
      });
    });

    it("emits the decomposed goal tree UNDER the episode root (not a sibling goalTree root)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const episodeId = (bus.calls[0]!.payload as { rootId: string }).rootId;

      lc.goalDecomposed("scope-1", makeGoalTree());

      // The decomposition dag_init is the third emit; its rootId is overridden to
      // the episodeId so the tree grows THIS board rather than spraying a sibling.
      const tree = bus.calls[2]!;
      expect(tree.event).toBe("monitor:dag_init");
      expect((tree.payload as { rootId: string }).rootId).toBe(episodeId);
      expect((tree.payload as { rootId: string }).rootId).not.toBe("goal_root");
    });

    it("emits a restructure UNDER the active episode root", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      const episodeId = (bus.calls[0]!.payload as { rootId: string }).rootId;
      lc.goalDecomposed("scope-1", makeGoalTree());

      lc.goalRestructured("scope-1", makeGoalTree());

      const restructure = bus.calls[bus.calls.length - 1]!;
      expect(restructure.event).toBe("monitor:dag_restructure");
      expect((restructure.payload as { rootId: string }).rootId).toBe(episodeId);
    });

    it("settles the simple task on decomposition so requestEnd adds no card task_update", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      lc.goalDecomposed("scope-1", makeGoalTree());

      lc.requestEnd("scope-1"); // no card left to settle (consumed by decomposition)

      // dag_init (requestStart) + task_update (settle simple node) +
      // dag_init (goalDecomposed). requestEnd adds nothing — tracking cleared.
      expect(bus.calls).toHaveLength(3);
      expect(bus.calls.filter(c => c.event === "monitor:task_update")).toHaveLength(1);
    });

    it("works even without a prior requestStart (no simple node to settle)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.goalDecomposed("scope-1", makeGoalTree());

      // No tracked simple node → no settle task_update, just the tree.
      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0]!.event).toBe("monitor:dag_init");
    });
  });

  // =========================================================================
  // goalRestructured
  // =========================================================================

  describe("goalRestructured", () => {
    it("emits monitor:dag_restructure with the converted goal tree payload", () => {
      const lc = createMonitorLifecycle(bus);
      const goalTree = makeGoalTree();

      lc.goalRestructured("scope-1", goalTree);

      expect(bus.calls).toHaveLength(1);
      const { event, payload } = bus.calls[0]!;
      expect(event).toBe("monitor:dag_restructure");

      const p = payload as { rootId: string; conversationId?: string; nodes: unknown[] };
      expect(p.rootId).toBe("goal_root");
      // goalRestructured now uses (not discards) the conversation scope param.
      expect(p.conversationId).toBe("scope-1");
    });
  });

  // =========================================================================
  // Multiple concurrent scopes
  // =========================================================================

  describe("multiple concurrent scopes", () => {
    it("tracks lifecycles independently per scope", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-A", "msg A");
      lc.requestStart("scope-B", "msg B");

      const idA = (bus.calls[0]!.payload as { rootId: string }).rootId;
      const idB = (bus.calls[1]!.payload as { rootId: string }).rootId;
      expect(idA).not.toBe(idB);

      // End scope-A only
      lc.requestEnd("scope-A");

      expect(bus.calls).toHaveLength(3);
      const endPayload = bus.calls[2]!.payload as { rootId: string; status: string };
      expect(endPayload.rootId).toBe(idA);
      expect(endPayload.status).toBe("completed");

      // End scope-B separately
      lc.requestEnd("scope-B");
      const endPayloadB = bus.calls[3]!.payload as { rootId: string; status: string };
      expect(endPayloadB.rootId).toBe(idB);
    });

    it("goalDecomposed on one scope does not affect another", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-A", "msg A");
      lc.requestStart("scope-B", "msg B");

      const idB = (bus.calls[1]!.payload as { rootId: string }).rootId;

      // Decompose scope-A only
      lc.goalDecomposed("scope-A", makeGoalTree());

      // scope-A requestEnd should be no-op
      lc.requestEnd("scope-A");

      // scope-B requestEnd should still work
      lc.requestEnd("scope-B");
      const lastCall = bus.calls[bus.calls.length - 1]!;
      expect(lastCall.event).toBe("monitor:task_update");
      expect((lastCall.payload as { rootId: string }).rootId).toBe(idB);
    });
  });

  // =========================================================================
  // Whole-goal monitor unit (workers/sub-goals roll up to the PARENT episode)
  // =========================================================================

  describe("whole-goal monitor unit (monitorScope rollup)", () => {
    it("a worker presenting the parent monitorScope JOINs the parent episode (NO new episode)", () => {
      const lc = createMonitorLifecycle(bus);
      // The whole-goal ROOT run opens the episode under the parent scope.
      lc.requestStart("parent-scope", "root request");
      const parentEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;

      // A worker runs under its OWN fresh chatId scope, but stamps the parent
      // monitorScope → it must roll up to the parent episode, not mint a sibling.
      lc.joinEpisode("worker-scope-1", "sub-goal A", "parent-scope");

      const joinPayload = bus.calls[1]!.payload as { rootId: string; conversationId: string; nodes: Array<{ id: string }> };
      // SAME episode root → one workspace for the whole goal.
      expect(joinPayload.rootId).toBe(parentEpisode);
      // The emitted conversationId is the PARENT scope → the frontend RootSwitcher
      // groups the worker card under the parent conversation, NOT a new one.
      expect(joinPayload.conversationId).toBe("parent-scope");
      // Its own fresh CARD node → a distinct Kanban item inside the one board.
      expect(joinPayload.nodes[0]!.id).toMatch(/^req-/);
    });

    it("multiple workers all roll up to the ONE parent episode (no spray)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("parent-scope", "decomposed request");
      const parentEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;

      // 3 sub-goal workers, each with its own fresh chatId scope (the screenshot bug).
      lc.joinEpisode("worker-1", "Analyze the current AI level", "parent-scope");
      lc.joinEpisode("worker-2", "Implement a level solvability check", "parent-scope");
      lc.joinEpisode("worker-3", "Write tests", "parent-scope");

      const dagInits = bus.calls.filter((c) => c.event === "monitor:dag_init");
      const rootIds = dagInits.map((c) => (c.payload as { rootId: string }).rootId);
      const conversationIds = dagInits.map((c) => (c.payload as { conversationId: string }).conversationId);

      // ONE conversation/episode — all 4 dag_inits share the parent episode + scope.
      expect(new Set(rootIds)).toEqual(new Set([parentEpisode]));
      expect(new Set(conversationIds)).toEqual(new Set(["parent-scope"]));
    });

    it("joinEpisode is a no-op when NO parent episode is open (never mints a sibling)", () => {
      const lc = createMonitorLifecycle(bus);
      // No requestStart for the parent scope → the worker stays monitor-silent.
      lc.joinEpisode("worker-scope", "orphan sub-goal", "parent-scope");
      expect(bus.calls).toHaveLength(0);
    });

    it("joinEpisode does not mint nor roll the parent episode over (stays open while workers run)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("parent-scope", "root");
      const parentEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;
      lc.joinEpisode("worker-1", "sub", "parent-scope");

      // A subsequent ROOT requestStart on the parent scope (while still in-progress)
      // continues the SAME episode — proof the worker join did NOT terminate it.
      lc.requestStart("parent-scope", "follow-up");
      const followUp = bus.calls[bus.calls.length - 1]!.payload as { rootId: string };
      expect(followUp.rootId).toBe(parentEpisode);
    });

    it("the episode stays OPEN while a sub-task completes (joinEpisodeEnd does NOT mark terminal)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("parent-scope", "root");
      const parentEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;

      lc.joinEpisode("worker-1", "sub-goal A", "parent-scope");
      const workerCardId = (bus.calls[1]!.payload as { nodes: Array<{ id: string }> }).nodes[0]!.id;

      // The worker finishes → settle ITS card, but the episode must remain open.
      lc.joinEpisodeEnd("worker-1", false, "parent-scope");
      const settle = bus.calls[bus.calls.length - 1]!;
      expect(settle.event).toBe("monitor:task_update");
      expect(settle.payload).toMatchObject({ rootId: parentEpisode, nodeId: workerCardId, status: "completed" });

      // A new ROOT requestStart on the parent scope still CONTINUES the same episode
      // (not rolled over) → the whole-goal episode survived the worker completion.
      lc.requestStart("parent-scope", "still going");
      const after = bus.calls[bus.calls.length - 1]!.payload as { rootId: string };
      expect(after.rootId).toBe(parentEpisode);
    });

    it("the episode closes ONLY on the whole-goal root requestEnd; a NEW request then opens a NEW episode", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("parent-scope", "root");
      const firstEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;

      // Workers run + finish — episode still open.
      lc.joinEpisode("worker-1", "sub A", "parent-scope");
      lc.joinEpisodeEnd("worker-1", false, "parent-scope");
      lc.joinEpisode("worker-2", "sub B", "parent-scope");
      lc.joinEpisodeEnd("worker-2", true, "parent-scope"); // a failed sub-task, still no rollover

      // The whole goal completes → ROOT requestEnd marks the episode terminal.
      lc.requestEnd("parent-scope");

      // The NEXT request after whole-goal completion opens a FRESH episode.
      lc.requestStart("parent-scope", "next goal");
      const secondEpisode = (bus.calls[bus.calls.length - 1]!.payload as { rootId: string }).rootId;
      expect(secondEpisode).not.toBe(firstEpisode);
      expect(secondEpisode).toMatch(/^ep-/);
    });

    it("a decomposed sub-goal worker grows the PARENT board (goalDecomposed honors monitorScope)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("parent-scope", "root");
      const parentEpisode = (bus.calls[0]!.payload as { rootId: string }).rootId;
      lc.joinEpisode("worker-1", "sub-goal", "parent-scope");

      // The worker itself decomposes; with the parent monitorScope its tree lands
      // on the parent episode board (rootId overridden to the parent episode).
      lc.goalDecomposed("worker-1", makeGoalTree(), "parent-scope");

      const treeInit = bus.calls[bus.calls.length - 1]!;
      expect(treeInit.event).toBe("monitor:dag_init");
      const p = treeInit.payload as { rootId: string; conversationId: string };
      expect(p.rootId).toBe(parentEpisode);
      expect(p.conversationId).toBe("parent-scope");
    });

    it("absent monitorScope ⇒ byte-identical to the prior per-scope behavior", () => {
      const lc = createMonitorLifecycle(bus);
      // requestStart with NO monitorScope behaves exactly as before.
      lc.requestStart("scope-1", "msg");
      const p = bus.calls[0]!.payload as { rootId: string; conversationId: string };
      expect(p.rootId).toMatch(/^ep-/);
      expect(p.conversationId).toBe("scope-1");

      lc.requestEnd("scope-1");
      expect(bus.calls).toHaveLength(2);
      expect((bus.calls[1]!.payload as { conversationId: string }).conversationId).toBe("scope-1");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("requestEnd settles the LATEST request's card within a continued episode", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      lc.requestStart("scope-1", "second");

      const episodeId = (bus.calls[1]!.payload as { rootId: string }).rootId;
      const secondCardId = (bus.calls[1]!.payload as { nodes: Array<{ id: string }> }).nodes[0]!.id;

      // The second requestStart continued the SAME episode (in-progress) but tracked
      // its own card; requestEnd settles that latest card under the episode root.
      lc.requestEnd("scope-1");
      const endPayload = bus.calls[2]!.payload as { rootId: string; nodeId: string };
      expect(endPayload.rootId).toBe(episodeId);
      expect(endPayload.nodeId).toBe(secondCardId);
    });

    it("settles BOTH cards when two concurrent same-scope requests overlap (no card lingers 'executing')", () => {
      // Models the only reachable same-scope overlap: an interactive chat message
      // AND a background task on the SAME conversationScope (independent locks).
      // Both requestStart inside one episode, then both requestEnd in finally.
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "interactive");
      lc.requestStart("scope-1", "background"); // joins the in-progress episode
      const firstCardId = (bus.calls[0]!.payload as { nodes: Array<{ id: string }> }).nodes[0]!.id;
      const secondCardId = (bus.calls[1]!.payload as { nodes: Array<{ id: string }> }).nodes[0]!.id;
      expect(firstCardId).not.toBe(secondCardId);

      // Both ends fire (one per path). With a single shared slot the first card
      // would never get a terminal task_update; the per-request list settles both.
      lc.requestEnd("scope-1"); // settles the most-recent card (LIFO)
      lc.requestEnd("scope-1"); // settles the remaining card

      const settled = bus.calls
        .filter((c) => c.event === "monitor:task_update")
        .map((c) => (c.payload as { nodeId: string }).nodeId);
      expect(settled).toHaveLength(2);
      expect(new Set(settled)).toEqual(new Set([firstCardId, secondCardId]));
    });

    it("handles empty string user message", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "");

      const p = bus.calls[0]!.payload as { nodes: Array<{ task: string }> };
      expect(p.nodes[0]!.task).toBe("");
    });

    it("requestEnd with failed=false behaves like default (completed)", () => {
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "msg");
      lc.requestEnd("scope-1", false);

      const p = bus.calls[1]!.payload as { status: string };
      expect(p.status).toBe("completed");
    });

    it("keeps the conversation scope (chat-level grouping) stable across an episode rollover", () => {
      // Episode boundaries change ONLY the monitor dag rootId (`ep-…`). The
      // conversationId — the chat-level grouping that is identity-adjacent — must
      // stay identical across episodes so prior episodes remain grouped under the
      // same conversation in the RootSwitcher and identity/memory keying (which is
      // derived from chat/user, NEVER the episode) is never fragmented.
      const lc = createMonitorLifecycle(bus);
      lc.requestStart("scope-1", "first");
      lc.requestEnd("scope-1");
      lc.requestStart("scope-1", "second");

      const dagInits = bus.calls.filter((c) => c.event === "monitor:dag_init");
      const conversationIds = dagInits.map((c) => (c.payload as { conversationId?: string }).conversationId);
      // Both episodes carry the SAME conversationId (the chat scope) ...
      expect(conversationIds).toEqual(["scope-1", "scope-1"]);
      // ... while the episode rootIds differ (the workspace rolled over).
      const rootIds = dagInits.map((c) => (c.payload as { rootId: string }).rootId);
      expect(rootIds[0]).not.toBe(rootIds[1]);
      // The conversationId is the verbatim scope, never an identity/user-derived
      // key — the lifecycle only ever echoes the conversationScope it was given.
      for (const id of conversationIds) expect(id).toBe("scope-1");
    });
  });
});
