/**
 * Network Security / Firewall for Strada.Brain
 * 
 * Provides:
 * - IP whitelisting/blacklisting
 * - Rate limiting per IP
 * - DDoS protection
 * - Connection tracking
 * - Geo-blocking (basic)
 */

import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface IpRange {
  type: "single" | "cidr" | "range";
  value: string;
  description?: string;
}

export interface FirewallRule {
  id: string;
  name: string;
  action: "allow" | "deny" | "rate_limit";
  direction: "inbound" | "outbound" | "both";
  protocol?: "tcp" | "udp" | "icmp" | "any";
  sourceIps?: IpRange[];
  destinationIps?: IpRange[];
  ports?: number[];
  priority: number;
  enabled: boolean;
  log: boolean;
  rateLimit?: {
    requestsPerSecond: number;
    burstSize: number;
  };
}

export interface ConnectionInfo {
  id: string;
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  protocol: string;
  establishedAt: number;
  lastActivityAt: number;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
}

export interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  requestCount: number;
  windowStart: number;
}

export interface DdosProtectionConfig {
  enabled: boolean;
  connectionLimit: number;
  requestsPerSecondThreshold: number;
  burstThreshold: number;
  blockDuration: number;
  whitelistIps: string[];
  challengeMode: "none" | "captcha" | "proof_of_work";
}

export interface NetworkSecurityEvent {
  id: string;
  timestamp: number;
  type: "blocked" | "rate_limited" | "suspicious" | "ddos_detected";
  sourceIp: string;
  details: Record<string, unknown>;
  ruleId?: string;
}

// =============================================================================
// IP UTILITIES
// =============================================================================

export class IpUtils {
  /**
   * Convert IP to numeric representation
   */
  static ipToLong(ip: string): number {
    const parts = ip.split(".");
    if (parts.length !== 4) return 0;
    
    return parts.reduce((acc, part) => {
      return (acc << 8) + parseInt(part, 10);
    }, 0) >>> 0;
  }

  /**
   * Check if IP is in CIDR range
   */
  static isInCidr(ip: string, cidr: string): boolean {
    const [rangeIp, bits] = cidr.split("/");
    const mask = parseInt(bits || "0", 10);
    
    if (mask < 0 || mask > 32) return false;
    
    const ipLong = this.ipToLong(ip);
    const rangeLong = this.ipToLong(rangeIp || "");
    const maskLong = (0xFFFFFFFF << (32 - mask)) >>> 0;
    
    return (ipLong & maskLong) === (rangeLong & maskLong);
  }

  /**
   * Check if IP is in range
   */
  static isInRange(ip: string, startIp: string, endIp: string): boolean {
    const ipLong = this.ipToLong(ip);
    const startLong = this.ipToLong(startIp);
    const endLong = this.ipToLong(endIp);
    
    return ipLong >= startLong && ipLong <= endLong;
  }

  /**
   * Check if IP is private
   */
  static isPrivate(ip: string): boolean {
    return (
      this.isInCidr(ip, "10.0.0.0/8") ||
      this.isInCidr(ip, "172.16.0.0/12") ||
      this.isInCidr(ip, "192.168.0.0/16") ||
      ip === "127.0.0.1" ||
      ip.startsWith("127.")
    );
  }

  /**
   * Check if IP is loopback
   */
  static isLoopback(ip: string): boolean {
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
  }

  /**
   * Validate IP address format
   */
  static isValidIp(ip: string): boolean {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F:]{2,39})$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  }

  /**
   * Parse CIDR notation
   */
  static parseCidr(cidr: string): { network: string; mask: number } | null {
    const parts = cidr.split("/");
    if (parts.length !== 2) return null;
    
    const mask = parseInt(parts[1] || '', 10);
    if (isNaN(mask) || mask < 0 || mask > 32) return null;
    
    return { network: parts[0] || "", mask };
  }
}

// =============================================================================
// FIREWALL ENGINE
// =============================================================================

export class Firewall {
  private rules: FirewallRule[] = [];
  private whitelist = new Set<string>();
  private blacklist = new Set<string>();
  private readonly logger = getLogger();

  /**
   * Add a firewall rule
   */
  addRule(rule: Omit<FirewallRule, "id">): FirewallRule {
    const fullRule: FirewallRule = {
      ...rule,
      id: this.generateRuleId(),
    };

    this.rules.push(fullRule);
    this.sortRules();

    this.logger.info("Firewall rule added", { ruleId: fullRule.id, name: fullRule.name });
    
    return fullRule;
  }

  /**
   * Remove a firewall rule
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index >= 0) {
      this.rules.splice(index, 1);
      this.logger.info("Firewall rule removed", { ruleId });
      return true;
    }
    return false;
  }

  /**
   * Add IP to whitelist
   */
  whitelistIp(ip: string): void {
    this.whitelist.add(ip);
    this.logger.info("IP whitelisted", { ip });
  }

  /**
   * Remove IP from whitelist
   */
  removeWhitelistIp(ip: string): void {
    this.whitelist.delete(ip);
  }

  /**
   * Add IP to blacklist
   */
  blacklistIp(ip: string): void {
    this.blacklist.add(ip);
    this.logger.warn("IP blacklisted", { ip });
  }

  /**
   * Remove IP from blacklist
   */
  removeBlacklistIp(ip: string): void {
    this.blacklist.delete(ip);
  }

  /**
   * Check if connection should be allowed
   */
  checkConnection(
    sourceIp: string,
    destinationIp: string,
    destinationPort: number,
    protocol: string = "tcp"
  ): { allowed: boolean; action: string; ruleId?: string } {
    // Check whitelist first
    if (this.whitelist.has(sourceIp) || this.isIpInRanges(sourceIp, this.getWhitelistedRanges())) {
      return { allowed: true, action: "whitelist" };
    }

    // Check blacklist
    if (this.blacklist.has(sourceIp) || this.isIpInRanges(sourceIp, this.getBlacklistedRanges())) {
      return { allowed: false, action: "blacklist" };
    }

    // Evaluate rules in priority order
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (this.matchesRule(rule, sourceIp, destinationIp, destinationPort, protocol)) {
        if (rule.log) {
          this.logger.info("Firewall rule matched", {
            ruleId: rule.id,
            action: rule.action,
            sourceIp,
            destinationPort,
          });
        }

        return {
          allowed: rule.action === "allow",
          action: rule.action,
          ruleId: rule.id,
        };
      }
    }

    // Default deny
    return { allowed: false, action: "default_deny" };
  }

  /**
   * Get all rules
   */
  getRules(): FirewallRule[] {
    return [...this.rules];
  }

  /**
   * Get whitelisted IPs
   */
  getWhitelistedIps(): string[] {
    return Array.from(this.whitelist);
  }

  /**
   * Get blacklisted IPs
   */
  getBlacklistedIps(): string[] {
    return Array.from(this.blacklist);
  }

  private matchesRule(
    rule: FirewallRule,
    sourceIp: string,
    destinationIp: string,
    destinationPort: number,
    protocol: string
  ): boolean {
    // Check protocol
    if (rule.protocol && rule.protocol !== "any" && rule.protocol !== protocol) {
      return false;
    }

    // Check source IPs
    if (rule.sourceIps && rule.sourceIps.length > 0) {
      const matchesSource = rule.sourceIps.some((range) =>
        this.ipMatchesRange(sourceIp, range)
      );
      if (!matchesSource) return false;
    }

    // Check destination IPs
    if (rule.destinationIps && rule.destinationIps.length > 0) {
      const matchesDest = rule.destinationIps.some((range) =>
        this.ipMatchesRange(destinationIp, range)
      );
      if (!matchesDest) return false;
    }

    // Check ports
    if (rule.ports && rule.ports.length > 0) {
      if (!rule.ports.includes(destinationPort)) return false;
    }

    return true;
  }

  private ipMatchesRange(ip: string, range: IpRange): boolean {
    switch (range.type) {
      case "single":
        return ip === range.value;
      case "cidr":
        return IpUtils.isInCidr(ip, range.value);
      case "range": {
        const [start, end] = range.value.split("-");
        return IpUtils.isInRange(ip, start || "", end || "");
      }
      default:
        return false;
    }
  }

  private isIpInRanges(ip: string, ranges: IpRange[]): boolean {
    return ranges.some((range) => this.ipMatchesRange(ip, range));
  }

  private getWhitelistedRanges(): IpRange[] {
    return this.rules
      .filter((r) => r.action === "allow" && r.sourceIps)
      .flatMap((r) => r.sourceIps || []);
  }

  private getBlacklistedRanges(): IpRange[] {
    return this.rules
      .filter((r) => r.action === "deny" && r.sourceIps)
      .flatMap((r) => r.sourceIps || []);
  }

  private sortRules(): void {
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  private generateRuleId(): string {
    return `fw-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// =============================================================================
// RATE LIMITER
// =============================================================================

export class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private readonly defaultRate: number;
  private readonly defaultBurst: number;
  private readonly logger = getLogger();

  constructor(defaultRate = 10, defaultBurst = 20) {
    this.defaultRate = defaultRate;
    this.defaultBurst = defaultBurst;
  }

  /**
   * Check if request is allowed under rate limit
   */
  checkLimit(
    key: string,
    customRate?: number,
    customBurst?: number
  ): { allowed: boolean; remaining: number; resetTime: number; retryAfter?: number } {
    const rate = customRate || this.defaultRate;
    const burst = customBurst || this.defaultBurst;
    const now = Date.now();

    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: burst,
        lastRefill: now,
        requestCount: 0,
        windowStart: now,
      };
      this.buckets.set(key, bucket);
    }

    // Refill tokens
    const timePassed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(burst, bucket.tokens + timePassed * rate);
    bucket.lastRefill = now;
    bucket.requestCount++;

    // Check if allowed
    if (bucket.tokens >= 1) {
      bucket.tokens--;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetTime: now + (1 / rate) * 1000,
      };
    }

    // Rate limited
    const retryAfter = Math.ceil((1 - bucket.tokens) / rate * 1000);
    
    this.logger.warn("Rate limit exceeded", { key, retryAfter });

    return {
      allowed: false,
      remaining: 0,
      resetTime: now + retryAfter,
      retryAfter,
    };
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Get current status for a key
   */
  getStatus(key: string): { tokens: number; requestsInWindow: number } | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;

    return {
      tokens: bucket.tokens,
      requestsInWindow: bucket.requestCount,
    };
  }

  /**
   * Cleanup old buckets
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, bucket] of Array.from(this.buckets.entries())) {
      if (now - bucket.lastRefill > maxAgeMs) {
        this.buckets.delete(key);
        removed++;
      }
    }

    return removed;
  }
}

// =============================================================================
// DDoS PROTECTION
// =============================================================================

export class DdosProtection {
  private readonly config: DdosProtectionConfig;
  private readonly connections = new Map<string, ConnectionInfo[]>();
  private readonly requestCounts = new Map<string, { count: number; windowStart: number }>();
  private readonly blockedIps = new Map<string, number>(); // IP -> unblock time
  private readonly suspiciousIps = new Set<string>();
  private readonly logger = getLogger();

  constructor(config: Partial<DdosProtectionConfig> = {}) {
    this.config = {
      enabled: true,
      connectionLimit: 1000,
      requestsPerSecondThreshold: 100,
      burstThreshold: 200,
      blockDuration: 3600000, // 1 hour
      whitelistIps: [],
      challengeMode: "none",
      ...config,
    };
  }

  /**
   * Check if IP is allowed to connect
   */
  checkIp(ip: string): { allowed: boolean; reason?: string; challenge?: boolean } {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    // Check whitelist
    if (this.config.whitelistIps.includes(ip)) {
      return { allowed: true };
    }

    // Check if currently blocked
    const unblockTime = this.blockedIps.get(ip);
    if (unblockTime && Date.now() < unblockTime) {
      return {
        allowed: false,
        reason: `IP blocked until ${new Date(unblockTime).toISOString()}`,
      };
    }

    // Remove expired block
    if (unblockTime) {
      this.blockedIps.delete(ip);
    }

    // Check request rate
    const rateCheck = this.checkRequestRate(ip);
    if (!rateCheck.allowed) {
      this.blockIp(ip);
      return {
        allowed: false,
        reason: "DDoS protection: Rate limit exceeded",
      };
    }

    // Check connection count
    const connectionCheck = this.checkConnectionCount(ip);
    if (!connectionCheck.allowed) {
      return {
        allowed: false,
        reason: "DDoS protection: Too many connections",
      };
    }

    // Check if suspicious
    if (this.suspiciousIps.has(ip)) {
      if (this.config.challengeMode !== "none") {
        return { allowed: false, reason: "Suspicious activity detected", challenge: true };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a request from an IP
   */
  recordRequest(ip: string): void {
    const now = Date.now();
    const record = this.requestCounts.get(ip);

    if (!record || now - record.windowStart > 1000) {
      this.requestCounts.set(ip, { count: 1, windowStart: now });
    } else {
      record.count++;
    }

    // Check for burst
    if (record && record.count > this.config.burstThreshold) {
      this.logger.warn("Burst detected", { ip, count: record.count });
      this.suspiciousIps.add(ip);
    }
  }

  /**
   * Add a connection
   */
  addConnection(connection: Omit<ConnectionInfo, "id" | "establishedAt">): string {
    const id = `conn-${Date.now()}-${randomBytes(4).toString("hex")}`;
    
    const conn: ConnectionInfo = {
      ...connection,
      id,
      establishedAt: Date.now(),
    };

    const ipConns = this.connections.get(connection.sourceIp) || [];
    ipConns.push(conn);
    this.connections.set(connection.sourceIp, ipConns);

    return id;
  }

  /**
   * Remove a connection
   */
  removeConnection(connectionId: string): void {
    for (const [ip, conns] of Array.from(this.connections.entries())) {
      const index = conns.findIndex((c) => c.id === connectionId);
      if (index >= 0) {
        conns.splice(index, 1);
        if (conns.length === 0) {
          this.connections.delete(ip);
        }
        break;
      }
    }
  }

  /**
   * Block an IP
   */
  blockIp(ip: string, duration?: number): void {
    const blockDuration = duration || this.config.blockDuration;
    const unblockTime = Date.now() + blockDuration;
    
    this.blockedIps.set(ip, unblockTime);
    this.logger.error("IP blocked by DDoS protection", {
      ip,
      unblockAt: new Date(unblockTime).toISOString(),
    });

    // Close all connections from this IP
    this.connections.delete(ip);
  }

  /**
   * Unblock an IP
   */
  unblockIp(ip: string): void {
    this.blockedIps.delete(ip);
    this.suspiciousIps.delete(ip);
    this.logger.info("IP unblocked", { ip });
  }

  /**
   * Get blocked IPs
   */
  getBlockedIps(): Array<{ ip: string; unblockAt: number }> {
    return Array.from(this.blockedIps.entries()).map(([ip, unblockAt]) => ({
      ip,
      unblockAt,
    }));
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalConnections: number;
    connectionsPerIp: Record<string, number>;
    blockedIpCount: number;
    suspiciousIpCount: number;
  } {
    let totalConnections = 0;
    const connectionsPerIp: Record<string, number> = {};

    for (const [ip, conns] of Array.from(this.connections.entries())) {
      totalConnections += conns.length;
      connectionsPerIp[ip] = conns.length;
    }

    return {
      totalConnections,
      connectionsPerIp,
      blockedIpCount: this.blockedIps.size,
      suspiciousIpCount: this.suspiciousIps.size,
    };
  }

  private checkRequestRate(ip: string): { allowed: boolean } {
    const record = this.requestCounts.get(ip);
    if (!record) return { allowed: true };

    return {
      allowed: record.count < this.config.requestsPerSecondThreshold,
    };
  }

  private checkConnectionCount(ip: string): { allowed: boolean } {
    const ipConns = this.connections.get(ip) || [];
    return { allowed: ipConns.length < this.config.connectionLimit };
  }
}

// Re-import randomBytes
import { randomBytes } from "node:crypto";

// =============================================================================
// EXPORTS
// =============================================================================

export const firewall = new Firewall();
export const rateLimiter = new RateLimiter();
export const ddosProtection = new DdosProtection();
