import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertManager, resetAlertManager } from './alert-manager.js';

describe('AlertManager', () => {
    let manager: AlertManager;

    beforeEach(() => {
        resetAlertManager();
        manager = new AlertManager({
            minLevel: 'info',
            channels: { console: true },
        });
    });

    describe('sendAlert', () => {
        it('should create and send an alert', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            
            const result = await manager.sendAlert(
                'warning',
                'Test Alert',
                'This is a test alert'
            );
            
            expect(result.alert).toBeDefined();
            expect(result.alert.level).toBe('warning');
            expect(result.alert.title).toBe('Test Alert');
            expect(result.alert.message).toBe('This is a test alert');
            expect(result.results.length).toBeGreaterThan(0);
            
            consoleSpy.mockRestore();
        });

        it('should respect minimum alert level', async () => {
            const managerWithMinLevel = new AlertManager({
                minLevel: 'warning',
                channels: { console: true },
            });
            
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            
            // Info alert should not be sent
            const result = await managerWithMinLevel.sendAlert(
                'info',
                'Info Alert',
                'This should not be sent'
            );
            
            expect(result.results).toHaveLength(0);
            
            consoleSpy.mockRestore();
        });

        it('should track alert history', async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            
            await manager.sendAlert('info', 'Alert 1', 'Message 1');
            await manager.sendAlert('warning', 'Alert 2', 'Message 2');
            await manager.sendAlert('critical', 'Alert 3', 'Message 3');
            
            const history = manager.getHistory();
            expect(history).toHaveLength(3);
        });

        it('should filter history by level', async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            
            await manager.sendAlert('info', 'Alert 1', 'Message 1');
            await manager.sendAlert('warning', 'Alert 2', 'Message 2');
            await manager.sendAlert('critical', 'Alert 3', 'Message 3');
            
            const criticalHistory = manager.getHistory({ level: 'critical' });
            expect(criticalHistory).toHaveLength(1);
            expect(criticalHistory[0].level).toBe('critical');
        });
    });

    describe('getStats', () => {
        it('should track alert statistics', async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            
            await manager.sendAlert('info', 'Info', 'Info message');
            await manager.sendAlert('warning', 'Warning', 'Warning message');
            await manager.sendAlert('critical', 'Critical', 'Critical message');
            
            const stats = manager.getStats();
            expect(stats.totalAlerts).toBe(3);
            expect(stats.byLevel.info).toBe(1);
            expect(stats.byLevel.warning).toBe(1);
            expect(stats.byLevel.critical).toBe(1);
        });
    });

    describe('acknowledgeAlert', () => {
        it('should acknowledge an alert', async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            
            const result = await manager.sendAlert('warning', 'Test', 'Test message');
            const acknowledged = manager.acknowledgeAlert(result.alert.id, 'test-user');
            
            expect(acknowledged).toBe(true);
            
            const history = manager.getHistory();
            expect(history[0].acknowledged).toBe(true);
            expect(history[0].acknowledgedBy).toBe('test-user');
        });
    });

    describe('configuration', () => {
        it('should update configuration', () => {
            manager.updateConfig({ minLevel: 'critical' });
            expect(manager.getConfig().minLevel).toBe('critical');
        });

        it('should merge config updates', () => {
            const originalRateLimit = manager.getConfig().rateLimitSeconds;
            manager.updateConfig({ minLevel: 'warning' });
            
            expect(manager.getConfig().minLevel).toBe('warning');
            expect(manager.getConfig().rateLimitSeconds).toBe(originalRateLimit);
        });
    });
});

describe('AlertManager singleton', () => {
    it('should return same instance', async () => {
        const { getAlertManager, resetAlertManager } = await import('./alert-manager.js');
        resetAlertManager();
        
        const instance1 = getAlertManager();
        const instance2 = getAlertManager();
        
        expect(instance1).toBe(instance2);
    });
});
