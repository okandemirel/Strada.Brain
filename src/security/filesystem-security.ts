/**
 * File System Security for Strada.Brain
 * 
 * Provides:
 * - Chroot jail for shell execution
 * - File integrity monitoring
 * - Backup before write
 * - Audit logging for file operations
 * - Path traversal protection
 */

import {
  access,
  mkdir,
  readFile,
  stat,
  writeFile,
  unlink,
  constants,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface FileIntegrityRecord {
  path: string;
  hash: string;
  size: number;
  modified: number;
  permissions: number;
  checkedAt: number;
}

export interface FileBackup {
  originalPath: string;
  backupPath: string;
  createdAt: number;
  size: number;
  hash: string;
}

export interface FileOperationAudit {
  id: string;
  timestamp: number;
  operation: FileOperation;
  path: string;
  userId?: string;
  success: boolean;
  details?: Record<string, unknown>;
  error?: string;
  ipAddress?: string;
}

type FileOperation =
  | "read"
  | "write"
  | "delete"
  | "move"
  | "copy"
  | "chmod"
  | "mkdir"
  | "integrity_check";

export interface ChrootConfig {
  rootPath: string;
  allowedPaths: string[];
  readOnly: boolean;
  maxFileSize: number;
  allowedExtensions: string[];
  forbiddenPatterns: RegExp[];
}

// =============================================================================
// CHROOT JAIL
// =============================================================================

export class ChrootJail {
  private readonly config: ChrootConfig;
  private readonly logger = getLogger();

  constructor(config: Partial<ChrootConfig> & { rootPath: string }) {
    this.config = {
      allowedPaths: [],
      readOnly: false,
      maxFileSize: 100 * 1024 * 1024, // 100MB
      allowedExtensions: [],
      forbiddenPatterns: [
        /\.env$/i,
        /\.env\./i,
        /\.git\//i,
        /\.ssh\//i,
        /node_modules\//i,
        /\.pem$/i,
        /\.key$/i,
        /id_rsa/i,
        /\/etc\//i,
        /\/proc\//i,
        /\/sys\//i,
      ],
      ...config,
    };
  }

  /**
   * Resolve a path within the chroot jail
   */
  resolvePath(relativePath: string): { valid: boolean; resolved?: string; error?: string } {
    // Check for null bytes
    if (relativePath.includes("\0")) {
      return { valid: false, error: "Path contains null bytes" };
    }

    // Normalize path
    const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/");

    // Check for path traversal
    if (normalized.includes("../") || normalized.startsWith("/..")) {
      return { valid: false, error: "Path traversal attempt detected" };
    }

    // Check forbidden patterns
    for (const pattern of this.config.forbiddenPatterns) {
      if (pattern.test(normalized)) {
        return { valid: false, error: "Access to this path is forbidden" };
      }
    }

    // Resolve within chroot
    const resolved = resolve(this.config.rootPath, normalized);

    // Ensure resolved path is within chroot
    if (!resolved.startsWith(this.config.rootPath)) {
      return { valid: false, error: "Path escapes chroot jail" };
    }

    // Check allowed paths if specified
    if (this.config.allowedPaths.length > 0) {
      const inAllowedPath = this.config.allowedPaths.some((allowed) => {
        const allowedResolved = resolve(this.config.rootPath, allowed);
        return resolved.startsWith(allowedResolved);
      });

      if (!inAllowedPath) {
        return { valid: false, error: "Path not in allowed directories" };
      }
    }

    return { valid: true, resolved };
  }

  /**
   * Read file within chroot
   */
  async readFile(relativePath: string, encoding: BufferEncoding = "utf8"): Promise<Buffer | string> {
    const pathCheck = this.resolvePath(relativePath);
    if (!pathCheck.valid) {
      throw new Error(pathCheck.error);
    }

    return readFile(pathCheck.resolved!, encoding);
  }

  /**
   * Write file within chroot
   */
  async writeFile(
    relativePath: string,
    data: Buffer | string,
    options: { createBackup?: boolean; mode?: number } = {}
  ): Promise<void> {
    if (this.config.readOnly) {
      throw new Error("Chroot jail is read-only");
    }

    const pathCheck = this.resolvePath(relativePath);
    if (!pathCheck.valid) {
      throw new Error(pathCheck.error);
    }

    // Check file size
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, "utf8");
    if (size > this.config.maxFileSize) {
      throw new Error(`File size ${size} exceeds maximum ${this.config.maxFileSize}`);
    }

    // Check extension
    if (this.config.allowedExtensions.length > 0) {
      const ext = relativePath.split(".").pop()?.toLowerCase();
      if (!ext || !this.config.allowedExtensions.includes(ext)) {
        throw new Error(`File extension .${ext} not allowed`);
      }
    }

    // Ensure directory exists
    const dir = dirname(pathCheck.resolved!);
    await mkdir(dir, { recursive: true });

    // Create backup if file exists
    if (options.createBackup) {
      try {
        await access(pathCheck.resolved!, constants.F_OK);
        await this.createBackup(relativePath);
      } catch {
        // File doesn't exist, no backup needed
      }
    }

    await writeFile(pathCheck.resolved!, data, { mode: options.mode });
  }

  /**
   * Delete file within chroot
   */
  async deleteFile(relativePath: string, options: { createBackup?: boolean } = {}): Promise<void> {
    if (this.config.readOnly) {
      throw new Error("Chroot jail is read-only");
    }

    const pathCheck = this.resolvePath(relativePath);
    if (!pathCheck.valid) {
      throw new Error(pathCheck.error);
    }

    // Create backup before deletion
    if (options.createBackup) {
      await this.createBackup(relativePath);
    }

    await unlink(pathCheck.resolved!);
  }

  /**
   * Create backup of file
   */
  async createBackup(relativePath: string): Promise<FileBackup> {
    const pathCheck = this.resolvePath(relativePath);
    if (!pathCheck.valid) {
      throw new Error(pathCheck.error);
    }

    const timestamp = Date.now();
    const randomSuffix = randomBytes(4).toString("hex");
    const backupDir = join(this.config.rootPath, ".backups");
    
    await mkdir(backupDir, { recursive: true });

    const backupPath = join(
      backupDir,
      `${relativePath.replace(/[/\\]/g, "_")}.${timestamp}.${randomSuffix}.bak`
    );

    const content = await readFile(pathCheck.resolved!);
    await writeFile(backupPath, content);

    const stats = await stat(pathCheck.resolved!);
    const hash = createHash("sha256").update(content).digest("hex");

    const backup: FileBackup = {
      originalPath: relativePath,
      backupPath,
      createdAt: timestamp,
      size: stats.size,
      hash,
    };

    this.logger.info("File backup created", {
      original: relativePath,
      backup: backupPath,
    });

    return backup;
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupPath: string, targetPath?: string): Promise<void> {
    const content = await readFile(backupPath);
    
    const relativePath = targetPath || this.extractOriginalPath(backupPath);
    
    await this.writeFile(relativePath, content, { createBackup: false });

    this.logger.info("File restored from backup", {
      backup: backupPath,
      target: relativePath,
    });
  }

  private extractOriginalPath(backupPath: string): string {
    // Extract original path from backup filename
    const filename = backupPath.split("/").pop() || backupPath;
    return filename.replace(/\.\d+\.[a-f0-9]+\.bak$/, "").replace(/_/g, "/");
  }
}

// =============================================================================
// FILE INTEGRITY MONITOR
// =============================================================================

export class FileIntegrityMonitor {
  private readonly records = new Map<string, FileIntegrityRecord>();
  private readonly monitoredPaths = new Set<string>();
  private readonly logger = getLogger();
  private checkInterval: NodeJS.Timeout | null = null;

  /**
   * Add path to monitoring
   */
  async addPath(filePath: string): Promise<void> {
    this.monitoredPaths.add(filePath);
    await this.updateRecord(filePath);
  }

  /**
   * Remove path from monitoring
   */
  removePath(filePath: string): void {
    this.monitoredPaths.delete(filePath);
    this.records.delete(filePath);
  }

  /**
   * Update integrity record for a file
   */
  async updateRecord(filePath: string): Promise<FileIntegrityRecord | null> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath);
      
      const record: FileIntegrityRecord = {
        path: filePath,
        hash: createHash("sha256").update(content).digest("hex"),
        size: stats.size,
        modified: stats.mtime.getTime(),
        permissions: stats.mode,
        checkedAt: Date.now(),
      };

      this.records.set(filePath, record);
      return record;
    } catch (error) {
      this.logger.error("Failed to update integrity record", { filePath, error });
      return null;
    }
  }

  /**
   * Check file integrity
   */
  async checkIntegrity(filePath: string): Promise<{
    valid: boolean;
    changes?: string[];
    record?: FileIntegrityRecord;
  }> {
    const storedRecord = this.records.get(filePath);
    
    if (!storedRecord) {
      return { valid: false, changes: ["No baseline record found"] };
    }

    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath);
      const currentHash = createHash("sha256").update(content).digest("hex");

      const changes: string[] = [];

      if (currentHash !== storedRecord.hash) {
        changes.push("Content hash mismatch");
      }

      if (stats.size !== storedRecord.size) {
        changes.push(`Size changed: ${storedRecord.size} -> ${stats.size}`);
      }

      if (stats.mtime.getTime() !== storedRecord.modified) {
        changes.push("Modification time changed");
      }

      if (stats.mode !== storedRecord.permissions) {
        changes.push("Permissions changed");
      }

      return {
        valid: changes.length === 0,
        changes: changes.length > 0 ? changes : undefined,
        record: storedRecord,
      };
    } catch (error) {
      return {
        valid: false,
        changes: [`File access error: ${error}`],
      };
    }
  }

  /**
   * Check all monitored files
   */
  async checkAll(): Promise<{
    total: number;
    valid: number;
    invalid: number;
    violations: Array<{ path: string; changes: string[] }>;
  }> {
    const results = {
      total: this.monitoredPaths.size,
      valid: 0,
      invalid: 0,
      violations: [] as Array<{ path: string; changes: string[] }>,
    };

    for (const path of Array.from(this.monitoredPaths)) {
      const check = await this.checkIntegrity(path);
      
      if (check.valid) {
        results.valid++;
      } else {
        results.invalid++;
        if (check.changes) {
          results.violations.push({ path, changes: check.changes });
        }
      }
    }

    if (results.violations.length > 0) {
      this.logger.warn("File integrity violations detected", {
        count: results.violations.length,
        violations: results.violations,
      });
    }

    return results;
  }

  /**
   * Start periodic integrity checks
   */
  startPeriodicChecks(intervalMs: number = 60000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      const results = await this.checkAll();
      
      if (results.invalid > 0) {
        this.logger.error("Integrity check found violations", {
          valid: results.valid,
          invalid: results.invalid,
        });
      }
    }, intervalMs);

    this.logger.info("File integrity monitoring started", { intervalMs });
  }

  /**
   * Stop periodic checks
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Get all records
   */
  getRecords(): FileIntegrityRecord[] {
    return Array.from(this.records.values());
  }
}

// =============================================================================
// FILE OPERATION AUDIT LOGGER
// =============================================================================

export class FileAuditLogger {
  private readonly auditLog: FileOperationAudit[] = [];
  private readonly maxEntries: number;
  private readonly logger = getLogger();

  constructor(maxEntries: number = 10000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Log a file operation
   */
  log(audit: Omit<FileOperationAudit, "id" | "timestamp">): void {
    const entry: FileOperationAudit = {
      id: this.generateAuditId(),
      timestamp: Date.now(),
      ...audit,
    };

    this.auditLog.push(entry);

    // Maintain max size
    if (this.auditLog.length > this.maxEntries) {
      this.auditLog.shift();
    }

    // Also log to application logger
    const logMethod = audit.success ? "info" : "warn";
    this.logger[logMethod]("File operation", {
      operation: audit.operation,
      path: audit.path,
      success: audit.success,
      userId: audit.userId,
    });
  }

  /**
   * Query audit log
   */
  query(filters: {
    operation?: FileOperation;
    path?: string;
    userId?: string;
    success?: boolean;
    since?: number;
    until?: number;
  }): FileOperationAudit[] {
    return this.auditLog.filter((entry) => {
      if (filters.operation && entry.operation !== filters.operation) return false;
      if (filters.path && !entry.path.includes(filters.path)) return false;
      if (filters.userId && entry.userId !== filters.userId) return false;
      if (filters.success !== undefined && entry.success !== filters.success) return false;
      if (filters.since && entry.timestamp < filters.since) return false;
      if (filters.until && entry.timestamp > filters.until) return false;
      return true;
    });
  }

  /**
   * Get recent operations
   */
  getRecent(count: number = 100): FileOperationAudit[] {
    return this.auditLog.slice(-count);
  }

  /**
   * Get operation statistics
   */
  getStats(): {
    total: number;
    byOperation: Record<FileOperation, number>;
    successRate: number;
    uniqueUsers: number;
    uniquePaths: number;
  } {
    const byOperation: Partial<Record<FileOperation, number>> = {};
    let successCount = 0;
    const users = new Set<string>();
    const paths = new Set<string>();

    for (const entry of this.auditLog) {
      byOperation[entry.operation] = (byOperation[entry.operation] || 0) + 1;
      if (entry.success) successCount++;
      if (entry.userId) users.add(entry.userId);
      paths.add(entry.path);
    }

    return {
      total: this.auditLog.length,
      byOperation: byOperation as Record<FileOperation, number>,
      successRate: this.auditLog.length > 0 ? successCount / this.auditLog.length : 1,
      uniqueUsers: users.size,
      uniquePaths: paths.size,
    };
  }

  /**
   * Export audit log
   */
  export(): string {
    return JSON.stringify(this.auditLog, null, 2);
  }

  /**
   * Clear audit log
   */
  clear(): void {
    this.auditLog.length = 0;
  }

  private generateAuditId(): string {
    return `audit-${Date.now()}-${randomBytes(4).toString("hex")}`;
  }
}

// =============================================================================
// SECURE FILE OPERATIONS
// =============================================================================

export class SecureFileOperations {
  private readonly chroot: ChrootJail;
  private readonly integrity: FileIntegrityMonitor;
  private readonly audit: FileAuditLogger;
  private readonly backups = new Map<string, FileBackup>();

  constructor(
    projectRoot: string,
    options: {
      readOnly?: boolean;
      allowedExtensions?: string[];
      enableIntegrityMonitoring?: boolean;
      enableAudit?: boolean;
    } = {}
  ) {
    this.chroot = new ChrootJail({
      rootPath: projectRoot,
      readOnly: options.readOnly ?? false,
      allowedExtensions: options.allowedExtensions,
    });

    this.integrity = new FileIntegrityMonitor();
    this.audit = new FileAuditLogger();

    if (options.enableIntegrityMonitoring) {
      this.integrity.startPeriodicChecks();
    }
  }

  /**
   * Read file securely
   */
  async readFile(
    path: string,
    options: { userId?: string; ipAddress?: string } = {}
  ): Promise<Buffer> {
    try {
      const content = await this.chroot.readFile(path);
      
      this.audit.log({
        operation: "read",
        path,
        success: true,
        userId: options.userId,
        ipAddress: options.ipAddress,
      });

      return Buffer.isBuffer(content) ? content : Buffer.from(content);
    } catch (error) {
      this.audit.log({
        operation: "read",
        path,
        success: false,
        error: String(error),
        userId: options.userId,
        ipAddress: options.ipAddress,
      });
      throw error;
    }
  }

  /**
   * Write file securely with backup
   */
  async writeFile(
    path: string,
    content: Buffer | string,
    options: { userId?: string; ipAddress?: string; createBackup?: boolean } = {}
  ): Promise<void> {
    const createBackup = options.createBackup ?? true;

    try {
      // Create backup if file exists
      if (createBackup) {
        try {
          const backup = await this.chroot.createBackup(path);
          this.backups.set(path, backup);
        } catch {
          // File doesn't exist yet
        }
      }

      await this.chroot.writeFile(path, content, { createBackup: false });

      // Update integrity record
      await this.integrity.updateRecord(resolve(this.chroot["config"].rootPath, path));

      this.audit.log({
        operation: "write",
        path,
        success: true,
        userId: options.userId,
        ipAddress: options.ipAddress,
        details: { size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf8") },
      });
    } catch (error) {
      this.audit.log({
        operation: "write",
        path,
        success: false,
        error: String(error),
        userId: options.userId,
        ipAddress: options.ipAddress,
      });
      throw error;
    }
  }

  /**
   * Restore file from backup
   */
  async restoreBackup(
    path: string,
    options: { userId?: string; ipAddress?: string } = {}
  ): Promise<boolean> {
    const backup = this.backups.get(path);
    if (!backup) {
      return false;
    }

    try {
      await this.chroot.restoreFromBackup(backup.backupPath);

      this.audit.log({
        operation: "write",
        path,
        success: true,
        userId: options.userId,
        ipAddress: options.ipAddress,
        details: { restoredFrom: backup.backupPath },
      });

      return true;
    } catch (error) {
      this.audit.log({
        operation: "write",
        path,
        success: false,
        error: String(error),
        userId: options.userId,
        ipAddress: options.ipAddress,
      });
      throw error;
    }
  }

  /**
   * Get audit stats
   */
  getAuditStats() {
    return this.audit.getStats();
  }

  /**
   * Get integrity report
   */
  async getIntegrityReport() {
    return this.integrity.checkAll();
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export const fileAuditLogger = new FileAuditLogger();
export const fileIntegrityMonitor = new FileIntegrityMonitor();
