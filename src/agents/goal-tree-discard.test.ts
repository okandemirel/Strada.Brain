/**
 * "Interrupted goal trees discarded." has to discard something.
 *
 * audited 2026-09-02: the discard branch of processMessage appended the user
 * message, echoed the resume prompt, printed the confirmation and returned —
 * no goalStorage call. The row stayed status='executing', so the same tree
 * was detected as interrupted at the next boot and every boot after. The
 * resume branch had the mirror gap: prepareTreeForResume reset the executing
 * nodes in memory and never persisted the reset.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { GoalStorage } from "../goals/goal-storage.js";
import { generateGoalNodeId } from "../goals/types.js";
import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-goal-discard-test.log"); } catch { /* set up already */ }
});

function interruptedTree(sessionId: string): GoalTree {
  const rootId = generateGoalNodeId();
  const childId = generateGoalNodeId();
  const now = Date.now();
  const root: GoalNode = {
    id: rootId, parentId: null, task: "Build the board", dependsOn: [], depth: 0,
    status: "executing", createdAt: now, updatedAt: now,
  };
  const child: GoalNode = {
    id: childId, parentId: rootId, task: "Wire the input", dependsOn: [rootId], depth: 1,
    status: "executing", startedAt: now, createdAt: now, updatedAt: now,
  };
  const nodes = new Map<GoalNodeId, GoalNode>([[rootId, root], [childId, child]]);
  return { rootId, sessionId, taskDescription: "Build the board", nodes, createdAt: now };
}

let dbDir: string;
let storage: GoalStorage;
let tree: GoalTree;
let channel: ReturnType<typeof createMockChannel>;
let orch: Orchestrator;

beforeEach(() => {
  dbDir = join(tmpdir(), `goal-discard-${randomBytes(4).toString("hex")}`);
  storage = new GoalStorage(join(dbDir, "goals.db"));
  storage.initialize();
  tree = interruptedTree("chat1");
  storage.upsertTree(tree, "executing");
  expect(storage.getInterruptedTrees()).toHaveLength(1);

  channel = createMockChannel();
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [] as never,
    channel: channel as never,
    projectPath: "/tmp/goal-discard-project",
    readOnly: false,
    requireConfirmation: false,
    interruptedGoalTrees: storage.getInterruptedTrees(),
  } as never);
  orch.setGoalStorage(storage);
});

afterEach(() => {
  try { storage.close(); } catch { /* closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

const say = (text: string) =>
  orch.handleMessage({ chatId: "chat1", text, channelType: "cli" } as never);

describe("replying 'discard' to the resume prompt", () => {
  it("removes the tree from goal storage so it is not detected again", async () => {
    await say("discard");

    expect(storage.getInterruptedTrees(), "the tree is still 'executing' in goals.db").toHaveLength(0);
    expect(storage.getTree(tree.rootId)).toBeNull();
  });

  it("says how many trees were removed", async () => {
    await say("discard");

    const sent = (channel.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
    expect(sent.some((m) => /discarded/i.test(m) && /1 /.test(m))).toBe(true);
  });
});

describe("replying 'resume' to the resume prompt", () => {
  it("persists the reset so a crash mid-resume does not re-resume stale rows", async () => {
    await say("resume");

    const stored = storage.getTree(tree.rootId);
    expect(stored).not.toBeNull();
    for (const node of stored!.nodes.values()) {
      expect(node.status, `node ${node.task} kept its stale status`).toBe("pending");
    }
  });
});
