import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorMonitor, resetErrorMonitor } from './error-monitor.js';

describe('ErrorMonitor', () => {
    let monitor: ErrorMonitor;

    beforeEach(() => {
        resetErrorMonitor();
        monitor = new ErrorMonitor(
            { maxErrorsPerMinute: 10, maxConsecutiveErrors: 5 },
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
    });

    describe('error recording', () => {
        it('should record errors', () => {
            const error = new Error('Test error');
            monitor.recordError(error, 'test-source', { detail: 'info' });
            
            const stats = monitor.getStats();
            expect(stats.totalErrors).toBe(1);
        });

        it('should track errors by source', () => {
            monitor.recordError(new Error('Error 1'), 'source-a');
            monitor.recordError(new Error('Error 2'), 'source-a');
            monitor.recordError(new Error('Error 3'), 'source-b');
            
            const stats = monitor.getStats();
            expect(stats.errorsBySource.get('source-a')).toBe(2);
            expect(stats.errorsBySource.get('source-b')).toBe(1);
        });

        it('should track consecutive errors', () => {
            monitor.recordError(new Error('Error 1'), 'test');
            monitor.recordError(new Error('Error 2'), 'test');
            monitor.recordError(new Error('Error 3'), 'test');
            
            const stats = monitor.getStats();
            expect(stats.consecutiveErrors).toBe(3);
        });
    });

    describe('trackFunction', () => {
        it('should track successful function execution', () => {
            const result = monitor.trackFunction(() => 42, 'test-fn');
            expect(result).toBe(42);
            
            const stats = monitor.getStats();
            expect(stats.consecutiveErrors).toBe(0);
        });

        it('should track function errors', () => {
            expect(() => {
                monitor.trackFunction(() => {
                    throw new Error('Function error');
                }, 'test-fn');
            }).toThrow('Function error');
            
            const stats = monitor.getStats();
            expect(stats.totalErrors).toBe(1);
        });
    });

    describe('trackAsyncFunction', () => {
        it('should track successful async execution', async () => {
            const result = await monitor.trackAsyncFunction(
                async () => 'success',
                'test-async'
            );
            expect(result).toBe('success');
        });

        it('should track async errors', async () => {
            await expect(
                monitor.trackAsyncFunction(async () => {
                    throw new Error('Async error');
                }, 'test-async')
            ).rejects.toThrow('Async error');
            
            const stats = monitor.getStats();
            expect(stats.totalErrors).toBe(1);
        });
    });

    describe('trackAPICall', () => {
        it('should track successful API calls', () => {
            monitor.trackAPICall(true, '/api/test');
            
            const stats = monitor.getStats();
            expect(stats.consecutiveErrors).toBe(0);
        });

        it('should track failed API calls', () => {
            monitor.trackAPICall(false, '/api/test', new Error('API error'));
            
            const stats = monitor.getStats();
            expect(stats.totalErrors).toBe(1);
        });
    });

    describe('getRecentErrors', () => {
        it('should return recent errors', () => {
            monitor.recordError(new Error('Error 1'), 'test');
            monitor.recordError(new Error('Error 2'), 'test');
            monitor.recordError(new Error('Error 3'), 'test');
            
            const recent = monitor.getRecentErrors(2);
            expect(recent).toHaveLength(2);
        });

        it('should filter by source', () => {
            monitor.recordError(new Error('Error 1'), 'source-a');
            monitor.recordError(new Error('Error 2'), 'source-b');
            monitor.recordError(new Error('Error 3'), 'source-a');
            
            const sourceA = monitor.getErrorsBySource('source-a', 10);
            expect(sourceA).toHaveLength(2);
        });
    });

    describe('clearHistory', () => {
        it('should clear error history', () => {
            monitor.recordError(new Error('Error'), 'test');
            monitor.clearHistory();
            
            const stats = monitor.getStats();
            expect(stats.totalErrors).toBe(0);
            expect(stats.consecutiveErrors).toBe(0);
        });
    });

    describe('getStatus', () => {
        it('should return monitor status', () => {
            const status = monitor.getStatus();
            expect(status.running).toBe(false);
            expect(status.enabled).toBe(true);
            expect(status.thresholds).toBeDefined();
            expect(status.eventsCount).toBe(0);
        });
    });
});
