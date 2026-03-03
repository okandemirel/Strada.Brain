import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackupScheduler, Schedule, resetBackupScheduler } from './backup-scheduler.js';

describe('BackupScheduler', () => {
    let scheduler: BackupScheduler;

    beforeEach(() => {
        resetBackupScheduler();
        const uniqueDir = '/tmp/test-backups-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        scheduler = new BackupScheduler({
            backupDir: uniqueDir,
            retentionDays: 7,
        });
    });
    
    afterEach(() => {
        scheduler.stop();
    });

    describe('addJob', () => {
        it('should add a backup job', () => {
            const jobId = scheduler.addJob({
                name: 'Test Backup',
                schedule: Schedule.DAILY,
                command: 'echo',
                args: ['test'],
            });
            
            expect(jobId).toBeDefined();
            expect(typeof jobId).toBe('string');
            expect(jobId).toHaveLength(8);
            
            const job = scheduler.getJob(jobId);
            expect(job).toBeDefined();
            expect(job?.name).toBe('Test Backup');
            expect(job?.schedule).toBe(Schedule.DAILY);
        });

        it('should generate unique job IDs', () => {
            const id1 = scheduler.addJob({
                name: 'Job 1',
                schedule: Schedule.DAILY,
                command: 'echo',
            });
            
            const id2 = scheduler.addJob({
                name: 'Job 2',
                schedule: Schedule.DAILY,
                command: 'echo',
            });
            
            expect(id1).not.toBe(id2);
        });
    });

    describe('removeJob', () => {
        it('should remove a job', () => {
            const jobId = scheduler.addJob({
                name: 'Test Job',
                schedule: Schedule.DAILY,
                command: 'echo',
            });
            
            const removed = scheduler.removeJob(jobId);
            expect(removed).toBe(true);
            expect(scheduler.getJob(jobId)).toBeUndefined();
        });

        it('should return false for non-existent job', () => {
            const removed = scheduler.removeJob('non-existent');
            expect(removed).toBe(false);
        });
    });

    describe('setJobEnabled', () => {
        it('should enable and disable jobs', () => {
            const jobId = scheduler.addJob({
                name: 'Test Job',
                schedule: Schedule.DAILY,
                command: 'echo',
            });
            
            expect(scheduler.getJob(jobId)?.enabled).toBe(true);
            
            scheduler.setJobEnabled(jobId, false);
            expect(scheduler.getJob(jobId)?.enabled).toBe(false);
            
            scheduler.setJobEnabled(jobId, true);
            expect(scheduler.getJob(jobId)?.enabled).toBe(true);
        });
    });

    describe('getJobs', () => {
        it('should return all jobs', () => {
            scheduler.addJob({ name: 'Job 1', schedule: Schedule.DAILY, command: 'echo' });
            scheduler.addJob({ name: 'Job 2', schedule: Schedule.EVERY_HOUR, command: 'echo' });
            
            const jobs = scheduler.getJobs();
            expect(jobs).toHaveLength(2);
        });
    });

    describe('scheduling', () => {
        it('should calculate next run time', () => {
            const jobId = scheduler.addJob({
                name: 'Hourly Job',
                schedule: Schedule.EVERY_HOUR,
                command: 'echo',
            });
            
            const job = scheduler.getJob(jobId);
            expect(job?.nextRun).toBeInstanceOf(Date);
            expect(job?.nextRun.getTime()).toBeGreaterThan(Date.now());
        });
    });

    describe('getStatus', () => {
        it('should return scheduler status', () => {
            const status = scheduler.getStatus();
            expect(status.running).toBe(false);
            expect(status.jobs).toBe(0);
            expect(status.runningJobs).toEqual([]);
        });

        it('should report running state after start', () => {
            scheduler.start(60000);
            const status = scheduler.getStatus();
            expect(status.running).toBe(true);
            scheduler.stop();
        });
    });

    describe('Schedule constants', () => {
        it('should have predefined schedules', () => {
            expect(Schedule.EVERY_MINUTE).toBe('* * * * *');
            expect(Schedule.EVERY_HOUR).toBe('0 * * * *');
            expect(Schedule.DAILY).toBe('0 2 * * *');
            expect(Schedule.WEEKLY).toBe('0 3 * * 0');
            expect(Schedule.MONTHLY).toBe('0 4 1 * *');
        });
    });
});
