/**
 * Goal Types Tests (Phase 16-01)
 *
 * Tests for extended goal types:
 * - GoalNode with redecompositionCount defaults to 0
 * - GoalTree with planSummary stores LLM plan text
 * - parseGoalBlock extracts goal JSON from triple-backtick goal fenced blocks
 * - parseGoalBlock returns null for responses without goal block
 * - parseGoalBlock validates isGoal, estimatedMinutes, and nodes array with Zod
 * - GoalStorage plan_summary column migration
 * - GoalStorage upsertTree stores and retrieves planSummary
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { GoalNode, GoalTree, GoalNodeId, GoalBlockOutput } from "./types.js";
import { generateGoalNodeId, parseGoalBlock } from "./types.js";
import { GoalStorage } from "./goal-storage.js";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// =============================================================================
// HELPERS
// =============================================================================

function createTempDbPath(): string {
  return join(tmpdir(), `goal-type-test-${randomBytes(4).toString("hex")}`, "goals.db");
}

function buildTestTree(overrides?: Partial<GoalTree>): GoalTree {
  const rootId = generateGoalNodeId();
  const now = Date.now();

  const rootNode: GoalNode = {
    id: rootId,
    parentId: null,
    task: "Root task",
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, rootNode);

  return {
    rootId,
    sessionId: "test-session",
    taskDescription: "Test goal",
    nodes,
    createdAt: now,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("GoalNode redecompositionCount", () => {
  it("defaults to 0 when not set", () => {
    const node: GoalNode = {
      id: generateGoalNodeId(),
      parentId: null,
      task: "test",
      dependsOn: [],
      depth: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // redecompositionCount is optional, defaults to undefined
    // Consumers should treat undefined as 0
    expect(node.redecompositionCount ?? 0).toBe(0);
  });

  it("can be set to a positive value", () => {
    const node: GoalNode = {
      id: generateGoalNodeId(),
      parentId: null,
      task: "test",
      dependsOn: [],
      depth: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      redecompositionCount: 2,
    };
    expect(node.redecompositionCount).toBe(2);
  });
});

describe("GoalTree planSummary", () => {
  it("stores LLM plan text", () => {
    const tree = buildTestTree({ planSummary: "Step 1: Create API. Step 2: Add tests." });
    expect(tree.planSummary).toBe("Step 1: Create API. Step 2: Add tests.");
  });

  it("is optional and defaults to undefined", () => {
    const tree = buildTestTree();
    expect(tree.planSummary).toBeUndefined();
  });
});

describe("parseGoalBlock", () => {
  it("extracts goal JSON from triple-backtick goal fenced blocks", () => {
    const text = `Here is a plan for you:

\`\`\`goal
{
  "isGoal": true,
  "estimatedMinutes": 30,
  "nodes": [
    { "id": "a", "task": "Create API", "dependsOn": [] },
    { "id": "b", "task": "Add tests", "dependsOn": ["a"] }
  ]
}
\`\`\`

Let me know if you want changes.`;

    const result = parseGoalBlock(text);
    expect(result).not.toBeNull();
    expect(result!.isGoal).toBe(true);
    expect(result!.estimatedMinutes).toBe(30);
    expect(result!.nodes).toHaveLength(2);
    expect(result!.nodes[0]!.id).toBe("a");
    expect(result!.nodes[0]!.task).toBe("Create API");
    expect(result!.nodes[1]!.dependsOn).toEqual(["a"]);
  });

  it("returns null for responses without goal block", () => {
    const text = "Sure, I can help you build a REST API. What framework would you like?";
    const result = parseGoalBlock(text);
    expect(result).toBeNull();
  });

  it("returns null for regular code blocks", () => {
    const text = '```json\n{"key": "value"}\n```';
    const result = parseGoalBlock(text);
    expect(result).toBeNull();
  });

  it("validates isGoal, estimatedMinutes, and nodes array with Zod", () => {
    // Missing isGoal
    const missingIsGoal = '```goal\n{"estimatedMinutes": 10, "nodes": [{"id": "a", "task": "x", "dependsOn": []}]}\n```';
    expect(parseGoalBlock(missingIsGoal)).toBeNull();

    // Missing estimatedMinutes
    const missingMinutes = '```goal\n{"isGoal": true, "nodes": [{"id": "a", "task": "x", "dependsOn": []}]}\n```';
    expect(parseGoalBlock(missingMinutes)).toBeNull();

    // Empty nodes array
    const emptyNodes = '```goal\n{"isGoal": true, "estimatedMinutes": 5, "nodes": []}\n```';
    expect(parseGoalBlock(emptyNodes)).toBeNull();

    // Missing nodes field
    const missingNodes = '```goal\n{"isGoal": true, "estimatedMinutes": 5}\n```';
    expect(parseGoalBlock(missingNodes)).toBeNull();

    // Invalid JSON
    const badJson = '```goal\n{not valid json}\n```';
    expect(parseGoalBlock(badJson)).toBeNull();
  });

  it("validates node structure within the goal block", () => {
    // Node missing id
    const missingId = '```goal\n{"isGoal": true, "estimatedMinutes": 5, "nodes": [{"task": "x", "dependsOn": []}]}\n```';
    expect(parseGoalBlock(missingId)).toBeNull();

    // Node missing task
    const missingTask = '```goal\n{"isGoal": true, "estimatedMinutes": 5, "nodes": [{"id": "a", "dependsOn": []}]}\n```';
    expect(parseGoalBlock(missingTask)).toBeNull();
  });
});

describe("GoalStorage plan_summary", () => {
  let storage: GoalStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
    storage = new GoalStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    try {
      const dir = join(dbPath, "..");
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("plan_summary column exists after migration", () => {
    // Re-initialize on an existing DB to trigger migration path
    storage.close();
    storage = new GoalStorage(dbPath);
    storage.initialize();

    // Save a tree and retrieve it - planSummary should be preserved
    const tree = buildTestTree({ planSummary: "Migration test plan" });
    storage.upsertTree(tree);

    const retrieved = storage.getTree(tree.rootId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.planSummary).toBe("Migration test plan");
  });

  it("upsertTree stores and retrieves planSummary", () => {
    const tree = buildTestTree({ planSummary: "Build a REST API with auth and tests" });
    storage.upsertTree(tree);

    const retrieved = storage.getTree(tree.rootId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.planSummary).toBe("Build a REST API with auth and tests");
  });

  it("upsertTree stores null planSummary for trees without it", () => {
    const tree = buildTestTree();
    storage.upsertTree(tree);

    const retrieved = storage.getTree(tree.rootId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.planSummary).toBeUndefined();
  });
});
