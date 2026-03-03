import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SystemMonitor, resetSystemMonitor } from './system-monitor.js';

describe('SystemMonitor', () => {
    let monitor: SystemMonitor;

    beforeEach(() => {
        resetSystemMonitor();
        monitor = new SystemMonitor(
            { cpuPercent: 80, memoryPercent: 85, diskPercent: 85, loadAverage: 4 },
            60000,
            { enabled: true }
        );
    });

    describe('start/stop', () => {
        it('should start and stop monitoring', () => {
            expect(monitor.isRunning()).toBe(false);
            
            monitor.start();
            expect(monitor.isRunning()).toBe(true);
            
            monitor.stop();
            expect(monitor.isRunning()).toBe(false);
        });

        it('should not start multiple times', () => {
            monitor.start();
            monitor.start(); // Should not throw
            expect(monitor.isRunning()).toBe(true);
        });
    });

    describe('thresholds', () => {
        it('should get and update thresholds', () => {
            const thresholds = monitor.getThresholds();
            expect(thresholds.cpuPercent).toBe(80);
            expect(thresholds.memoryPercent).toBe(85);
            
            monitor.updateThresholds({ cpuPercent: 90 });
            const updated = monitor.getThresholds();
            expect(updated.cpuPercent).toBe(90);
            expect(updated.memoryPercent).toBe(85); // Unchanged
        });
    });

    describe('metrics collection', () => {
        it('should collect system metrics', async () => {
            await monitor.check();
            
            const metrics = monitor.getCurrentMetrics();
            expect(metrics).toBeDefined();
            expect(metrics?.cpuPercent).toBeGreaterThanOrEqual(0);
            expect(metrics?.cpuPercent).toBeLessThanOrEqual(100);
            expect(metrics?.memoryPercent).toBeGreaterThanOrEqual(0);
            expect(metrics?.memoryPercent).toBeLessThanOrEqual(100);
        });

        it('should store metrics history', async () => {
            await monitor.check();
            await monitor.check();
            
            const history = monitor.getMetricsHistory();
            expect(history.length).toBeGreaterThanOrEqual(2);
        });

        it('should filter metrics by time window', async () => {
            await monitor.check();
            
            const history = monitor.getMetricsHistory(1);
            expect(history.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('getStatus', () => {
        it('should return monitor status', () => {
            const status = monitor.getStatus();
            expect(status.running).toBe(false);
            expect(status.enabled).toBe(true);
            expect(status.thresholds).toBeDefined();
            expect(status.metricsCount).toBe(0);
        });
    });

    describe('average metrics', () => {
        it('should calculate average metrics', async () => {
            // Collect some metrics
            for (let i = 0; i < 3; i++) {
                await monitor.check();
            }
            
            const avg = monitor.getAverageMetrics(5);
            expect(avg).not.toBeNull();
            expect(avg?.cpuPercent).toBeDefined();
            expect(avg?.memoryPercent).toBeDefined();
        });

        it('should return null when no metrics', () => {
            const avg = monitor.getAverageMetrics(5);
            expect(avg).toBeNull();
        });
    });
});
