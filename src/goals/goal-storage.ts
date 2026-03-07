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
import { dirname } from "node:path";
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
  updated_at INTEGER NOT NULL
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
  FOREIGN KEY (root_id) REFERENCES goal_trees(root_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_nodes_root ON goal_nodes(root_id);
CREATE INDEX IF NOT EXISTS idx_goal_nodes_status ON goal_nodes(root_id, status);
CREATE INDEX IF NOT EXISTS idx_goal_trees_session ON goal_trees(session_id);
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
    const dir = dirname(this.dbPath);
    if (dir && dir !== ".") {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    configureSqlitePragmas(this.db, "tasks");
    this.db.exec(SCHEMA_SQL);
    this.prepareStatements();
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
        INSERT INTO goal_trees (root_id, session_id, task_description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      insertNode: `
        INSERT INTO goal_nodes (id, root_id, parent_id, task, depends_on, depth, status, result, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      getTree: `SELECT * FROM goal_trees WHERE root_id = ?`,
      getNodesByRoot: `SELECT * FROM goal_nodes WHERE root_id = ?`,
      updateNodeStatus: `
        UPDATE goal_nodes SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?
      `,
      getTreesBySession: `SELECT * FROM goal_trees WHERE session_id = ? ORDER BY created_at DESC`,
      deleteTree: `DELETE FROM goal_trees WHERE root_id = ?`,
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

    const nodeRows = this.getStatement("getNodesByRoot").all(rootId) as GoalNodeRow[];
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
    };
  }

  /** Update a node's status, result, and error */
  updateNodeStatus(
    nodeId: GoalNodeId,
    status: GoalStatus,
    result?: string,
    error?: string,
  ): void {
    this.ensureConnection();
    this.getStatement("updateNodeStatus").run(
      status,
      result ?? null,
      error ?? null,
      Date.now(),
      nodeId,
    );
  }

  /** Get all trees for a given session */
  getTreesBySession(sessionId: string): GoalTree[] {
    this.ensureConnection();

    const treeRows = this.getStatement("getTreesBySession").all(
      sessionId,
    ) as GoalTreeRow[];

    return treeRows.map((treeRow) => {
      const nodeRows = this.getStatement("getNodesByRoot").all(
        treeRow.root_id,
      ) as GoalNodeRow[];
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
      };
    });
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
    };
  }
}
