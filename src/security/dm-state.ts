/**
 * DM State Manager - Tracks Diff/Merge operations and session state
 */

import { getLogger } from "../utils/logger.js";
import type { FileDiff, BatchDiff, DiffStats } from "../utils/diff-generator.js";
import type { ApprovalResult, ApprovalLevel } from "./dm-policy.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_OPS_PER_SESSION = 100;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SENSITIVE_FIELDS = ["password", "token", "secret", "key", "auth"];

// ─── Types ───────────────────────────────────────────────────────────────────

export enum DMOperationStatus {
  PENDING = "pending",
  APPROVED = "approved",
  EXECUTING = "executing",
  COMPLETED = "completed",
  REJECTED = "rejected",
  TIMEOUT = "timeout",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum DMOperationType {
  SINGLE_FILE = "single_file",
  BATCH = "batch",
  DELETE = "delete",
  RENAME = "rename",
  SHELL = "shell",
  GIT = "git",
  DIRECTORY = "directory",
}

export interface DMOperation {
  id: string;
  confirmationId: string;
  type: DMOperationType;
  status: DMOperationStatus;
  userId: string;
  chatId: string;
  description: string;
  diff?: FileDiff | BatchDiff;
  stats?: DiffStats;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  createdAt: Date;
  resolvedAt?: Date;
  completedAt?: Date;
  approvalResult?: ApprovalResult;
  errorMessage?: string;
  executionResult?: string;
  approvalLevel?: ApprovalLevel;
  tags?: string[];
}

export interface OperationQuery {
  userId?: string;
  chatId?: string;
  status?: DMOperationStatus | DMOperationStatus[];
  type?: DMOperationType | DMOperationType[];
  since?: Date;
  until?: Date;
  toolName?: string;
  tags?: string[];
}

export interface SessionDMState {
  sessionId: string;
  userId: string;
  chatId: string;
  operations: string[];
  activeOperationId?: string;
  createdAt: Date;
  lastActivity: Date;
  totalOperations: number;
  approvedCount: number;
  rejectedCount: number;
}

export interface DMStateManagerConfig {
  maxOperationsPerSession: number;
  maxOperationAgeMs: number;
  persistOperations: boolean;
  persistencePath?: string;
  cleanupIntervalMs: number;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DMStateManagerConfig = {
  maxOperationsPerSession: DEFAULT_MAX_OPS_PER_SESSION,
  maxOperationAgeMs: DEFAULT_MAX_AGE_MS,
  persistOperations: false,
  cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
};

// ─── Operation Type Detection ────────────────────────────────────────────────

export function getOperationTypeFromTool(toolName: string): DMOperationType {
  if (toolName.includes("write") || toolName.includes("edit")) return DMOperationType.SINGLE_FILE;
  if (toolName.includes("directory") || toolName.includes("folder")) return DMOperationType.DIRECTORY;
  if (toolName.includes("delete")) return DMOperationType.DELETE;
  if (toolName.includes("rename") || toolName.includes("move")) return DMOperationType.RENAME;
  if (toolName.includes("shell") || toolName.includes("exec")) return DMOperationType.SHELL;
  if (toolName.includes("git")) return DMOperationType.GIT;
  return DMOperationType.SINGLE_FILE;
}

// ─── DMStateManager Class ────────────────────────────────────────────────────

export class DMStateManager {
  private readonly config: DMStateManagerConfig;
  private readonly operations = new Map<string, DMOperation>();
  private readonly sessions = new Map<string, SessionDMState>();
  private operationCounter = 0;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<DMStateManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
  }

  // ─── Operation CRUD ────────────────────────────────────────────────────────

  createOperation(params: Omit<DMOperation, "id" | "createdAt" | "status">): DMOperation {
    const id = this.generateOperationId();
    
    const operation: DMOperation = {
      ...params,
      id,
      status: DMOperationStatus.PENDING,
      createdAt: new Date(),
      stats: params.diff 
        ? ("files" in params.diff ? params.diff.totalStats : params.diff.stats)
        : undefined,
      toolInput: this.sanitizeToolInput(params.toolInput),
    };

    this.operations.set(id, operation);
    this.addToSession(operation);
    
    getLogger().debug("DM operation created", { operationId: id, type: params.type, userId: params.userId });
    return operation;
  }

  getOperation(id: string): DMOperation | undefined {
    return this.operations.get(id);
  }

  getOperationByConfirmationId(confirmationId: string): DMOperation | undefined {
    return Array.from(this.operations.values()).find(op => op.confirmationId === confirmationId);
  }

  updateOperationStatus(
    id: string,
    status: DMOperationStatus,
    metadata?: { approvalResult?: ApprovalResult; errorMessage?: string; executionResult?: string }
  ): DMOperation | undefined {
    const operation = this.operations.get(id);
    if (!operation) return undefined;

    const oldStatus = operation.status;
    operation.status = status;

    // Update timestamps
    if (["approved", "rejected", "timeout"].includes(status)) {
      operation.resolvedAt = new Date();
    }
    if (["completed", "failed"].includes(status)) {
      operation.completedAt = new Date();
    }

    // Update metadata
    if (metadata) {
      Object.assign(operation, metadata);
    }

    this.updateSessionStats(operation);
    
    getLogger().debug("DM operation status updated", { operationId: id, oldStatus, newStatus: status });
    return operation;
  }

  // ─── Query Operations ──────────────────────────────────────────────────────

  queryOperations(query: OperationQuery = {}): DMOperation[] {
    let results = Array.from(this.operations.values());

    const filter = <T>(value: T | undefined, predicate: (op: DMOperation) => boolean) => 
      value !== undefined ? results.filter(predicate) : results;

    results = filter(query.userId, op => op.userId === query.userId);
    results = filter(query.chatId, op => op.chatId === query.chatId);
    results = filter(query.status, op => 
      Array.isArray(query.status) ? query.status.includes(op.status) : op.status === query.status
    );
    results = filter(query.type, op => 
      Array.isArray(query.type) ? query.type.includes(op.type) : op.type === query.type
    );
    results = filter(query.since, op => op.createdAt >= query.since!);
    results = filter(query.until, op => op.createdAt <= query.until!);
    results = filter(query.toolName, op => op.toolName === query.toolName);
    results = filter(query.tags, op => query.tags!.some(tag => op.tags?.includes(tag)));

    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  getPendingOperations(): DMOperation[] {
    return this.queryOperations({ status: DMOperationStatus.PENDING });
  }

  getSessionOperations(userId: string, chatId: string): DMOperation[] {
    const session = this.sessions.get(this.getSessionId(userId, chatId));
    if (!session) return [];
    
    return session.operations
      .map(id => this.operations.get(id))
      .filter((op): op is DMOperation => op !== undefined);
  }

  // ─── Session Management ────────────────────────────────────────────────────

  getOrCreateSession(userId: string, chatId: string): SessionDMState {
    const sessionId = this.getSessionId(userId, chatId);
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        userId,
        chatId,
        operations: [],
        createdAt: new Date(),
        lastActivity: new Date(),
        totalOperations: 0,
        approvedCount: 0,
        rejectedCount: 0,
      };
      this.sessions.set(sessionId, session);
    } else {
      session.lastActivity = new Date();
    }

    return session;
  }

  getSession(userId: string, chatId: string): SessionDMState | undefined {
    return this.sessions.get(this.getSessionId(userId, chatId));
  }

  setActiveOperation(userId: string, chatId: string, operationId: string): boolean {
    const session = this.getOrCreateSession(userId, chatId);
    if (!this.operations.has(operationId)) return false;

    session.activeOperationId = operationId;
    this.addOperationToSession(session, operationId);
    return true;
  }

  clearActiveOperation(userId: string, chatId: string): void {
    const session = this.sessions.get(this.getSessionId(userId, chatId));
    if (session) {
      session.activeOperationId = undefined;
      session.lastActivity = new Date();
    }
  }

  getActiveOperation(userId: string, chatId: string): DMOperation | undefined {
    const session = this.sessions.get(this.getSessionId(userId, chatId));
    return session?.activeOperationId ? this.operations.get(session.activeOperationId) : undefined;
  }

  cancelSessionPending(userId: string, chatId: string, reason = "Session cancelled"): number {
    const pending = this.getSessionOperations(userId, chatId)
      .filter(op => op.status === DMOperationStatus.PENDING);

    for (const op of pending) {
      this.updateOperationStatus(op.id, DMOperationStatus.CANCELLED, { errorMessage: reason });
    }

    return pending.length;
  }

  // ─── Statistics ────────────────────────────────────────────────────────────

  getStatistics() {
    const ops = Array.from(this.operations.values());
    const countByStatus = (status: DMOperationStatus) => ops.filter(op => op.status === status).length;

    return {
      totalOperations: ops.length,
      pendingCount: countByStatus(DMOperationStatus.PENDING),
      approvedCount: countByStatus(DMOperationStatus.APPROVED),
      rejectedCount: countByStatus(DMOperationStatus.REJECTED),
      completedCount: countByStatus(DMOperationStatus.COMPLETED),
      failedCount: countByStatus(DMOperationStatus.FAILED),
      sessionCount: this.sessions.size,
    };
  }

  getTypeDistribution(): Record<DMOperationType, number> {
    const distribution = Object.fromEntries(
      Object.values(DMOperationType).map(t => [t, 0])
    ) as Record<DMOperationType, number>;

    for (const op of this.operations.values()) {
      distribution[op.type]++;
    }

    return distribution;
  }

  // ─── Cleanup & Export ──────────────────────────────────────────────────────

  cleanup(): void {
    const cutoff = new Date(Date.now() - this.config.maxOperationAgeMs);
    let deleted = 0;

    // Delete old non-pending operations
    for (const [id, op] of this.operations.entries()) {
      if (op.status !== DMOperationStatus.PENDING && op.createdAt < cutoff) {
        this.operations.delete(id);
        deleted++;
      }
    }

    // Clean up sessions
    for (const [sessionId, session] of this.sessions.entries()) {
      session.operations = session.operations.filter(id => this.operations.has(id));
      
      if (session.operations.length === 0 && session.lastActivity < cutoff) {
        this.sessions.delete(sessionId);
      }
    }

    if (deleted > 0) {
      getLogger().debug("DM state cleanup completed", { deletedOperations: deleted });
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  exportToJSON(): string {
    return JSON.stringify({
      operations: Array.from(this.operations.values()),
      sessions: Array.from(this.sessions.values()),
      exportedAt: new Date().toISOString(),
    }, null, 2);
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private generateOperationId(): string {
    return `op_${Date.now()}_${++this.operationCounter}`;
  }

  private getSessionId(userId: string, chatId: string): string {
    return `${userId}:${chatId}`;
  }

  private addToSession(operation: DMOperation): void {
    const session = this.getOrCreateSession(operation.userId, operation.chatId);
    this.addOperationToSession(session, operation.id);
  }

  private addOperationToSession(session: SessionDMState, operationId: string): void {
    if (!session.operations.includes(operationId)) {
      session.operations.push(operationId);
      session.totalOperations++;
    }
  }

  private updateSessionStats(operation: DMOperation): void {
    const session = this.sessions.get(this.getSessionId(operation.userId, operation.chatId));
    if (!session) return;

    this.addOperationToSession(session, operation.id);

    if ([DMOperationStatus.APPROVED, DMOperationStatus.COMPLETED].includes(operation.status)) {
      session.approvedCount++;
    } else if (operation.status === DMOperationStatus.REJECTED) {
      session.rejectedCount++;
    }

    session.lastActivity = new Date();

    // Trim if too long
    if (session.operations.length > this.config.maxOperationsPerSession) {
      session.operations = session.operations.slice(-this.config.maxOperationsPerSession);
    }
  }

  private sanitizeToolInput(input?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!input) return undefined;

    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        SENSITIVE_FIELDS.some(f => key.toLowerCase().includes(f)) ? "[REDACTED]" : value
      ])
    );
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDMStateManager(config?: Partial<DMStateManagerConfig>): DMStateManager {
  return new DMStateManager(config);
}
