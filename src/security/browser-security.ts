/**
 * Browser security utilities for URL validation and rate limiting.
 *
 * Provides:
 * - URL validation with configurable allow/block lists
 * - Domain blocking (localhost, private IPs, file://)
 * - Rate limiting for browser operations
 * - Security configuration management
 */

import { getLogger } from "../utils/logger.js";

// ---------- Types ----------

export interface BrowserSecurityConfig {
  /** Allowed URL patterns (regex strings). Empty = allow all (except blocked). */
  allowedUrlPatterns: string[];
  /** Blocked URL patterns (regex strings). Takes precedence over allowed. */
  blockedUrlPatterns: string[];
  /** Block localhost/private network access. */
  blockLocalhost: boolean;
  /** Block file:// protocol. */
  blockFileProtocol: boolean;
  /** Block data:// protocol. */
  blockDataProtocol: boolean;
  /** Block javascript:// protocol. */
  blockJavascriptProtocol: boolean;
  /** Max page navigation time in ms. */
  maxNavigationTimeMs: number;
  /** Max screenshot size in MB. */
  maxScreenshotSizeMb: number;
  /** Max download size in MB. */
  maxDownloadSizeMb: number;
  /** Max concurrent browser sessions. */
  maxConcurrentSessions: number;
  /** Max operations per minute per session. */
  maxOperationsPerMinute: number;
}

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

// ---------- Default Configuration ----------

export const DEFAULT_SECURITY_CONFIG: BrowserSecurityConfig = {
  allowedUrlPatterns: [],
  blockedUrlPatterns: [
    // Common admin panels
    "\\/admin",
    "\\/wp-admin",
    "\\/phpmyadmin",
    "\\/server-status",
    // Internal paths
    "\\.git\\/",
    "\\.env",
    "\\.ssh\\/",
    "\\/etc\\/",
    "\\/proc\\/",
    "\\/sys\\/",
  ],
  blockLocalhost: true,
  blockFileProtocol: true,
  blockDataProtocol: true,
  blockJavascriptProtocol: true,
  maxNavigationTimeMs: 30000,
  maxScreenshotSizeMb: 10,
  maxDownloadSizeMb: 50,
  maxConcurrentSessions: 5,
  maxOperationsPerMinute: 60,
};

const REBINDING_HOST_SUFFIXES = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "localhost.direct",
];

// ---------- URL Validation ----------

/**
 * Validates a URL against security configuration.
 */
export function validateUrlWithConfig(
  url: string,
  config: Partial<BrowserSecurityConfig> = {}
): UrlValidationResult {
  const mergedConfig = { ...DEFAULT_SECURITY_CONFIG, ...config };
  const logger = getLogger();

  try {
    const parsedUrl = new URL(url);

    // Check protocol restrictions
    if (mergedConfig.blockFileProtocol && parsedUrl.protocol === "file:") {
      return { valid: false, reason: "file:// protocol is blocked" };
    }

    if (mergedConfig.blockDataProtocol && parsedUrl.protocol === "data:") {
      return { valid: false, reason: "data:// protocol is blocked" };
    }

    if (mergedConfig.blockJavascriptProtocol && parsedUrl.protocol === "javascript:") {
      return { valid: false, reason: "javascript:// protocol is blocked" };
    }

    // Only allow http/https for navigation (unless file is explicitly allowed)
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      if (parsedUrl.protocol === "file:" && !mergedConfig.blockFileProtocol) {
        // file:// allowed via config
      } else {
        return { valid: false, reason: `Protocol "${parsedUrl.protocol}" is not allowed` };
      }
    }

    // Check localhost/private network
    if (mergedConfig.blockLocalhost) {
      const hostname = parsedUrl.hostname.toLowerCase();
      const normalizedHostname = hostname.replace(/^\[|\]$/g, "");

      // Block localhost variants
      if (
        normalizedHostname === "localhost" ||
        normalizedHostname === "127.0.0.1" ||
        normalizedHostname === "0.0.0.0" ||
        normalizedHostname === "::1" ||
        normalizedHostname.endsWith(".localhost") ||
        normalizedHostname.endsWith(".local")
      ) {
        return { valid: false, reason: "Localhost access is blocked" };
      }

      if (REBINDING_HOST_SUFFIXES.some((suffix) =>
        normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`))) {
        return { valid: false, reason: "DNS rebinding host is blocked" };
      }

      // Block private IP ranges
      if (isPrivateIp(normalizedHostname)) {
        return { valid: false, reason: "Private IP range access is blocked" };
      }
    }

    // Check blocked patterns
    for (const pattern of mergedConfig.blockedUrlPatterns) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(url)) {
          return { valid: false, reason: `URL matches blocked pattern: ${pattern}` };
        }
      } catch {
        logger.warn(`Invalid blocked URL pattern: ${pattern}`);
      }
    }

    // Check allowed patterns (if any defined)
    if (mergedConfig.allowedUrlPatterns.length > 0) {
      let matched = false;
      for (const pattern of mergedConfig.allowedUrlPatterns) {
        try {
          const regex = new RegExp(pattern, "i");
          if (regex.test(url)) {
            matched = true;
            break;
          }
        } catch {
          logger.warn(`Invalid allowed URL pattern: ${pattern}`);
        }
      }
      if (!matched) {
        return { valid: false, reason: "URL does not match any allowed pattern" };
      }
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Invalid URL: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Check if an IP address is in a private range.
 * Also detects IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1).
 */
function isPrivateIp(ip: string): boolean {
  let ipToCheck = ip;

  // Handle IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  const v4MappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4MappedMatch) {
    ipToCheck = v4MappedMatch[1]!;
  }

  // IPv4 private ranges
  const privateRanges = [
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^169\.254\./, // Link-local
    /^127\./, // Loopback
    /^0\./, // 0.0.0.0/8
  ];

  for (const range of privateRanges) {
    if (range.test(ipToCheck)) {
      return true;
    }
  }

  // IPv6 loopback and unique local
  if (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80:") ||
    ip.toLowerCase().startsWith("::ffff:")
  ) {
    return true;
  }

  return false;
}

// ---------- Rate Limiter ----------

interface RateLimitEntry {
  timestamps: number[];
}

export class BrowserRateLimiter {
  private readonly maxOperationsPerMinute: number;
  private readonly sessions = new Map<string, RateLimitEntry>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(maxOperationsPerMinute: number = 60) {
    this.maxOperationsPerMinute = maxOperationsPerMinute;
    this.startCleanupInterval();
  }

  /**
   * Check if an operation is allowed for the given session.
   */
  checkLimit(sessionId: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { timestamps: [] };
      this.sessions.set(sessionId, entry);
    }

    // Clean old timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > oneMinuteAgo);

    // Check limit
    if (entry.timestamps.length >= this.maxOperationsPerMinute) {
      const oldest = entry.timestamps[0]!;
      const retryAfterMs = oldest + 60_000 - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    // Record operation
    entry.timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Get current operation count for a session.
   */
  getOperationCount(sessionId: string): number {
    const oneMinuteAgo = Date.now() - 60_000;
    const entry = this.sessions.get(sessionId);
    if (!entry) return 0;
    return entry.timestamps.filter((t) => t > oneMinuteAgo).length;
  }

  /**
   * Reset rate limit for a session.
   */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Dispose of the rate limiter.
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }

  private startCleanupInterval(): void {
    // Clean up empty sessions every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const oneHourAgo = Date.now() - 3_600_000;
      for (const [sessionId, entry] of Array.from(this.sessions.entries())) {
        entry.timestamps = entry.timestamps.filter((t) => t > oneHourAgo);
        if (entry.timestamps.length === 0) {
          this.sessions.delete(sessionId);
        }
      }
    }, 300_000);
    this.cleanupInterval.unref();
  }
}

// ---------- Session Manager ----------

export class BrowserSessionManager {
  private readonly maxConcurrentSessions: number;
  private activeSessions = new Set<string>();
  private readonly logger = getLogger();

  constructor(maxConcurrentSessions: number = 5) {
    this.maxConcurrentSessions = maxConcurrentSessions;
  }

  /**
   * Try to acquire a session slot.
   */
  acquireSession(sessionId: string): boolean {
    if (this.activeSessions.has(sessionId)) {
      return true; // Already acquired
    }

    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      this.logger.warn("Max concurrent browser sessions reached", {
        max: this.maxConcurrentSessions,
        current: this.activeSessions.size,
      });
      return false;
    }

    this.activeSessions.add(sessionId);
    return true;
  }

  /**
   * Release a session slot.
   */
  releaseSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  /**
   * Check if a session is active.
   */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Get current active session count.
   */
  getActiveCount(): number {
    return this.activeSessions.size;
  }
}
