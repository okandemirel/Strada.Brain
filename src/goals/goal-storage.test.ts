/**
 * Goal Storage Tests
 *
 * Tests for GoalStorage SQLite persistence:
 * - initialize creates tables
 * - saveTree persists a GoalTree and its nodes
 * - getTree retrieves complete GoalTree with Map
 * - updateNodeStatus changes status and updatedAt
 * - getTree returns null for non-existent rootId
 * - getTreesBySession returns all trees for a session
 * - deleteTree cascades to delete all nodes
 * - close releases the database connection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GoalStorage } from "./goal-storage.js";
import type { GoalNode, GoalTree, GoalNodeId, GoalStatus } from "./types.js";
import { generateGoalNodeId } from "./types.js";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

// =============================================================================
// HELPERS
// =============================================================================

function createTempDbPath(): string {
  return join(tmpdir(), `goal-test-${randomBytes(4).toString("hex")}`, "goals.db");
}

function buildTestTree(overrides?: Partial<GoalTree>): GoalTree {
  const rootId = generateGoalNodeId();
  const childId = generateGoalNodeId();
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

  const childNode: GoalNode = {
    id: childId,
    parentId: rootId,
    task: "Child task",
    dependsOn: [rootId],
    depth: 1,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, rootNode);
  nodes.set(childId, childNode);

  return {
    rootId,
    sessionId: "test-session-1",
    taskDescription: "Test goal tree",
    nodes,
    createdAt: now,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("GoalStorage", () => {
  let storage: GoalStorage;
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
    storage = new GoalStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    try {
      storage.close();
    } catch {
      // Already closed
    }
    // Clean up temp directory
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initialize() creates goals.db with goal_trees and goal_nodes tables", () => {
    expect(existsSync(dbPath)).toBe(true);
    // If we got here without error, tables exist (schema executed successfully)
  });

  it("saveTree() persists a GoalTree and all its nodes", () => {
    const tree = buildTestTree();
    storage.saveTree(tree);

    const retrieved = storage.getTree(tree.rootId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.rootId).toBe(tree.rootId);
    expect(retrieved!.nodes.size).toBe(2);
  });

  it("getTree(rootId) retrieves a complete GoalTree with all nodes as a Map", () => {
    const tree = buildTestTree();
    storage.saveTree(tree);

    const retrieved = storage.getTree(tree.rootId)!;
    expect(retrieved.sessionId).toBe("test-session-1");
    expect(retrieved.taskDescription).toBe("Test goal tree");
    expect(retrieved.nodes).toBeInstanceOf(Map);
    expect(retrieved.nodes.size).toBe(2);

    // Check root node
    const rootNode = retrieved.nodes.get(tree.rootId);
    expect(rootNode).toBeDefined();
    expect(rootNode!.task).toBe("Root task");
    expect(rootNode!.depth).toBe(0);
    expect(rootNode!.parentId).toBeNull();

    // Check child node
    const childEntries = [...retrieved.nodes.values()].filter(
      (n) => n.id !== tree.rootId,
    );
    expect(childEntries).toHaveLength(1);
    expect(childEntries[0].task).toBe("Child task");
    expect(childEntries[0].depth).toBe(1);
    expect(childEntries[0].parentId).toBe(tree.rootId);
    expect(childEntries[0].dependsOn).toEqual([tree.rootId]);
  });

  it("updateNodeStatus() changes a node's status and updatedAt", () => {
    const tree = buildTestTree();
    storage.saveTree(tree);

    const rootNode = tree.nodes.get(tree.rootId)!;
    const beforeUpdate = Date.now();

    storage.updateNodeStatus(rootNode.id, "completed", "Done successfully");

    const retrieved = storage.getTree(tree.rootId)!;
    const updatedNode = retrieved.nodes.get(rootNode.id)!;
    expect(updatedNode.status).toBe("completed");
    expect(updatedNode.result).toBe("Done successfully");
    expect(updatedNode.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
  });

  it("updateNodeStatus() with error field", () => {
    const tree = buildTestTree();
    storage.saveTree(tree);

    const rootNode = tree.nodes.get(tree.rootId)!;
    storage.updateNodeStatus(rootNode.id, "failed", undefined, "Something went wrong");

    const retrieved = storage.getTree(tree.rootId)!;
    const updatedNode = retrieved.nodes.get(rootNode.id)!;
    expect(updatedNode.status).toBe("failed");
    expect(updatedNode.result).toBeUndefined();
    expect(updatedNode.error).toBe("Something went wrong");
  });

  it("getTree returns null for non-existent rootId", () => {
    const result = storage.getTree("nonexistent" as GoalNodeId);
    expect(result).toBeNull();
  });

  it("getTreesBySession(sessionId) returns all trees for a session", () => {
    const tree1 = buildTestTree({ sessionId: "session-A" });
    const tree2 = buildTestTree({ sessionId: "session-A" });
    const tree3 = buildTestTree({ sessionId: "session-B" });

    storage.saveTree(tree1);
    storage.saveTree(tree2);
    storage.saveTree(tree3);

    const sessionATrees = storage.getTreesBySession("session-A");
    expect(sessionATrees).toHaveLength(2);
    expect(sessionATrees.every((t) => t.sessionId === "session-A")).toBe(true);

    const sessionBTrees = storage.getTreesBySession("session-B");
    expect(sessionBTrees).toHaveLength(1);
    expect(sessionBTrees[0].sessionId).toBe("session-B");

    // Non-existent session
    const empty = storage.getTreesBySession("nonexistent");
    expect(empty).toHaveLength(0);
  });

  it("deleteTree(rootId) cascades to delete all nodes", () => {
    const tree = buildTestTree();
    storage.saveTree(tree);

    // Confirm it exists
    expect(storage.getTree(tree.rootId)).not.toBeNull();

    // Delete
    storage.deleteTree(tree.rootId);

    // Confirm gone
    expect(storage.getTree(tree.rootId)).toBeNull();
  });

  it("close() releases the database connection", () => {
    storage.close();
    // After close, operations should throw
    expect(() => storage.getTree("any" as GoalNodeId)).toThrow(
      /not initialized/,
    );
  });
});
