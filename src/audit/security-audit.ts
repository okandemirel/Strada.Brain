/**
 * Security Audit & Monitoring for Strata.Brain
 * 
 * Provides:
 * - Security event logging
 * - SIEM integration helpers
 * - Alert mechanisms
 * - Compliance reporting
 * - Anomaly detection
 */

import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export type SecurityEventType =
  | "authentication_success"
  | "authentication_failure"
  | "authorization_failure"
  | "mfa_verification"
  | "session_created"
  | "session_destroyed"
  | "session_timeout"
  | "privilege_escalation"
  | "suspicious_activity"
  | "brute_force_detected"
  | "data_exfiltration_attempt"
  | "file_integrity_violation"
  | "configuration_change"
  | "api_key_rotated"
  | "firewall_block"
  | "rate_limit_exceeded"
  | "ddos_detected"
  | "malware_detected"
  | "encryption_failure"
  | "certificate_expiring"
  | "backup_created"
  | "backup_restored"
  | "user_created"
  | "user_deleted"
  | "role_changed"
  | "permission_denied"
  | "path_traversal_attempt"
  | "sql_injection_attempt"
  | "xss_attempt"
  | "csrf_attempt";

export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export interface SecurityEvent {
  id: string;
  timestamp: number;
  type: SecurityEventType;
  severity: SecuritySeverity;
  source: {
    ip?: string;
    userId?: string;
    userAgent?: string;
    service?: string;
    component?: string;
  };
  target?: {
    resource?: string;
    action?: string;
    data?: Record<string, unknown>;
  };
  context: {
    requestId?: string;
    sessionId?: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  };
  details: Record<string, unknown>;
  remediation?: string;
}

export interface SecurityAlert {
  id: string;
  eventId: string;
  createdAt: number;
  severity: SecuritySeverity;
  title: string;
  description: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
  escalated: boolean;
  channels: AlertChannel[];
}

export type AlertChannel = "email" | "slack" | "webhook" | "sms" | "pagerduty" | "console";

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: AlertCondition[];
  severity: SecuritySeverity;
  channels: AlertChannel[];
  throttleMs?: number;
  cooldownMs?: number;
}

export interface AlertCondition {
  field: string;
  operator: "equals" | "contains" | "gt" | "lt" | "gte" | "lte" | "in" | "matches";
  value: unknown;
}

export interface SiemConfig {
  enabled: boolean;
  endpoint: string;
  apiKey?: string;
  index: string;
  batchSize: number;
  flushIntervalMs: number;
  fields: Record<string, string>;
}

export interface ComplianceReport {
  period: { start: number; end: number };
  generatedAt: number;
  totalEvents: number;
  eventsByType: Record<SecurityEventType, number>;
  eventsBySeverity: Record<SecuritySeverity, number>;
  authenticationAttempts: { success: number; failure: number };
  authorizationDenials: number;
  suspiciousActivities: number;
  alerts: number;
  unresolvedAlerts: number;
}

// =============================================================================
// SECURITY AUDIT LOGGER
// =============================================================================

export class SecurityAuditLogger {
  private readonly events: SecurityEvent[] = [];
  private readonly maxEvents: number;
  private readonly logger = getLogger();

  constructor(maxEvents: number = 100000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Log a security event
   */
  log(event: Omit<SecurityEvent, "id" | "timestamp">): SecurityEvent {
    const fullEvent: SecurityEvent = {
      ...event,
      id: this.generateEventId(),
      timestamp: Date.now(),
    };

    this.events.push(fullEvent);

    // Maintain max size
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Log to application logger
    const logMethod = this.getLogMethod(fullEvent.severity);
    this.logger[logMethod]("Security event", {
      eventId: fullEvent.id,
      type: fullEvent.type,
      severity: fullEvent.severity,
      source: fullEvent.source,
    });

    return fullEvent;
  }

  /**
   * Log authentication success
   */
  logAuthSuccess(
    userId: string,
    ip: string,
    details?: Record<string, unknown>
  ): SecurityEvent {
    return this.log({
      type: "authentication_success",
      severity: "info",
      source: { userId, ip },
      context: {},
      details: details || {},
    });
  }

  /**
   * Log authentication failure
   */
  logAuthFailure(
    username: string,
    ip: string,
    reason: string,
    details?: Record<string, unknown>
  ): SecurityEvent {
    return this.log({
      type: "authentication_failure",
      severity: "medium",
      source: { ip },
      context: {},
      details: { username, reason, ...details },
    });
  }

  /**
   * Log authorization failure
   */
  logAuthzFailure(
    userId: string,
    resource: string,
    action: string,
    ip?: string
  ): SecurityEvent {
    return this.log({
      type: "authorization_failure",
      severity: "medium",
      source: { userId, ip },
      target: { resource, action },
      context: {},
      details: {},
    });
  }

  /**
   * Log suspicious activity
   */
  logSuspicious(
    ip: string,
    activity: string,
    details: Record<string, unknown>,
    severity: SecuritySeverity = "high"
  ): SecurityEvent {
    return this.log({
      type: "suspicious_activity",
      severity,
      source: { ip },
      context: {},
      details: { activity, ...details },
    });
  }

  /**
   * Query events
   */
  query(filters: {
    type?: SecurityEventType;
    severity?: SecuritySeverity;
    userId?: string;
    ip?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): SecurityEvent[] {
    let results = this.events.filter((event) => {
      if (filters.type && event.type !== filters.type) return false;
      if (filters.severity && event.severity !== filters.severity) return false;
      if (filters.userId && event.source.userId !== filters.userId) return false;
      if (filters.ip && event.source.ip !== filters.ip) return false;
      if (filters.since && event.timestamp < filters.since) return false;
      if (filters.until && event.timestamp > filters.until) return false;
      return true;
    });

    if (filters.limit) {
      results = results.slice(-filters.limit);
    }

    return results;
  }

  /**
   * Get event statistics
   */
  getStats(period?: { start: number; end: number }): {
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    topSources: Array<{ ip?: string; count: number }>;
  } {
    const events = period
      ? this.events.filter((e) => e.timestamp >= period.start && e.timestamp <= period.end)
      : this.events;

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const sourceCounts = new Map<string, number>();

    for (const event of events) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
      
      const sourceKey = event.source.ip || "unknown";
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1);
    }

    const topSources = Array.from(sourceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({ ip: ip === "unknown" ? undefined : ip, count }));

    return {
      total: events.length,
      byType,
      bySeverity,
      topSources,
    };
  }

  /**
   * Generate compliance report
   */
  generateComplianceReport(period: { start: number; end: number }): ComplianceReport {
    const events = this.events.filter(
      (e) => e.timestamp >= period.start && e.timestamp <= period.end
    );

    const eventsByType: Partial<Record<SecurityEventType, number>> = {};
    const eventsBySeverity: Partial<Record<SecuritySeverity, number>> = {};

    let authSuccess = 0;
    let authFailure = 0;
    let authzDenials = 0;
    let suspicious = 0;

    for (const event of events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
      eventsBySeverity[event.severity] = (eventsBySeverity[event.severity] || 0) + 1;

      if (event.type === "authentication_success") authSuccess++;
      if (event.type === "authentication_failure") authFailure++;
      if (event.type === "authorization_failure") authzDenials++;
      if (event.type === "suspicious_activity") suspicious++;
    }

    return {
      period,
      generatedAt: Date.now(),
      totalEvents: events.length,
      eventsByType: eventsByType as Record<SecurityEventType, number>,
      eventsBySeverity: eventsBySeverity as Record<SecuritySeverity, number>,
      authenticationAttempts: { success: authSuccess, failure: authFailure },
      authorizationDenials: authzDenials,
      suspiciousActivities: suspicious,
      alerts: 0, // Will be filled by AlertManager
      unresolvedAlerts: 0,
    };
  }

  /**
   * Export events
   */
  export(format: "json" | "csv" = "json"): string {
    if (format === "csv") {
      const headers = ["id", "timestamp", "type", "severity", "source.ip", "source.userId"];
      const rows = this.events.map((e) =>
        [e.id, e.timestamp, e.type, e.severity, e.source.ip || "", e.source.userId || ""].join(",")
      );
      return [headers.join(","), ...rows].join("\n");
    }

    return JSON.stringify(this.events, null, 2);
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events.length = 0;
  }

  private generateEventId(): string {
    return `sec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getLogMethod(severity: SecuritySeverity): "debug" | "info" | "warn" | "error" {
    switch (severity) {
      case "info":
        return "info";
      case "low":
      case "medium":
        return "warn";
      case "high":
      case "critical":
        return "error";
      default:
        return "info";
    }
  }
}

// =============================================================================
// ALERT MANAGER
// =============================================================================

export class AlertManager {
  private readonly rules: AlertRule[] = [];
  private readonly alerts: SecurityAlert[] = [];
  private readonly lastAlertTime = new Map<string, number>();
  private readonly logger = getLogger();
  private siemConfig?: SiemConfig;

  /**
   * Configure SIEM integration
   */
  configureSiem(config: SiemConfig): void {
    this.siemConfig = config;
    this.logger.info("SIEM configured", { endpoint: config.endpoint, index: config.index });
  }

  /**
   * Add alert rule
   */
  addRule(rule: Omit<AlertRule, "id">): AlertRule {
    const fullRule: AlertRule = {
      ...rule,
      id: this.generateRuleId(),
    };

    this.rules.push(fullRule);
    this.logger.info("Alert rule added", { ruleId: fullRule.id, name: fullRule.name });

    return fullRule;
  }

  /**
   * Process security event and generate alerts
   */
  processEvent(event: SecurityEvent): SecurityAlert[] {
    const triggeredAlerts: SecurityAlert[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      // Check cooldown
      const lastAlert = this.lastAlertTime.get(rule.id);
      if (lastAlert && rule.cooldownMs && Date.now() - lastAlert < rule.cooldownMs) {
        continue;
      }

      // Check conditions
      if (this.matchesConditions(rule.conditions, event)) {
        const alert = this.createAlert(event, rule);
        this.alerts.push(alert);
        triggeredAlerts.push(alert);
        
        this.lastAlertTime.set(rule.id, Date.now());

        // Send to channels
        this.sendAlert(alert, rule.channels);

        // Send to SIEM
        this.sendToSiem(event, alert);
      }
    }

    return triggeredAlerts;
  }

  /**
   * Acknowledge alert
   */
  acknowledgeAlert(
    alertId: string,
    userId: string
  ): { success: boolean; alert?: SecurityAlert } {
    const alert = this.alerts.find((a) => a.id === alertId);
    
    if (!alert) {
      return { success: false };
    }

    alert.acknowledged = true;
    alert.acknowledgedBy = userId;
    alert.acknowledgedAt = Date.now();

    this.logger.info("Alert acknowledged", { alertId, userId });

    return { success: true, alert };
  }

  /**
   * Get pending alerts
   */
  getPendingAlerts(severity?: SecuritySeverity): SecurityAlert[] {
    return this.alerts.filter(
      (a) => !a.acknowledged && (!severity || a.severity === severity)
    );
  }

  /**
   * Get alert statistics
   */
  getStats(): {
    total: number;
    pending: number;
    acknowledged: number;
    bySeverity: Record<string, number>;
  } {
    const bySeverity: Record<string, number> = {};
    let pending = 0;
    let acknowledged = 0;

    for (const alert of this.alerts) {
      bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
      if (alert.acknowledged) {
        acknowledged++;
      } else {
        pending++;
      }
    }

    return {
      total: this.alerts.length,
      pending,
      acknowledged,
      bySeverity,
    };
  }

  private matchesConditions(conditions: AlertCondition[], event: SecurityEvent): boolean {
    return conditions.every((condition) => {
      const value = this.getFieldValue(event, condition.field);

      switch (condition.operator) {
        case "equals":
          return value === condition.value;
        case "contains":
          return String(value).includes(String(condition.value));
        case "gt":
          return Number(value) > Number(condition.value);
        case "lt":
          return Number(value) < Number(condition.value);
        case "gte":
          return Number(value) >= Number(condition.value);
        case "lte":
          return Number(value) <= Number(condition.value);
        case "in":
          return Array.isArray(condition.value) && condition.value.includes(value);
        case "matches":
          return new RegExp(String(condition.value)).test(String(value));
        default:
          return false;
      }
    });
  }

  private getFieldValue(event: SecurityEvent, field: string): unknown {
    const parts = field.split(".");
    let value: unknown = event;

    for (const part of parts) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  private createAlert(event: SecurityEvent, rule: AlertRule): SecurityAlert {
    return {
      id: this.generateAlertId(),
      eventId: event.id,
      createdAt: Date.now(),
      severity: rule.severity,
      title: `Security Alert: ${event.type}`,
      description: this.generateAlertDescription(event),
      acknowledged: false,
      escalated: event.severity === "critical",
      channels: rule.channels,
    };
  }

  private generateAlertDescription(event: SecurityEvent): string {
    const parts = [
      `Type: ${event.type}`,
      `Severity: ${event.severity}`,
      `Source: ${event.source.ip || "unknown"}`,
    ];

    if (event.source.userId) {
      parts.push(`User: ${event.source.userId}`);
    }

    if (event.target) {
      parts.push(`Target: ${event.target.resource || "N/A"}`);
    }

    return parts.join(" | ");
  }

  private sendAlert(alert: SecurityAlert, channels: AlertChannel[]): void {
    for (const channel of channels) {
      switch (channel) {
        case "email":
          this.logger.info("[ALERT-EMAIL]", { alertId: alert.id, title: alert.title });
          break;
        case "slack":
          this.logger.info("[ALERT-SLACK]", { alertId: alert.id, title: alert.title });
          break;
        case "webhook":
          this.logger.info("[ALERT-WEBHOOK]", { alertId: alert.id, title: alert.title });
          break;
        case "console":
          this.logger.error(`SECURITY ALERT: ${alert.title} - ${alert.description}`);
          break;
        default:
          this.logger.info(`[ALERT-${channel.toUpperCase()}]`, { alertId: alert.id });
      }
    }
  }

  private async sendToSiem(event: SecurityEvent, alert: SecurityAlert): Promise<void> {
    if (!this.siemConfig?.enabled) return;

    // Prepare SIEM payload (TODO: implement actual sending)
    void {
      ...event,
      alert: {
        id: alert.id,
        title: alert.title,
        severity: alert.severity,
      },
      "@timestamp": new Date(event.timestamp).toISOString(),
    };

    try {
      this.logger.debug("Sending to SIEM", { eventId: event.id });
      // In production: Send to SIEM endpoint
    } catch (error) {
      this.logger.error("Failed to send to SIEM", { eventId: event.id, error });
    }
  }

  private generateRuleId(): string {
    return `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateAlertId(): string {
    return `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// =============================================================================
// ANOMALY DETECTION
// =============================================================================

export class AnomalyDetector {
  private baselines = new Map<string, { mean: number; stdDev: number; samples: number }>();
  private readonly sensitivity: number;
  private readonly minSamples: number;
  private readonly logger = getLogger();

  constructor(sensitivity: number = 2, minSamples: number = 30) {
    this.sensitivity = sensitivity;
    this.minSamples = minSamples;
  }

  /**
   * Update baseline with new value
   */
  updateBaseline(metric: string, value: number): void {
    const current = this.baselines.get(metric);

    if (!current) {
      this.baselines.set(metric, { mean: value, stdDev: 0, samples: 1 });
      return;
    }

    // Welford's online algorithm for mean and variance
    current.samples++;
    const delta = value - current.mean;
    current.mean += delta / current.samples;
    const delta2 = value - current.mean;
    
    if (current.samples > 1) {
      const variance = (current.stdDev ** 2) * (current.samples - 2) + delta * delta2;
      current.stdDev = Math.sqrt(variance / (current.samples - 1));
    }
  }

  /**
   * Check if value is anomalous
   */
  detect(metric: string, value: number): {
    isAnomaly: boolean;
    zScore: number;
    confidence: number;
  } {
    const baseline = this.baselines.get(metric);

    if (!baseline || baseline.samples < this.minSamples) {
      return { isAnomaly: false, zScore: 0, confidence: 0 };
    }

    if (baseline.stdDev === 0) {
      return {
        isAnomaly: value !== baseline.mean,
        zScore: value === baseline.mean ? 0 : Infinity,
        confidence: 1,
      };
    }

    const zScore = Math.abs((value - baseline.mean) / baseline.stdDev);
    const isAnomaly = zScore > this.sensitivity;
    const confidence = Math.min(1, zScore / (this.sensitivity * 2));

    if (isAnomaly) {
      this.logger.warn("Anomaly detected", {
        metric,
        value,
        expected: baseline.mean,
        zScore,
      });
    }

    return { isAnomaly, zScore, confidence };
  }

  /**
   * Get baseline stats
   */
  getStats(metric: string): { mean: number; stdDev: number; samples: number } | null {
    return this.baselines.get(metric) || null;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export const securityAudit = new SecurityAuditLogger();
export const alertManager = new AlertManager();
export const anomalyDetector = new AnomalyDetector();
