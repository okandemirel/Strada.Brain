/**
 * Security Monitor for Strada.Brain
 * Monitors security events: auth failures, suspicious requests, rate limiting
 */

import { createHash } from "crypto";
import { getAlertManager } from "../alert-manager.js";
import { AlertLevel, MonitorConfig, SecurityThresholds } from "../types.js";
import { getLogger } from "../../utils/logger.js";

interface SecurityEvent {
  id: string;
  timestamp: Date;
  type: SecurityEventType;
  severity: AlertLevel;
  source: string;
  ip?: string;
  userId?: string;
  description: string;
  metadata?: Record<string, unknown>;
}

type SecurityEventType =
  | "auth_failure"
  | "unauthorized_access"
  | "suspicious_request"
  | "rate_limit_exceeded"
  | "brute_force_attempt"
  | "privilege_escalation"
  | "data_exfiltration"
  | "injection_attempt"
  | "xss_attempt"
  | "csrf_violation"
  | "session_hijacking";

interface FailedAuthAttempt {
  timestamp: Date;
  ip: string;
  userId?: string;
  count: number;
}

interface BlockedEntry {
  ip: string;
  blockedAt: Date;
  blockedUntil: Date;
  reason: string;
}

interface MonitorState {
  events: SecurityEvent[];
  maxEvents: number;
  failedAuthAttempts: Map<string, FailedAuthAttempt[]>;
  blockedIPs: Map<string, BlockedEntry>;
  suspiciousIPs: Map<string, number>;
  lastAlertTime: Map<string, number>;
  alertCooldownMs: number;
}

/**
 * Security Monitor class
 */
export class SecurityMonitor {
  private config: Required<MonitorConfig>;
  private thresholds: SecurityThresholds;
  private state: MonitorState;
  private checkInterval: number;
  private intervalId?: NodeJS.Timeout;
  private cleanupIntervalId?: NodeJS.Timeout;

  constructor(
    thresholds: Partial<SecurityThresholds> = {},
    checkIntervalMs: number = 60000,
    config: Partial<MonitorConfig> = {},
  ) {
    this.config = {
      enabled: config.enabled ?? true,
      intervalMs: config.intervalMs ?? 60000,
      alertLevel: config.alertLevel ?? "warning",
    };

    this.thresholds = {
      maxFailedLoginsPerMinute: thresholds.maxFailedLoginsPerMinute ?? 5,
      maxSuspiciousRequestsPerMinute: thresholds.maxSuspiciousRequestsPerMinute ?? 10,
      blockDurationMinutes: thresholds.blockDurationMinutes ?? 30,
    };

    this.checkInterval = checkIntervalMs;
    this.state = {
      events: [],
      maxEvents: 10000,
      failedAuthAttempts: new Map(),
      blockedIPs: new Map(),
      suspiciousIPs: new Map(),
      lastAlertTime: new Map(),
      alertCooldownMs: 300000, // 5 minutes
    };
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    // Start periodic checks
    this.intervalId = setInterval(() => {
      this.check();
    }, this.checkInterval);

    // Cleanup old entries every 10 minutes
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupOldEntries();
    }, 600000);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
  }

  /**
   * Check if monitoring is running
   */
  isRunning(): boolean {
    return !!this.intervalId;
  }

  /**
   * Record a security event
   */
  recordEvent(
    type: SecurityEventType,
    severity: AlertLevel,
    source: string,
    description: string,
    options: {
      ip?: string;
      userId?: string;
      metadata?: Record<string, unknown>;
      alertImmediately?: boolean;
    } = {},
  ): SecurityEvent {
    const event: SecurityEvent = {
      id: this.generateEventId(),
      timestamp: new Date(),
      type,
      severity,
      source,
      description,
      ip: options.ip,
      userId: options.userId,
      metadata: options.metadata,
    };

    this.state.events.push(event);

    if (this.state.events.length > this.state.maxEvents) {
      this.state.events.shift();
    }

    // Update suspicious IP tracking
    if (options.ip) {
      const current = this.state.suspiciousIPs.get(options.ip) || 0;
      this.state.suspiciousIPs.set(options.ip, current + 1);
    }

    // Immediate alert for critical events
    if (
      options.alertImmediately !== false &&
      (severity === "critical" || type === "brute_force_attempt")
    ) {
      this.sendImmediateAlert(event);
    }

    return event;
  }

  /**
   * Record authentication failure
   */
  recordAuthFailure(
    ip: string,
    options: {
      userId?: string;
      username?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const now = new Date();
    const key = options.userId || ip;

    // Get or create attempts array for this key
    let attempts = this.state.failedAuthAttempts.get(key);
    if (!attempts) {
      attempts = [];
      this.state.failedAuthAttempts.set(key, attempts);
    }

    // Add new attempt
    attempts.push({
      timestamp: now,
      ip,
      userId: options.userId,
      count: 1,
    });

    // Clean old attempts (older than 10 minutes)
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60000);
    const recentAttempts = attempts.filter((a) => a.timestamp >= tenMinutesAgo);
    this.state.failedAuthAttempts.set(key, recentAttempts);

    // Count attempts in last minute
    const oneMinuteAgo = new Date(now.getTime() - 60000);
    const attemptsLastMinute = recentAttempts.filter((a) => a.timestamp >= oneMinuteAgo);

    // Check for brute force
    if (attemptsLastMinute.length >= this.thresholds.maxFailedLoginsPerMinute) {
      this.handleBruteForce(key, ip, attemptsLastMinute.length, options);
    }

    // Record as security event
    this.recordEvent(
      "auth_failure",
      attemptsLastMinute.length > 3 ? "warning" : "info",
      "authentication",
      `Authentication failed for ${options.userId || options.username || "unknown user"} from ${ip}`,
      {
        ip,
        userId: options.userId,
        metadata: { reason: options.reason, attemptCount: attemptsLastMinute.length },
      },
    );
  }

  /**
   * Record unauthorized access attempt
   */
  recordUnauthorizedAccess(
    ip: string,
    options: {
      userId?: string;
      resource: string;
      action: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    this.recordEvent(
      "unauthorized_access",
      "warning",
      "authorization",
      `Unauthorized access attempt to ${options.resource} (${options.action}) from ${ip}`,
      {
        ip,
        userId: options.userId,
        metadata: { resource: options.resource, action: options.action, ...options.metadata },
      },
    );

    // Check for privilege escalation patterns
    if (options.action === "privilege_escalation") {
      this.recordEvent(
        "privilege_escalation",
        "critical",
        "authorization",
        `Possible privilege escalation attempt from ${ip}`,
        { ip, userId: options.userId, alertImmediately: true },
      );
    }
  }

  /**
   * Record suspicious request
   */
  recordSuspiciousRequest(
    ip: string,
    options: {
      type: "sql_injection" | "xss" | "path_traversal" | "command_injection" | "ssrf" | "other";
      path: string;
      details: string;
      requestData?: Record<string, unknown>;
    },
  ): void {
    const eventTypeMap: Record<string, SecurityEventType> = {
      sql_injection: "injection_attempt",
      xss: "xss_attempt",
      path_traversal: "suspicious_request",
      command_injection: "injection_attempt",
      ssrf: "suspicious_request",
      other: "suspicious_request",
    };

    this.recordEvent(
      eventTypeMap[options.type] || "suspicious_request",
      options.type === "sql_injection" || options.type === "command_injection"
        ? "critical"
        : "warning",
      "request_filter",
      `Suspicious request detected: ${options.type} from ${ip}`,
      {
        ip,
        metadata: { path: options.path, details: options.details, ...options.requestData },
      },
    );
  }

  /**
   * Record rate limit exceeded
   */
  recordRateLimitExceeded(
    ip: string,
    options: {
      endpoint: string;
      limit: number;
      window: string;
      userId?: string;
    },
  ): void {
    this.recordEvent(
      "rate_limit_exceeded",
      "warning",
      "rate_limiter",
      `Rate limit exceeded for ${options.endpoint} by ${ip}`,
      {
        ip,
        userId: options.userId,
        metadata: { endpoint: options.endpoint, limit: options.limit, window: options.window },
      },
    );

    // Check if IP should be temporarily blocked
    const recentEvents = this.getRecentEventsForIP(ip, 5);
    const rateLimitEvents = recentEvents.filter((e) => e.type === "rate_limit_exceeded");

    if (rateLimitEvents.length >= 5) {
      this.blockIP(ip, `Multiple rate limit violations (${rateLimitEvents.length} in 5 minutes)`);
    }
  }

  /**
   * Check if IP is blocked
   */
  isBlocked(ip: string): boolean {
    const entry = this.state.blockedIPs.get(ip);
    if (!entry) return false;

    // Check if block has expired
    if (new Date() > entry.blockedUntil) {
      this.state.blockedIPs.delete(ip);
      return false;
    }

    return true;
  }

  /**
   * Block an IP address
   */
  blockIP(ip: string, reason: string, durationMinutes?: number): void {
    const duration = durationMinutes || this.thresholds.blockDurationMinutes;
    const now = new Date();

    this.state.blockedIPs.set(ip, {
      ip,
      blockedAt: now,
      blockedUntil: new Date(now.getTime() + duration * 60000),
      reason,
    });

    this.recordEvent(
      "auth_failure",
      "warning",
      "ip_blocker",
      `IP ${ip} blocked for ${duration} minutes: ${reason}`,
      { ip, metadata: { reason, duration }, alertImmediately: true },
    );
  }

  /**
   * Unblock an IP address
   */
  unblockIP(ip: string): boolean {
    return this.state.blockedIPs.delete(ip);
  }

  /**
   * Handle brute force detection
   */
  private handleBruteForce(
    _key: string,
    ip: string,
    attemptCount: number,
    options: Record<string, unknown>,
  ): void {
    // Block the IP
    this.blockIP(ip, `Brute force detected: ${attemptCount} failed attempts in 1 minute`, 60);

    // Record event
    this.recordEvent(
      "brute_force_attempt",
      "critical",
      "brute_force_detector",
      `Brute force attack detected from ${ip}`,
      {
        ip,
        metadata: { attemptCount, target: options.userId || options.username },
        alertImmediately: true,
      },
    );
  }

  /**
   * Send immediate alert for critical events
   */
  private async sendImmediateAlert(event: SecurityEvent): Promise<void> {
    const alertManager = getAlertManager();

    await alertManager.sendAlert(
      event.severity,
      `Security Alert: ${this.formatEventType(event.type)}`,
      event.description,
      {
        source: "security-monitor",
        context: {
          eventId: event.id,
          eventType: event.type,
          ip: event.ip,
          userId: event.userId,
          ...event.metadata,
        },
      },
    );
  }

  /**
   * Perform periodic checks
   */
  private async check(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      await this.checkSuspiciousPatterns();
    } catch (error) {
      try {
        getLogger().error("[SecurityMonitor] Error checking patterns:", error);
      } catch {
        console.error("[SecurityMonitor] Error checking patterns:", error);
      }
    }
  }

  /**
   * Check for suspicious patterns
   */
  private async checkSuspiciousPatterns(): Promise<void> {
    // Check for IPs with high event counts
    for (const [ip, count] of this.state.suspiciousIPs) {
      if (count > this.thresholds.maxSuspiciousRequestsPerMinute * 5) {
        const recentEvents = this.getRecentEventsForIP(ip, 5);

        this.sendAlertIfNotRateLimited(
          `suspicious-ip-${ip}`,
          "warning",
          "Suspicious IP Activity",
          `IP ${ip} has generated ${count} security events in the last 5 minutes`,
          { ip, eventCount: count, recentEvents: recentEvents.length },
        );
      }
    }
  }

  /**
   * Send alert if not rate limited
   */
  private async sendAlertIfNotRateLimited(
    alertKey: string,
    level: AlertLevel,
    title: string,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const lastAlert = this.state.lastAlertTime.get(alertKey);

    if (lastAlert && now - lastAlert < this.state.alertCooldownMs) {
      return;
    }

    this.state.lastAlertTime.set(alertKey, now);

    const alertManager = getAlertManager();
    await alertManager.sendAlert(level, title, message, {
      source: "security-monitor",
      context,
    });
  }

  /**
   * Get recent events for an IP
   */
  private getRecentEventsForIP(ip: string, minutes: number): SecurityEvent[] {
    const cutoff = new Date(Date.now() - minutes * 60000);
    return this.state.events.filter((e) => e.ip === ip && e.timestamp >= cutoff);
  }

  /**
   * Cleanup old entries
   */
  private cleanupOldEntries(): void {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60000);

    // Cleanup failed auth attempts
    for (const [key, attempts] of this.state.failedAuthAttempts) {
      const recent = attempts.filter((a) => a.timestamp >= oneHourAgo);
      if (recent.length === 0) {
        this.state.failedAuthAttempts.delete(key);
      } else {
        this.state.failedAuthAttempts.set(key, recent);
      }
    }

    // Cleanup suspicious IPs
    for (const [ip] of this.state.suspiciousIPs) {
      const recentEvents = this.getRecentEventsForIP(ip, 60);
      if (recentEvents.length === 0) {
        this.state.suspiciousIPs.delete(ip);
      } else {
        // Recalculate count
        this.state.suspiciousIPs.set(ip, recentEvents.length);
      }
    }

    // Cleanup expired blocks
    for (const [ip, entry] of this.state.blockedIPs) {
      if (now > entry.blockedUntil) {
        this.state.blockedIPs.delete(ip);
      }
    }
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return createHash("sha256")
      .update(Date.now().toString() + Math.random().toString())
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Format event type for display
   */
  private formatEventType(type: SecurityEventType): string {
    return type
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /**
   * Get security statistics
   */
  getStats(timeWindowMinutes: number = 60): {
    totalEvents: number;
    byType: Record<SecurityEventType, number>;
    bySeverity: Record<AlertLevel, number>;
    blockedIPs: number;
    activeBlocks: number;
    suspiciousIPs: number;
  } {
    const cutoff = new Date(Date.now() - timeWindowMinutes * 60000);
    const recentEvents = this.state.events.filter((e) => e.timestamp >= cutoff);

    const byType = {} as Record<SecurityEventType, number>;
    const bySeverity = { info: 0, warning: 0, critical: 0 } as Record<AlertLevel, number>;

    for (const event of recentEvents) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySeverity[event.severity]++;
    }

    // Count active blocks
    const now = new Date();
    let activeBlocks = 0;
    for (const entry of this.state.blockedIPs.values()) {
      if (entry.blockedUntil > now) {
        activeBlocks++;
      }
    }

    return {
      totalEvents: recentEvents.length,
      byType,
      bySeverity,
      blockedIPs: this.state.blockedIPs.size,
      activeBlocks,
      suspiciousIPs: this.state.suspiciousIPs.size,
    };
  }

  /**
   * Get recent security events
   */
  getRecentEvents(options?: {
    type?: SecurityEventType;
    severity?: AlertLevel;
    ip?: string;
    limit?: number;
  }): SecurityEvent[] {
    let events = [...this.state.events];

    if (options?.type) {
      events = events.filter((e) => e.type === options.type);
    }
    if (options?.severity) {
      events = events.filter((e) => e.severity === options.severity);
    }
    if (options?.ip) {
      events = events.filter((e) => e.ip === options.ip);
    }

    events.reverse(); // Most recent first

    if (options?.limit) {
      events = events.slice(0, options.limit);
    }

    return events;
  }

  /**
   * Get blocked IPs
   */
  getBlockedIPs(): BlockedEntry[] {
    const now = new Date();
    return Array.from(this.state.blockedIPs.values())
      .filter((e) => e.blockedUntil > now)
      .sort((a, b) => b.blockedAt.getTime() - a.blockedAt.getTime());
  }

  /**
   * Get monitor status
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    thresholds: SecurityThresholds;
    stats: ReturnType<SecurityMonitor["getStats"]>;
    blockedIPs: number;
  } {
    return {
      running: this.isRunning(),
      enabled: this.config.enabled,
      thresholds: { ...this.thresholds },
      stats: this.getStats(),
      blockedIPs: this.getBlockedIPs().length,
    };
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.state.events = [];
    this.state.failedAuthAttempts.clear();
    this.state.suspiciousIPs.clear();
  }
}

// Singleton instance
let securityMonitorInstance: SecurityMonitor | null = null;

export function getSecurityMonitor(
  thresholds?: Partial<SecurityThresholds>,
  checkIntervalMs?: number,
): SecurityMonitor {
  if (!securityMonitorInstance) {
    securityMonitorInstance = new SecurityMonitor(thresholds, checkIntervalMs);
  }
  return securityMonitorInstance;
}

export function resetSecurityMonitor(): void {
  securityMonitorInstance?.stop();
  securityMonitorInstance = null;
}
