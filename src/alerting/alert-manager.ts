/**
 * Alert Manager for Strata.Brain
 * Multi-channel alerting system with Discord, Slack, Email, Telegram support
 */

import { createHash, randomBytes } from 'crypto';
import { Alert, AlertChannel, AlertConfig, AlertLevel, AlertMetadata, AlertResult, AlertStats, ChannelResult } from './types.js';

/**
 * Discord webhook payload builder
 */
interface DiscordEmbed {
    title: string;
    description: string;
    color: number;
    timestamp: string;
    fields?: { name: string; value: string; inline?: boolean }[];
    footer?: { text: string };
}

/**
 * Alert Manager class
 */
export class AlertManager {
    private config: AlertConfig;
    private alertHistory: Alert[] = [];
    private maxHistory = 1000;
    private lastAlertTime: Map<string, number> = new Map();
    private stats: AlertStats = {
        totalAlerts: 0,
        byLevel: { info: 0, warning: 0, critical: 0 },
        byChannel: {
            discord: 0,
            slack: 0,
            email: 0,
            telegram: 0,
            pagerDuty: 0,
            opsGenie: 0,
            customWebhook: 0,
            console: 0,
        },
        failedSends: 0,
        averageResponseTime: 0,
    };

    constructor(config: AlertConfig = {}) {
        this.config = {
            minLevel: 'info',
            rateLimitSeconds: 60,
            channels: {
                discord: true,
                slack: true,
                email: true,
                telegram: true,
                pagerDuty: true,
                opsGenie: true,
                customWebhook: true,
                console: true,
            },
            ...config,
        };
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<AlertConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): AlertConfig {
        return { ...this.config };
    }

    /**
     * Send an alert through all configured channels
     */
    async sendAlert(
        level: AlertLevel,
        title: string,
        message: string,
        metadata: AlertMetadata = {}
    ): Promise<AlertResult> {
        // Check minimum level
        if (!this.shouldSendLevel(level)) {
            return {
                alert: this.createAlert(level, title, message, metadata),
                results: [],
                sentAt: new Date(),
                duration: 0,
            };
        }

        // Check rate limiting
        const alertKey = `${level}:${title}`;
        if (this.isRateLimited(alertKey)) {
            console.log(`[AlertManager] Rate limited: ${alertKey}`);
            return {
                alert: this.createAlert(level, title, message, metadata),
                results: [],
                sentAt: new Date(),
                duration: 0,
            };
        }

        const alert = this.createAlert(level, title, message, metadata);
        const startTime = Date.now();
        const results: ChannelResult[] = [];

        // Send to all enabled channels concurrently
        const channels: AlertChannel[] = ['discord', 'slack', 'email', 'telegram', 'pagerDuty', 'opsGenie', 'customWebhook', 'console'];
        
        const sendPromises = channels.map(async (channel) => {
            if (this.isChannelEnabled(channel)) {
                const result = await this.sendToChannel(channel, alert);
                results.push(result);
                this.updateStats(channel, result.success);
            }
        });

        await Promise.all(sendPromises);

        const duration = Date.now() - startTime;
        this.recordAlert(alert, duration);

        return {
            alert,
            results,
            sentAt: new Date(),
            duration,
        };
    }

    /**
     * Send alert to a specific channel
     */
    private async sendToChannel(channel: AlertChannel, alert: Alert): Promise<ChannelResult> {
        const startTime = Date.now();
        
        try {
            switch (channel) {
                case 'discord':
                    await this.sendDiscord(alert);
                    break;
                case 'slack':
                    await this.sendSlack(alert);
                    break;
                case 'email':
                    await this.sendEmail(alert);
                    break;
                case 'telegram':
                    await this.sendTelegram(alert);
                    break;
                case 'pagerDuty':
                    await this.sendPagerDuty(alert);
                    break;
                case 'opsGenie':
                    await this.sendOpsGenie(alert);
                    break;
                case 'customWebhook':
                    await this.sendCustomWebhook(alert);
                    break;
                case 'console':
                    this.sendConsole(alert);
                    break;
            }
            
            return {
                channel,
                success: true,
                responseTime: Date.now() - startTime,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                channel,
                success: false,
                error: errorMessage,
                responseTime: Date.now() - startTime,
            };
        }
    }

    /**
     * Send alert to Discord webhook with rich embeds
     */
    private async sendDiscord(alert: Alert): Promise<void> {
        if (!this.config.discordWebhook) {
            throw new Error('Discord webhook not configured');
        }

        const colorMap: Record<AlertLevel, number> = {
            info: 3447003,      // Blue
            warning: 16776960,  // Yellow
            critical: 15158332, // Red
        };

        const emojiMap: Record<AlertLevel, string> = {
            info: 'ℹ️',
            warning: '⚠️',
            critical: '🚨',
        };

        const embed: DiscordEmbed = {
            title: `${emojiMap[alert.level]} ${alert.title}`,
            description: alert.message,
            color: colorMap[alert.level],
            timestamp: alert.timestamp.toISOString(),
            fields: [],
            footer: { text: `Strata.Brain Alert • ID: ${alert.id}` },
        };

        // Add metadata fields
        if (alert.metadata.source) {
            embed.fields!.push({ name: 'Source', value: String(alert.metadata.source), inline: true });
        }
        if (alert.metadata.hostname) {
            embed.fields!.push({ name: 'Hostname', value: String(alert.metadata.hostname), inline: true });
        }
        if (alert.metadata.error) {
            embed.fields!.push({ 
                name: 'Error Details', 
                value: `\n\n${String(alert.metadata.error).slice(0, 1000)}\n`, 
                inline: false 
            });
        }

        // Add @mention for critical alerts
        const content = alert.level === 'critical' ? '@everyone CRITICAL ALERT' : undefined;

        const response = await fetch(this.config.discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content,
                embeds: [embed],
            }),
        });

        if (!response.ok) {
            throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Send alert to Slack webhook
     */
    private async sendSlack(alert: Alert): Promise<void> {
        if (!this.config.slackWebhook) {
            throw new Error('Slack webhook not configured');
        }

        const colorMap: Record<AlertLevel, string> = {
            info: '#3498db',
            warning: '#f1c40f',
            critical: '#e74c3c',
        };

        const emojiMap: Record<AlertLevel, string> = {
            info: ':information_source:',
            warning: ':warning:',
            critical: ':rotating_light:',
        };

        const payload = {
            text: alert.level === 'critical' ? '*CRITICAL ALERT*' : undefined,
            attachments: [{
                color: colorMap[alert.level],
                title: `${emojiMap[alert.level]} ${alert.title}`,
                text: alert.message,
                fields: [
                    { title: 'Level', value: alert.level.toUpperCase(), short: true },
                    { title: 'Time', value: alert.timestamp.toISOString(), short: true },
                    ...(alert.metadata.source ? [{ title: 'Source', value: String(alert.metadata.source), short: true }] : []),
                    ...(alert.metadata.hostname ? [{ title: 'Hostname', value: String(alert.metadata.hostname), short: true }] : []),
                ],
                footer: `Strata.Brain Alert • ${alert.id}`,
                ts: Math.floor(alert.timestamp.getTime() / 1000),
            }],
        };

        const response = await fetch(this.config.slackWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Send alert via email
     */
    private async sendEmail(alert: Alert): Promise<void> {
        if (!this.config.email) {
            throw new Error('Email not configured');
        }

        // Dynamic import for nodemailer (optional dependency)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let nodemailer: { createTransport: (config: unknown) => { sendMail: (options: Record<string, unknown>) => Promise<unknown> } };
        try {
            // @ts-ignore - Optional dependency, may not be installed
            nodemailer = await import('nodemailer');
        } catch {
            throw new Error('nodemailer not installed. Run: npm install nodemailer');
        }

        const transporter = nodemailer.createTransport({
            host: this.config.email.smtpHost,
            port: this.config.email.smtpPort,
            secure: this.config.email.useTLS ?? true,
            auth: {
                user: this.config.email.smtpUser,
                pass: this.config.email.smtpPass,
            },
        });

        const subject = `[${alert.level.toUpperCase()}] ${alert.title}`;
        const html = this.generateEmailHtml(alert);

        await transporter.sendMail({
            from: this.config.email.from,
            to: this.config.email.to.join(', '),
            subject,
            html,
            text: alert.message,
        });
    }

    /**
     * Send alert via Telegram
     */
    private async sendTelegram(alert: Alert): Promise<void> {
        if (!this.config.telegram) {
            throw new Error('Telegram not configured');
        }

        const emojiMap: Record<AlertLevel, string> = {
            info: 'ℹ️',
            warning: '⚠️',
            critical: '🚨',
        };

        const text = `
${emojiMap[alert.level]} *${alert.title}*

${alert.message}

*Level:* ${alert.level.toUpperCase()}
*Time:* ${alert.timestamp.toISOString()}
*Source:* ${alert.metadata.source || 'Unknown'}
*Hostname:* ${alert.metadata.hostname || 'Unknown'}
        `.trim();

        const url = `https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: this.config.telegram.chatId,
                text,
                parse_mode: 'Markdown',
            }),
        });

        if (!response.ok) {
            throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Send alert to PagerDuty
     */
    private async sendPagerDuty(alert: Alert): Promise<void> {
        if (!this.config.pagerDutyKey) {
            throw new Error('PagerDuty not configured');
        }

        const severityMap: Record<AlertLevel, string> = {
            info: 'info',
            warning: 'warning',
            critical: 'critical',
        };

        const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routing_key: this.config.pagerDutyKey,
                event_action: alert.level === 'critical' ? 'trigger' : 'trigger',
                dedup_key: alert.id,
                payload: {
                    summary: alert.title,
                    severity: severityMap[alert.level],
                    source: alert.metadata.source || 'Strata.Brain',
                    custom_details: {
                        message: alert.message,
                        ...alert.metadata,
                    },
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`PagerDuty API error: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Send alert to OpsGenie
     */
    private async sendOpsGenie(alert: Alert): Promise<void> {
        if (!this.config.opsGenieKey) {
            throw new Error('OpsGenie not configured');
        }

        const priorityMap: Record<AlertLevel, string> = {
            info: 'P5',
            warning: 'P3',
            critical: 'P1',
        };

        const response = await fetch('https://api.opsgenie.com/v2/alerts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `GenieKey ${this.config.opsGenieKey}`,
            },
            body: JSON.stringify({
                message: alert.title,
                description: alert.message,
                priority: priorityMap[alert.level],
                alias: alert.id,
                details: alert.metadata,
            }),
        });

        if (!response.ok) {
            throw new Error(`OpsGenie API error: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Send alert to custom webhook
     */
    private async sendCustomWebhook(alert: Alert): Promise<void> {
        if (!this.config.customWebhook) {
            throw new Error('Custom webhook not configured');
        }

        const response = await fetch(this.config.customWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: alert.id,
                level: alert.level,
                title: alert.title,
                message: alert.message,
                metadata: alert.metadata,
                timestamp: alert.timestamp.toISOString(),
            }),
        });

        if (!response.ok) {
            throw new Error(`Custom webhook error: ${response.status} ${response.statusText}`);
        }
    }

    /**
     * Send alert to console
     */
    private sendConsole(alert: Alert): void {
        const colorMap: Record<AlertLevel, string> = {
            info: '\x1b[34m',    // Blue
            warning: '\x1b[33m', // Yellow
            critical: '\x1b[31m', // Red
        };
        const reset = '\x1b[0m';

        console.log(`
${colorMap[alert.level]}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}
${colorMap[alert.level]}[${alert.level.toUpperCase()}] ${alert.title}${reset}
${alert.message}

ID: ${alert.id}
Time: ${alert.timestamp.toISOString()}
Source: ${alert.metadata.source || 'Unknown'}
Hostname: ${alert.metadata.hostname || 'Unknown'}
${colorMap[alert.level]}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}
        `.trim());
    }

    /**
     * Generate HTML email content
     */
    private generateEmailHtml(alert: Alert): string {
        const colorMap: Record<AlertLevel, string> = {
            info: '#3498db',
            warning: '#f39c12',
            critical: '#e74c3c',
        };

        return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: ${colorMap[alert.level]}; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
        .content { background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
        .footer { font-size: 12px; color: #666; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; }
        .metadata { background-color: #fff; padding: 10px; margin-top: 10px; border-radius: 3px; }
        pre { background-color: #f4f4f4; padding: 10px; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>[${alert.level.toUpperCase()}] ${alert.title}</h2>
        </div>
        <div class="content">
            <p>${alert.message.replace(/\\n/g, '<br>')}</p>
            
            <div class="metadata">
                <strong>Alert ID:</strong> ${alert.id}<br>
                <strong>Timestamp:</strong> ${alert.timestamp.toISOString()}<br>
                <strong>Source:</strong> ${alert.metadata.source || 'Unknown'}<br>
                <strong>Hostname:</strong> ${alert.metadata.hostname || 'Unknown'}
            </div>
            
            ${alert.metadata.error ? `
            <h3>Error Details:</h3>
            <pre>${alert.metadata.error}</pre>
            ` : ''}
        </div>
        <div class="footer">
            <p>This alert was generated by Strata.Brain Alert Manager</p>
        </div>
    </div>
</body>
</html>
        `;
    }

    /**
     * Create alert object
     */
    private createAlert(level: AlertLevel, title: string, message: string, metadata: AlertMetadata): Alert {
        return {
            id: this.generateAlertId(),
            level,
            title,
            message,
            metadata: {
                ...metadata,
                timestamp: metadata.timestamp || new Date().toISOString(),
                hostname: metadata.hostname || this.getHostname(),
            },
            timestamp: new Date(),
        };
    }

    /**
     * Generate unique alert ID
     */
    private generateAlertId(): string {
        return createHash('sha256')
            .update(randomBytes(16))
            .digest('hex')
            .slice(0, 12);
    }

    /**
     * Get hostname
     */
    private getHostname(): string {
        try {
            return process.env.HOSTNAME || require('os').hostname() || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    /**
     * Check if alert level should be sent
     */
    private shouldSendLevel(level: AlertLevel): boolean {
        const levels: AlertLevel[] = ['info', 'warning', 'critical'];
        const minIndex = levels.indexOf(this.config.minLevel || 'info');
        const levelIndex = levels.indexOf(level);
        return levelIndex >= minIndex;
    }

    /**
     * Check if channel is enabled
     */
    private isChannelEnabled(channel: AlertChannel): boolean {
        return this.config.channels?.[channel] !== false;
    }

    /**
     * Check if alert is rate limited
     */
    private isRateLimited(alertKey: string): boolean {
        const lastTime = this.lastAlertTime.get(alertKey);
        if (!lastTime) return false;
        
        const rateLimitMs = (this.config.rateLimitSeconds || 60) * 1000;
        return Date.now() - lastTime < rateLimitMs;
    }

    /**
     * Record alert in history
     */
    private recordAlert(alert: Alert, duration: number): void {
        this.alertHistory.push(alert);
        if (this.alertHistory.length > this.maxHistory) {
            this.alertHistory.shift();
        }

        this.stats.totalAlerts++;
        this.stats.byLevel[alert.level]++;

        const alertKey = `${alert.level}:${alert.title}`;
        this.lastAlertTime.set(alertKey, Date.now());

        // Update average response time
        this.stats.averageResponseTime = 
            (this.stats.averageResponseTime * (this.stats.totalAlerts - 1) + duration) / this.stats.totalAlerts;
    }

    /**
     * Update statistics
     */
    private updateStats(channel: AlertChannel, success: boolean): void {
        this.stats.byChannel[channel]++;
        if (!success) {
            this.stats.failedSends++;
        }
    }

    /**
     * Get alert history
     */
    getHistory(options?: { level?: AlertLevel; limit?: number; since?: Date }): Alert[] {
        let history = [...this.alertHistory];

        if (options?.level) {
            history = history.filter(a => a.level === options.level);
        }

        if (options?.since) {
            history = history.filter(a => a.timestamp >= options.since!);
        }

        if (options?.limit) {
            history = history.slice(-options.limit);
        }

        return history;
    }

    /**
     * Get statistics
     */
    getStats(): AlertStats {
        return { ...this.stats };
    }

    /**
     * Acknowledge an alert
     */
    acknowledgeAlert(alertId: string, acknowledgedBy: string): boolean {
        const alert = this.alertHistory.find(a => a.id === alertId);
        if (alert && !alert.acknowledged) {
            alert.acknowledged = true;
            alert.acknowledgedBy = acknowledgedBy;
            alert.acknowledgedAt = new Date();
            return true;
        }
        return false;
    }

    /**
     * Clear alert history
     */
    clearHistory(): void {
        this.alertHistory = [];
    }

    /**
     * Reset statistics
     */
    resetStats(): void {
        this.stats = {
            totalAlerts: 0,
            byLevel: { info: 0, warning: 0, critical: 0 },
            byChannel: {
                discord: 0,
                slack: 0,
                email: 0,
                telegram: 0,
                pagerDuty: 0,
                opsGenie: 0,
                customWebhook: 0,
                console: 0,
            },
            failedSends: 0,
            averageResponseTime: 0,
        };
    }
}

// Singleton instance
let alertManagerInstance: AlertManager | null = null;

export function getAlertManager(config?: AlertConfig): AlertManager {
    if (!alertManagerInstance) {
        alertManagerInstance = new AlertManager(config);
    }
    return alertManagerInstance;
}

export function resetAlertManager(): void {
    alertManagerInstance = null;
}
