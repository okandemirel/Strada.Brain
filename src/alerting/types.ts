/**
 * Alerting Types for Strata.Brain
 */

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface AlertConfig {
    /** Discord webhook URL */
    discordWebhook?: string;
    /** Slack webhook URL */
    slackWebhook?: string;
    /** Email configuration */
    email?: {
        smtpHost: string;
        smtpPort: number;
        smtpUser: string;
        smtpPass: string;
        from: string;
        to: string[];
        useTLS?: boolean;
    };
    /** Telegram configuration */
    telegram?: {
        botToken: string;
        chatId: string;
    };
    /** PagerDuty integration key */
    pagerDutyKey?: string;
    /** OpsGenie API key */
    opsGenieKey?: string;
    /** Custom webhook URL */
    customWebhook?: string;
    /** Minimum alert level to send */
    minLevel?: AlertLevel;
    /** Rate limiting: minimum seconds between same-type alerts */
    rateLimitSeconds?: number;
    /** Enable/disable specific channels */
    channels?: {
        discord?: boolean;
        slack?: boolean;
        email?: boolean;
        telegram?: boolean;
        pagerDuty?: boolean;
        opsGenie?: boolean;
        customWebhook?: boolean;
        console?: boolean;
    };
}

export interface AlertMetadata {
    [key: string]: unknown;
    /** Source component/service */
    source?: string;
    /** Hostname where alert originated */
    hostname?: string;
    /** Timestamp of the event */
    timestamp?: string;
    /** Related error/stack trace */
    error?: string;
    /** Additional context */
    context?: Record<string, unknown>;
}

export interface Alert {
    id: string;
    level: AlertLevel;
    title: string;
    message: string;
    metadata: AlertMetadata;
    timestamp: Date;
    acknowledged?: boolean;
    acknowledgedBy?: string;
    acknowledgedAt?: Date;
}

export interface AlertRule {
    id: string;
    name: string;
    description: string;
    condition: () => boolean | Promise<boolean>;
    level: AlertLevel;
    message: string | ((data: unknown) => string);
    cooldownMs: number;
    enabled: boolean;
    lastTriggered?: Date;
    triggerCount: number;
}

export interface MonitorConfig {
    enabled: boolean;
    intervalMs: number;
    alertLevel: AlertLevel;
}

export interface SystemThresholds {
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
    loadAverage: number;
}

export interface ErrorThresholds {
    maxErrorsPerMinute: number;
    maxErrorRatePercent: number;
    maxConsecutiveErrors: number;
}

export interface SecurityThresholds {
    maxFailedLoginsPerMinute: number;
    maxSuspiciousRequestsPerMinute: number;
    blockDurationMinutes: number;
}

export interface BackupThresholds {
    maxBackupAgeHours: number;
    minBackupSuccessRate: number;
}

export type AlertChannel = 'discord' | 'slack' | 'email' | 'telegram' | 'pagerDuty' | 'opsGenie' | 'customWebhook' | 'console';

export interface ChannelResult {
    channel: AlertChannel;
    success: boolean;
    error?: string;
    responseTime?: number;
}

export interface AlertResult {
    alert: Alert;
    results: ChannelResult[];
    sentAt: Date;
    duration: number;
}

export interface AlertStats {
    totalAlerts: number;
    byLevel: Record<AlertLevel, number>;
    byChannel: Record<AlertChannel, number>;
    failedSends: number;
    averageResponseTime: number;
}
