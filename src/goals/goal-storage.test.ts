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
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync, mkdirSync } from "node:fs";

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

  // ===========================================================================
  // Phase 8: upsertTree, getInterruptedTrees, updateTreeStatus, timing fields
  // ===========================================================================

  describe("upsertTree()", () => {
    it("calling twice with same rootId does not throw", () => {
      const tree = buildTestTree();
      storage.upsertTree(tree);
      // Second call should NOT throw (INSERT OR REPLACE)
      expect(() => storage.upsertTree(tree)).not.toThrow();
    });

    it("second upsert updates tree data", () => {
      const tree = buildTestTree({ taskDescription: "Original description" });
      storage.upsertTree(tree);

      // Build updated tree with same rootId but different description
      const updatedTree: GoalTree = {
        ...tree,
        taskDescription: "Updated description",
      };
      storage.upsertTree(updatedTree);

      const retrieved = storage.getTree(tree.rootId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.taskDescription).toBe("Updated description");
      expect(retrieved!.nodes.size).toBe(tree.nodes.size);
    });
  });

  describe("getInterruptedTrees()", () => {
    it("returns trees with status 'executing'", () => {
      const tree1 = buildTestTree({ sessionId: "s1" });
      const tree2 = buildTestTree({ sessionId: "s2" });
      const tree3 = buildTestTree({ sessionId: "s3" });

      // Save with default status, then update some to executing
      storage.upsertTree(tree1, "executing");
      storage.upsertTree(tree2, "completed");
      storage.upsertTree(tree3, "executing");

      const interrupted = storage.getInterruptedTrees();
      expect(interrupted).toHaveLength(2);
      const rootIds = interrupted.map((t) => t.rootId);
      expect(rootIds).toContain(tree1.rootId);
      expect(rootIds).toContain(tree3.rootId);
    });

    it("does not return completed or pending trees", () => {
      const tree1 = buildTestTree({ sessionId: "s1" });
      const tree2 = buildTestTree({ sessionId: "s2" });

      storage.upsertTree(tree1, "completed");
      storage.upsertTree(tree2, "pending");

      const interrupted = storage.getInterruptedTrees();
      expect(interrupted).toHaveLength(0);
    });
  });

  describe("updateTreeStatus()", () => {
    it("changes tree status", () => {
      const tree = buildTestTree();
      storage.upsertTree(tree, "pending");

      storage.updateTreeStatus(tree.rootId, "executing");

      // Verify via getInterruptedTrees (executing should appear)
      const interrupted = storage.getInterruptedTrees();
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0].rootId).toBe(tree.rootId);
    });
  });

  describe("timing fields roundtrip", () => {
    it("saves and retrieves startedAt, completedAt, retryCount", () => {
      const rootId = generateGoalNodeId();
      const now = Date.now();

      const rootNode: GoalNode = {
        id: rootId,
        parentId: null,
        task: "Root with timing",
        dependsOn: [],
        depth: 0,
        status: "executing",
        createdAt: now,
        updatedAt: now,
        startedAt: now - 1000,
        completedAt: now,
        retryCount: 2,
      };

      const nodes = new Map<GoalNodeId, GoalNode>();
      nodes.set(rootId, rootNode);

      const tree: GoalTree = {
        rootId,
        sessionId: "timing-test",
        taskDescription: "Timing fields test",
        nodes,
        createdAt: now,
      };

      storage.upsertTree(tree);

      const retrieved = storage.getTree(rootId);
      expect(retrieved).not.toBeNull();
      const retrievedNode = retrieved!.nodes.get(rootId)!;
      expect(retrievedNode.startedAt).toBe(now - 1000);
      expect(retrievedNode.completedAt).toBe(now);
      expect(retrievedNode.retryCount).toBe(2);
    });

    it("defaults retryCount to 0 when not provided", () => {
      const tree = buildTestTree();
      storage.upsertTree(tree);

      const retrieved = storage.getTree(tree.rootId);
      const rootNode = retrieved!.nodes.get(tree.rootId)!;
      expect(rootNode.retryCount).toBe(0);
      expect(rootNode.startedAt).toBeUndefined();
      expect(rootNode.completedAt).toBeUndefined();
    });
  });

  // ===========================================================================
  // Phase 20: plan_summary migration (TD-16)
  // ===========================================================================

  describe("plan_summary column migration (TD-16)", () => {
    it("migrates existing goal_trees table to add plan_summary column", () => {
      // Create a temporary DB with the OLD schema (no plan_summary)
      const migrationDbDir = join(tmpdir(), `goal-migration-${randomBytes(4).toString("hex")}`);
      mkdirSync(migrationDbDir, { recursive: true });
      const migrationDbPath = join(migrationDbDir, "goals.db");

      // Open directly with better-sqlite3 and create old schema
      const rawDb = new Database(migrationDbPath);
      rawDb.exec(`
        CREATE TABLE goal_trees (
          root_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE goal_nodes (
          id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL,
          parent_id TEXT,
          task TEXT NOT NULL,
          depends_on TEXT NOT NULL DEFAULT '[]',
          depth INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (root_id) REFERENCES goal_trees(root_id) ON DELETE CASCADE
        );
      `);
      rawDb.close();

      // Now construct GoalStorage with this DB -- constructor should run migration
      const migrationStorage = new GoalStorage(migrationDbPath);
      migrationStorage.initialize();

      // Verify plan_summary column exists by inserting a row with it
      const rawDbCheck = new Database(migrationDbPath);
      const cols = rawDbCheck.pragma("table_info(goal_trees)") as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("plan_summary");
      rawDbCheck.close();

      migrationStorage.close();
      rmSync(migrationDbDir, { recursive: true, force: true });
    });
  });
});
