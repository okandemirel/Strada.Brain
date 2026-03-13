/**
 * Alerting System for Strada.Brain
 * Export all alerting components and utilities
 */

// Types
export type {
    Alert,
    AlertChannel,
    AlertConfig,
    AlertLevel,
    AlertMetadata,
    AlertResult,
    AlertRule,
    AlertStats,
    BackupThresholds,
    ChannelResult,
    ErrorThresholds,
    MonitorConfig,
    SecurityThresholds,
    SystemThresholds,
} from './types.js';

// Alert Manager
export {
    AlertManager,
    getAlertManager,
    resetAlertManager,
} from './alert-manager.js';

// Monitors
export {
    SystemMonitor,
    getSystemMonitor,
    resetSystemMonitor,
} from './monitors/system-monitor.js';

export {
    ErrorMonitor,
    getErrorMonitor,
    resetErrorMonitor,
} from './monitors/error-monitor.js';

export {
    SecurityMonitor,
    getSecurityMonitor,
    resetSecurityMonitor,
} from './monitors/security-monitor.js';

export {
    BackupMonitor,
    getBackupMonitor,
    resetBackupMonitor,
} from './monitors/backup-monitor.js';

// Re-export all monitors for convenience
export * as Monitors from './monitors/index.js';
