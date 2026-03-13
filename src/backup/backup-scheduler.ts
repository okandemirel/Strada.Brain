/**
 * Backup Scheduler for Strada.Brain
 * Native Node.js backup scheduling with cron-like functionality
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Cron-like pattern parser
interface CronPattern {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
}

interface BackupJob {
    id: string;
    name: string;
    schedule: string;
    command: string;
    args: string[];
    lastRun?: Date;
    nextRun: Date;
    enabled: boolean;
    retryCount: number;
    maxRetries: number;
}

interface BackupConfig {
    backupDir: string;
    retentionDays: number;
    verifyBackups: boolean;
    compressBackups: boolean;
    remoteSync?: {
        type: 's3' | 'rclone' | 'none';
        destination: string;
    };
}

interface BackupResult {
    success: boolean;
    jobId: string;
    timestamp: Date;
    duration: number;
    output: string;
    error?: string;
    checksum?: string;
    size?: number;
}

/**
 * Parse cron expression into pattern object
 * Format: minute hour dayOfMonth month dayOfWeek
 * Supports: * (all), * / n (step - no space), n (specific), n-m (range), n,m (list)
 */
function parseCronExpression(expression: string): CronPattern {
    const parts = expression.trim().split(/\s+/);
    
    if (parts.length !== 5) {
        throw new Error(`Invalid cron expression: ${expression}. Expected 5 parts.`);
    }
    
    const parseField = (field: string, min: number, max: number): number[] => {
        const values: number[] = [];
        
        // Handle list (e.g., "1,2,3")
        const items = field.split(',');
        
        for (const item of items) {
            if (item === '*') {
                // All values
                for (let i = min; i <= max; i++) {
                    values.push(i);
                }
            } else if (item.startsWith('*/')) {
                // Step values (e.g., */5)
                const step = parseInt(item.slice(2), 10);
                for (let i = min; i <= max; i += step) {
                    values.push(i);
                }
            } else if (item.includes('-')) {
                // Range (e.g., 1-5)
                const [startStr, endStr] = item.split('-');
                const start = parseInt(startStr || '0', 10);
                const end = parseInt(endStr || '0', 10);
                for (let i = start; i <= end; i++) {
                    values.push(i);
                }
            } else {
                // Specific value
                values.push(parseInt(item, 10));
            }
        }
        
        return [...new Set(values)].sort((a, b) => a - b);
    };
    
    return {
        minute: parseField(parts[0] || '', 0, 59),
        hour: parseField(parts[1] || '', 0, 23),
        dayOfMonth: parseField(parts[2] || '', 1, 31),
        month: parseField(parts[3] || '', 1, 12),
        dayOfWeek: parseField(parts[4] || '', 0, 6),
    };
}

/**
 * Check if a date matches the cron pattern
 */
function matchesCronPattern(pattern: CronPattern, date: Date): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // 1-12
    const dayOfWeek = date.getDay(); // 0-6
    
    return (
        pattern.minute.includes(minute) &&
        pattern.hour.includes(hour) &&
        pattern.dayOfMonth.includes(dayOfMonth) &&
        pattern.month.includes(month) &&
        pattern.dayOfWeek.includes(dayOfWeek)
    );
}

/**
 * Calculate next run time based on cron pattern
 */
function calculateNextRun(pattern: CronPattern, fromDate: Date = new Date()): Date {
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
    
    // Search for next match (max 1 year)
    for (let i = 0; i < 525600; i++) {
        if (matchesCronPattern(pattern, next)) {
            return next;
        }
        next.setMinutes(next.getMinutes() + 1);
    }
    
    throw new Error('Could not calculate next run time');
}

/**
 * Backup Scheduler class
 */
export class BackupScheduler {
    private jobs: Map<string, BackupJob> = new Map();
    private config: BackupConfig;
    private checkInterval?: NodeJS.Timeout;
    private runningJobs: Map<string, Promise<BackupResult>> = new Map();
    private results: BackupResult[] = [];
    private maxResults = 100;
    private stateFile: string;
    
    constructor(config: Partial<BackupConfig> = {}) {
        this.config = {
            backupDir: config.backupDir || '/backups/strada-brain',
            retentionDays: config.retentionDays || 30,
            verifyBackups: config.verifyBackups !== false,
            compressBackups: config.compressBackups !== false,
            remoteSync: config.remoteSync,
        };
        
        this.stateFile = join(this.config.backupDir, 'scheduler-state.json');
        this.ensureBackupDir();
        this.loadState();
    }
    
    private ensureBackupDir(): void {
        if (!existsSync(this.config.backupDir)) {
            mkdirSync(this.config.backupDir, { recursive: true });
        }
    }
    
    private loadState(): void {
        if (existsSync(this.stateFile)) {
            try {
                const state = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
                for (const jobState of state.jobs || []) {
                    this.jobs.set(jobState.id, {
                        ...jobState,
                        lastRun: jobState.lastRun ? new Date(jobState.lastRun) : undefined,
                        nextRun: new Date(jobState.nextRun),
                    });
                }
            } catch {
                // Ignore corrupted state
            }
        }
    }
    
    private saveState(): void {
        const state = {
            jobs: Array.from(this.jobs.values()).map(job => ({
                ...job,
                lastRun: job.lastRun?.toISOString(),
                nextRun: job.nextRun.toISOString(),
            })),
            savedAt: new Date().toISOString(),
        };
        
        this.ensureBackupDir();
        writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    }
    
    /**
     * Add a new backup job
     */
    addJob(options: {
        name: string;
        schedule: string;
        command: string;
        args?: string[];
        maxRetries?: number;
    }): string {
        const id = createHash('md5').update(`${options.name}-${Date.now()}`).digest('hex').slice(0, 8);
        
        const pattern = parseCronExpression(options.schedule);
        const job: BackupJob = {
            id,
            name: options.name,
            schedule: options.schedule,
            command: options.command,
            args: options.args || [],
            nextRun: calculateNextRun(pattern),
            enabled: true,
            retryCount: 0,
            maxRetries: options.maxRetries || 3,
        };
        
        this.jobs.set(id, job);
        this.saveState();
        
        return id;
    }
    
    /**
     * Remove a backup job
     */
    removeJob(id: string): boolean {
        const deleted = this.jobs.delete(id);
        if (deleted) {
            this.saveState();
        }
        return deleted;
    }
    
    /**
     * Enable/disable a job
     */
    setJobEnabled(id: string, enabled: boolean): boolean {
        const job = this.jobs.get(id);
        if (job) {
            job.enabled = enabled;
            this.saveState();
            return true;
        }
        return false;
    }
    
    /**
     * Get all jobs
     */
    getJobs(): BackupJob[] {
        return Array.from(this.jobs.values());
    }
    
    /**
     * Get job by ID
     */
    getJob(id: string): BackupJob | undefined {
        return this.jobs.get(id);
    }
    
    /**
     * Execute a backup job immediately
     */
    async runJobNow(id: string): Promise<BackupResult> {
        const job = this.jobs.get(id);
        if (!job) {
            throw new Error(`Job not found: ${id}`);
        }
        
        if (this.runningJobs.has(id)) {
            throw new Error(`Job ${id} is already running`);
        }
        
        const runPromise = this.executeJob(job);
        this.runningJobs.set(id, runPromise);
        
        try {
            const result = await runPromise;
            return result;
        } finally {
            this.runningJobs.delete(id);
        }
    }
    
    /**
     * Execute a job
     */
    private async executeJob(job: BackupJob): Promise<BackupResult> {
        const startTime = Date.now();
        const env = {
            ...process.env,
            BACKUP_DIR: this.config.backupDir,
            RETENTION_DAYS: String(this.config.retentionDays),
        };
        
        return new Promise((resolve) => {
            let output = '';
            let errorOutput = '';
            
            const child = spawn(job.command, job.args, {
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            
            child.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            child.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            child.on('close', (code: number | null) => {
                const duration = Date.now() - startTime;
                const success = code === 0;
                
                const result: BackupResult = {
                    success,
                    jobId: job.id,
                    timestamp: new Date(),
                    duration,
                    output: output.trim(),
                    error: errorOutput.trim() || undefined,
                };
                
                if (success) {
                    job.retryCount = 0;
                    // Calculate checksum of latest backup
                    result.checksum = this.calculateLatestBackupChecksum();
                } else {
                    job.retryCount++;
                    result.error = errorOutput.trim() || `Exit code: ${code}`;
                }
                
                job.lastRun = new Date();
                const pattern = parseCronExpression(job.schedule);
                job.nextRun = calculateNextRun(pattern);
                
                this.results.push(result);
                if (this.results.length > this.maxResults) {
                    this.results.shift();
                }
                
                this.saveState();
                resolve(result);
            });
        });
    }
    
    /**
     * Calculate checksum of latest backup file
     */
    private calculateLatestBackupChecksum(): string | undefined {
        try {
            const { execSync } = require('child_process');
            const latest = execSync(
                `ls -t ${this.config.backupDir}/backup_*.tar.gz 2>/dev/null | head -1`
            ).toString().trim();
            
            if (latest) {
                return execSync(`sha256sum "${latest}" | awk '{print $1}'`).toString().trim();
            }
        } catch {
            // Ignore errors
        }
        return undefined;
    }
    
    /**
     * Start the scheduler
     */
    start(checkIntervalMs: number = 60000): void {
        if (this.checkInterval) {
            throw new Error('Scheduler is already running');
        }
        
        this.checkInterval = setInterval(() => {
            this.checkJobs();
        }, checkIntervalMs);
        
        // Immediate first check
        this.checkJobs();
    }
    
    /**
     * Stop the scheduler
     */
    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = undefined;
        }
    }
    
    /**
     * Check and run due jobs
     */
    private checkJobs(): void {
        const now = new Date();
        
        for (const job of this.jobs.values()) {
            if (!job.enabled) continue;
            if (this.runningJobs.has(job.id)) continue;
            if (now < job.nextRun) continue;
            
            // Check if still matches pattern (for missed runs)
            const pattern = parseCronExpression(job.schedule);
            if (matchesCronPattern(pattern, now)) {
                this.executeJob(job).catch(console.error);
            } else {
                // Update next run if we missed it
                job.nextRun = calculateNextRun(pattern, now);
                this.saveState();
            }
        }
    }
    
    /**
     * Get backup results
     */
    getResults(options?: { jobId?: string; limit?: number }): BackupResult[] {
        let results = this.results;
        
        if (options?.jobId) {
            results = results.filter(r => r.jobId === options.jobId);
        }
        
        if (options?.limit) {
            results = results.slice(-options.limit);
        }
        
        return results;
    }
    
    /**
     * Verify backup integrity
     */
    async verifyBackup(backupPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            const { spawn } = require('child_process');
            const tar = spawn('tar', ['-tzf', backupPath]);
            
            tar.on('close', (code: number | null) => {
                resolve(code === 0);
            });
        });
    }
    
    /**
     * Get scheduler status
     */
    getStatus(): {
        running: boolean;
        jobs: number;
        runningJobs: string[];
        lastResult?: BackupResult;
    } {
        return {
            running: !!this.checkInterval,
            jobs: this.jobs.size,
            runningJobs: Array.from(this.runningJobs.keys()),
            lastResult: this.results[this.results.length - 1],
        };
    }
    
    /**
     * Cleanup old backups
     */
    async cleanupOldBackups(): Promise<number> {
        const { execSync } = require('child_process');
        
        try {
            const result = execSync(
                `find ${this.config.backupDir} -name "backup_*.tar.gz" -mtime +${this.config.retentionDays} -delete -print | wc -l`
            ).toString().trim();
            
            return parseInt(result, 10) || 0;
        } catch {
            return 0;
        }
    }
}

// Predefined schedules
export const Schedule = {
    EVERY_MINUTE: '* * * * *',
    EVERY_5_MINUTES: '*/5 * * * *',
    EVERY_15_MINUTES: '*/15 * * * *',
    EVERY_HOUR: '0 * * * *',
    EVERY_6_HOURS: '0 */6 * * *',
    DAILY: '0 2 * * *',
    DAILY_MORNING: '0 9 * * *',
    WEEKLY: '0 3 * * 0',
    MONTHLY: '0 4 1 * *',
} as const;

// Singleton instance
let schedulerInstance: BackupScheduler | null = null;

export function getBackupScheduler(config?: Partial<BackupConfig>): BackupScheduler {
    if (!schedulerInstance) {
        schedulerInstance = new BackupScheduler(config);
    }
    return schedulerInstance;
}

export function resetBackupScheduler(): void {
    schedulerInstance?.stop();
    schedulerInstance = null;
}
