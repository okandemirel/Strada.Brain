/**
 * Goal Storage
 *
 * SQLite-based persistent storage for goal trees and nodes.
 * Follows the LearningStorage pattern: prepared statements, pragmas, schema.
 * Stores goal decomposition DAGs in goals.db.
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GoalNode, GoalTree, GoalNodeId, GoalStatus } from "./types.js";

// =============================================================================
// SCHEMA
// =============================================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goal_trees (
  root_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  plan_summary TEXT
);

CREATE TABLE IF NOT EXISTS goal_nodes (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  task TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executing','completed','failed','skipped')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  redecomposition_count INTEGER NOT NULL DEFAULT 0,
  review_status TEXT DEFAULT 'none',
  review_iterations INTEGER DEFAULT 0,
  FOREIGN KEY (root_id) REFERENCES goal_trees(root_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_nodes_root ON goal_nodes(root_id);
CREATE INDEX IF NOT EXISTS idx_goal_nodes_status ON goal_nodes(root_id, status);
CREATE INDEX IF NOT EXISTS idx_goal_trees_session ON goal_trees(session_id);
CREATE INDEX IF NOT EXISTS idx_goal_trees_status ON goal_trees(status);
`;

// =============================================================================
// ROW TYPES
// =============================================================================

interface GoalTreeRow {
  root_id: string;
  session_id: string;
  task_description: string;
  status: string;
  created_at: number;
  updated_at: number;
  plan_summary: string | null;
}

interface GoalNodeRow {
  id: string;
  root_id: string;
  parent_id: string | null;
  task: string;
  depends_on: string;
  depth: number;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  redecomposition_count: number;
  review_status: string | null;
  review_iterations: number | null;
}

// =============================================================================
// STORAGE CLASS
// =============================================================================

export class GoalStorage {
  private db: Database.Database | null = null;
  private statements: Map<string, Database.Statement> = new Map();

  constructor(private readonly dbPath: string) {}

  /** Initialize the database connection and schema */
  initialize(): void {
    // Defense-in-depth: validate resolved path doesn't escape expected directory
    const resolved = resolve(this.dbPath);
    if (resolved.includes("..")) {
      throw new Error("GoalStorage: resolved dbPath must not contain path traversal");
    }

    const dir = dirname(resolved);
    if (dir && dir !== ".") {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(resolved);
    configureSqlitePragmas(this.db, "tasks");
    this.db.exec(SCHEMA_SQL);

    // Safe migrations: add columns if missing (idempotent for existing DBs)
    this.migrateColumns("goal_nodes", [
      ["started_at", "INTEGER"],
      ["completed_at", "INTEGER"],
      ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
      ["redecomposition_count", "INTEGER NOT NULL DEFAULT 0"],
      ["review_status", "TEXT DEFAULT 'none'"],
      ["review_iterations", "INTEGER DEFAULT 0"],
    ]);
    this.migrateColumns("goal_trees", [
      ["plan_summary", "TEXT"],
    ]);

    this.prepareStatements();
  }

  /** Add missing columns to a table (idempotent). */
  private migrateColumns(
    table: string,
    columns: Array<[name: string, definition: string]>,
  ): void {
    const existing = new Set(
      (this.db!.pragma(`table_info(${table})`) as Array<{ name: string }>)
        .map((c) => c.name),
    );
    for (const [name, definition] of columns) {
      if (!existing.has(name)) {
        this.db!.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  /** Close the database connection */
  close(): void {
    this.statements.clear();
    this.db?.close();
    this.db = null;
  }

  // --- Prepared Statements ---

  private prepareStatements(): void {
    if (!this.db) return;

    const stmts: Record<string, string> = {
      insertTree: `
        INSERT INTO goal_trees (root_id, session_id, task_description, status, created_at, updated_at, plan_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      insertNode: `
        INSERT INTO goal_nodes (id, root_id, parent_id, task, depends_on, depth, status, result, error, created_at, updated_at, started_at, completed_at, retry_count, redecomposition_count, review_status, review_iterations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      getTree: `SELECT * FROM goal_trees WHERE root_id = ?`,
      getNodesByRoot: `SELECT * FROM goal_nodes WHERE root_id = ?`,
      updateNodeStatus: `
        UPDATE goal_nodes SET status = ?, result = ?, error = ?, updated_at = ?, retry_count = ?, redecomposition_count = ?, review_status = ?, review_iterations = ? WHERE id = ?
      `,
      getTreesBySession: `SELECT * FROM goal_trees WHERE session_id = ? ORDER BY created_at DESC LIMIT 50`,
      deleteTree: `DELETE FROM goal_trees WHERE root_id = ?`,
      upsertTree: `
        INSERT OR REPLACE INTO goal_trees (root_id, session_id, task_description, status, created_at, updated_at, plan_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      upsertNode: `
        INSERT OR REPLACE INTO goal_nodes (id, root_id, parent_id, task, depends_on, depth, status, result, error, created_at, updated_at, started_at, completed_at, retry_count, redecomposition_count, review_status, review_iterations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      deleteNodesByRoot: `DELETE FROM goal_nodes WHERE root_id = ?`,
      getInterruptedTrees: `SELECT * FROM goal_trees WHERE status = 'executing' ORDER BY updated_at DESC LIMIT 20`,
      updateTreeStatus: `UPDATE goal_trees SET status = ?, updated_at = ? WHERE root_id = ?`,
      pruneOldTrees: `DELETE FROM goal_trees WHERE status IN ('completed', 'failed', 'blocked') AND updated_at < ?`,
      setNodeStartedAt: `UPDATE goal_nodes SET started_at = ? WHERE id = ? AND started_at IS NULL`,
      setNodeCompletedAt: `UPDATE goal_nodes SET completed_at = ? WHERE id = ?`,
    };

    for (const [name, sql] of Object.entries(stmts)) {
      this.statements.set(name, this.db.prepare(sql));
    }
  }

  private getStatement(name: string): Database.Statement {
    const stmt = this.statements.get(name);
    if (!stmt) throw new Error(`Statement not found: ${name}`);
    return stmt;
  }

  private ensureConnection(): void {
    if (!this.db) {
      throw new Error("GoalStorage not initialized. Call initialize() first.");
    }
  }

  // --- Tree Operations ---

  /** Save a complete GoalTree with all its nodes (transactional) */
  saveTree(tree: GoalTree): void {
    this.ensureConnection();

    const insertTree = this.getStatement("insertTree");
    const insertNode = this.getStatement("insertNode");

    const transaction = this.db!.transaction(() => {
      const now = Date.now();
      insertTree.run(
        tree.rootId,
        tree.sessionId,
        tree.taskDescription,
        "pending",
        tree.createdAt,
        now,
        tree.planSummary ?? null,
      );

      for (const [, node] of tree.nodes) {
        insertNode.run(
          node.id,
          tree.rootId,
          node.parentId ?? null,
          node.task,
          JSON.stringify(node.dependsOn),
          node.depth,
          node.status,
          node.result ?? null,
          node.error ?? null,
          node.createdAt,
          node.updatedAt,
          node.startedAt ?? null,
          node.completedAt ?? null,
          node.retryCount ?? 0,
          node.redecompositionCount ?? 0,
          node.reviewStatus ?? "none",
          node.reviewIterations ?? 0,
        );
      }
    });

    transaction();
  }

  /** Get a complete GoalTree by root ID, or null if not found */
  getTree(rootId: GoalNodeId): GoalTree | null {
    this.ensureConnection();

    const treeRow = this.getStatement("getTree").get(rootId) as
      | GoalTreeRow
      | undefined;
    if (!treeRow) return null;

    return this.buildTreeFromRow(treeRow);
  }

  /** Update a node's status, result, and error */
  updateNodeStatus(
    nodeId: GoalNodeId,
    status: GoalStatus,
    result?: string,
    error?: string,
    retryCount?: number,
    redecompositionCount?: number,
    reviewStatus?: string,
    reviewIterations?: number,
  ): void {
    this.ensureConnection();
    const now = Date.now();

    const transaction = this.db!.transaction(() => {
      this.getStatement("updateNodeStatus").run(
        status,
        result ?? null,
        error ?? null,
        now,
        retryCount ?? 0,
        redecompositionCount ?? 0,
        reviewStatus ?? "none",
        reviewIterations ?? 0,
        nodeId,
      );
      // Update timing columns within the same transaction (using cached statements)
      if (status === "executing") {
        this.getStatement("setNodeStartedAt").run(now, nodeId);
      }
      if (status === "completed" || status === "failed" || status === "skipped") {
        this.getStatement("setNodeCompletedAt").run(now, nodeId);
      }
    });
    transaction();
  }

  /** Get all trees for a given session */
  getTreesBySession(sessionId: string): GoalTree[] {
    this.ensureConnection();

    const treeRows = this.getStatement("getTreesBySession").all(
      sessionId,
    ) as GoalTreeRow[];

    return treeRows.map((treeRow) => this.buildTreeFromRow(treeRow));
  }

  /** Delete a tree and all its nodes (cascade via FK) */
  deleteTree(rootId: GoalNodeId): void {
    this.ensureConnection();
    this.getStatement("deleteTree").run(rootId);
  }

  // --- Row Conversion ---

  private rowToNode(row: GoalNodeRow): GoalNode {
    return {
      id: row.id as GoalNodeId,
      parentId: row.parent_id ? (row.parent_id as GoalNodeId) : null,
      task: row.task,
      dependsOn: JSON.parse(row.depends_on) as GoalNodeId[],
      depth: row.depth,
      status: row.status as GoalStatus,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      retryCount: row.retry_count ?? 0,
      redecompositionCount: row.redecomposition_count ?? 0,
      reviewStatus: (row.review_status as GoalNode["reviewStatus"]) ?? "none",
      reviewIterations: row.review_iterations ?? 0,
    };
  }

  /** Reconstruct a GoalTree from a tree row by loading its nodes */
  private buildTreeFromRow(treeRow: GoalTreeRow): GoalTree {
    const nodeRows = this.getStatement("getNodesByRoot").all(treeRow.root_id) as GoalNodeRow[];
    const nodes = new Map<GoalNodeId, GoalNode>();
    for (const row of nodeRows) {
      nodes.set(row.id as GoalNodeId, this.rowToNode(row));
    }
    return {
      rootId: treeRow.root_id as GoalNodeId,
      sessionId: treeRow.session_id,
      taskDescription: treeRow.task_description,
      nodes,
      createdAt: treeRow.created_at,
      planSummary: treeRow.plan_summary ?? undefined,
    };
  }

  // --- Phase 8: New Methods ---

  /** Upsert a complete GoalTree (INSERT OR REPLACE for tree and per-node) */
  upsertTree(tree: GoalTree, treeStatus: string = "pending"): void {
    this.ensureConnection();
    const transaction = this.db!.transaction(() => {
      const now = Date.now();
      this.getStatement("upsertTree").run(
        tree.rootId,
        tree.sessionId,
        tree.taskDescription,
        treeStatus,
        tree.createdAt,
        now,
        tree.planSummary ?? null,
      );
      // Use INSERT OR REPLACE per node to avoid deleting nodes that are concurrently being updated
      const upsertNode = this.getStatement("upsertNode");
      for (const [, node] of tree.nodes) {
        upsertNode.run(
          node.id,
          tree.rootId,
          node.parentId ?? null,
          node.task,
          JSON.stringify(node.dependsOn),
          node.depth,
          node.status,
          node.result ?? null,
          node.error ?? null,
          node.createdAt,
          node.updatedAt,
          node.startedAt ?? null,
          node.completedAt ?? null,
          node.retryCount ?? 0,
          node.redecompositionCount ?? 0,
          node.reviewStatus ?? "none",
          node.reviewIterations ?? 0,
        );
      }
    });
    transaction();
  }

  /** Get all trees with status 'executing' (interrupted/in-progress) */
  getInterruptedTrees(): GoalTree[] {
    this.ensureConnection();
    const rows = this.getStatement("getInterruptedTrees").all() as GoalTreeRow[];
    return rows.map((row) => this.buildTreeFromRow(row));
  }

  /** Update a tree's top-level status */
  updateTreeStatus(rootId: GoalNodeId, status: string): void {
    this.ensureConnection();
    this.getStatement("updateTreeStatus").run(status, Date.now(), rootId);
  }

  /** Prune completed/failed trees older than maxAgeMs (default 7 days). Returns count deleted. */
  pruneOldTrees(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    this.ensureConnection();
    const cutoff = Date.now() - maxAgeMs;
    const result = this.getStatement("pruneOldTrees").run(cutoff);
    return result.changes;
  }
}
