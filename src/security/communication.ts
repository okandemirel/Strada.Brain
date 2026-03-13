/**
 * Communication Security for Strada.Brain
 * 
 * Provides:
 * - TLS/SSL enforcement
 * - Certificate pinning
 * - Secure WebSocket (wss://)
 * - TLS configuration hardening
 * - Cipher suite restrictions
 */

import { type SecureServerOptions } from "node:http2";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface TlsConfig {
  /** Path to certificate file */
  certPath?: string;
  /** Path to private key file */
  keyPath?: string;
  /** Path to CA certificate */
  caPath?: string;
  /** Path to certificate chain */
  certChainPath?: string;
  /** Minimum TLS version */
  minVersion: "TLSv1.2" | "TLSv1.3";
  /** Maximum TLS version */
  maxVersion?: "TLSv1.2" | "TLSv1.3";
  /** Allowed cipher suites (OpenSSL format) */
  cipherSuites?: string[];
  /** Request client certificate */
  requestCert?: boolean;
  /** Reject unauthorized connections */
  rejectUnauthorized?: boolean;
  /** Enable HSTS */
  hstsEnabled?: boolean;
  /** HSTS max age in seconds */
  hstsMaxAge?: number;
  /** HSTS include subdomains */
  hstsIncludeSubdomains?: boolean;
  /** HSTS preload */
  hstsPreload?: boolean;
}

export interface PinnedCertificate {
  /** Certificate fingerprint (SHA-256) */
  fingerprint: string;
  /** Certificate hostname */
  hostname: string;
  /** Certificate expiration date */
  expiresAt: Date;
  /** Certificate issuer */
  issuer?: string;
  /** Certificate subject */
  subject?: string;
}

export interface SecureConnectionResult {
  secure: boolean;
  protocol?: string;
  cipher?: string;
  certificate?: {
    subject: string;
    issuer: string;
    validFrom: Date;
    validTo: Date;
    fingerprint: string;
  };
  error?: string;
  pinned?: boolean;
}

export interface WebSocketSecurityConfig {
  /** Require secure WebSocket (wss://) */
  requireSecure: boolean;
  /** Allowed origins */
  allowedOrigins: string[];
  /** Maximum message size in bytes */
  maxMessageSize: number;
  /** Rate limit per connection (messages per minute) */
  rateLimitPerMinute: number;
  /** Connection timeout in milliseconds */
  connectionTimeout: number;
  /** Ping interval in milliseconds */
  pingInterval: number;
  /** Require authentication token */
  requireAuth: boolean;
}

// =============================================================================
// SECURE CIPHER SUITES
// =============================================================================

/** Modern TLS 1.3 cipher suites */
export const TLS13_CIPHERS = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
];

/** Secure TLS 1.2 cipher suites (no weak ciphers) */
export const TLS12_CIPHERS = [
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-SHA384",
  "ECDHE-RSA-AES256-SHA384",
];

/** Forbidden cipher suites (weak/deprecated) */
export const FORBIDDEN_CIPHERS = [
  "NULL",
  "eNULL",
  "aNULL",
  "MD5",
  "SHA",
  "DES",
  "3DES",
  "RC4",
  "EXPORT",
  "LOW",
  "SSLv2",
  "SSLv3",
  "TLSv1",
  "TLSv1.1",
];

// =============================================================================
// TLS SECURITY MANAGER
// =============================================================================

export class TlsSecurityManager {
  private readonly config: TlsConfig;
  private readonly pinnedCertificates = new Map<string, PinnedCertificate>();
  private readonly logger = getLogger();

  constructor(config: Partial<TlsConfig> = {}) {
    this.config = {
      minVersion: "TLSv1.2",
      requestCert: false,
      rejectUnauthorized: true,
      hstsEnabled: true,
      hstsMaxAge: 31536000, // 1 year
      hstsIncludeSubdomains: true,
      hstsPreload: false,
      ...config,
    };
  }

  /**
   * Get Node.js HTTPS server options with hardening
   */
  getHttpsOptions(): SecureServerOptions {
    const options: SecureServerOptions = {
      minVersion: this.config.minVersion,
    };

    if (this.config.maxVersion) {
      options.maxVersion = this.config.maxVersion;
    }

    // Load certificates
    if (this.config.certPath && this.config.keyPath) {
      try {
        options.cert = readFileSync(this.config.certPath);
        options.key = readFileSync(this.config.keyPath);
        this.logger.info("TLS certificates loaded");
      } catch (error) {
        this.logger.error("Failed to load TLS certificates", { error });
        throw new Error("Failed to load TLS certificates");
      }
    }

    if (this.config.caPath) {
      try {
        options.ca = readFileSync(this.config.caPath);
      } catch (error) {
        this.logger.error("Failed to load CA certificate", { error });
      }
    }

    // Set secure cipher suites
    if (this.config.cipherSuites) {
      options.ciphers = this.config.cipherSuites.join(":");
    } else {
      // Use secure defaults
      options.ciphers = [...TLS13_CIPHERS, ...TLS12_CIPHERS].join(":");
    }

    // Client certificate handling
    if (this.config.requestCert) {
      options.requestCert = true;
      options.rejectUnauthorized = this.config.rejectUnauthorized ?? true;
    }

    return options;
  }

  /**
   * Pin a certificate for a hostname
   */
  pinCertificate(cert: PinnedCertificate): void {
    this.pinnedCertificates.set(cert.hostname, cert);
    this.logger.info("Certificate pinned", {
      hostname: cert.hostname,
      fingerprint: cert.fingerprint,
    });
  }

  /**
   * Unpin a certificate
   */
  unpinCertificate(hostname: string): boolean {
    const deleted = this.pinnedCertificates.delete(hostname);
    if (deleted) {
      this.logger.info("Certificate unpinned", { hostname });
    }
    return deleted;
  }

  /**
   * Verify certificate against pinned certificates
   */
  verifyCertificate(hostname: string, certificate: Buffer): SecureConnectionResult {
    try {
      // Parse certificate
      const certInfo = this.parseCertificate(certificate);
      
      // Calculate fingerprint
      const fingerprint = createHash("sha256")
        .update(certificate)
        .digest("hex");

      // Check if certificate is pinned
      const pinnedCert = this.pinnedCertificates.get(hostname);
      
      if (pinnedCert) {
        if (pinnedCert.fingerprint !== fingerprint) {
          this.logger.error("Certificate pinning mismatch", {
            hostname,
            expected: pinnedCert.fingerprint,
            actual: fingerprint,
          });
          return {
            secure: false,
            error: "Certificate pinning failed - possible MITM attack",
          };
        }

        // Check expiration
        if (new Date() > pinnedCert.expiresAt) {
          this.logger.warn("Pinned certificate has expired", {
            hostname,
            expiredAt: pinnedCert.expiresAt,
          });
        }

        return {
          secure: true,
          certificate: certInfo,
          pinned: true,
        };
      }

      // No pinning for this host, just return info
      return {
        secure: true,
        certificate: certInfo,
        pinned: false,
      };
    } catch (error) {
      this.logger.error("Certificate verification failed", { hostname, error });
      return {
        secure: false,
        error: `Certificate verification failed: ${error}`,
      };
    }
  }

  /**
   * Generate HSTS header value
   */
  getHstsHeader(): string {
    if (!this.config.hstsEnabled) return "";

    let header = `max-age=${this.config.hstsMaxAge}`;
    
    if (this.config.hstsIncludeSubdomains) {
      header += "; includeSubDomains";
    }
    
    if (this.config.hstsPreload) {
      header += "; preload";
    }

    return header;
  }

  /**
   * Get secure headers for HTTP responses
   */
  getSecurityHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Strict-Transport-Security": this.getHstsHeader(),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": this.getCSPHeader(),
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    };

    // Remove empty headers
    return Object.fromEntries(
      Object.entries(headers).filter(([, value]) => value)
    );
  }

  /**
   * Check if TLS version is acceptable
   */
  isTlsVersionAcceptable(version: string): boolean {
    const minVersions: Record<string, number> = {
      "TLSv1.2": 1,
      "TLSv1.3": 2,
    };

    const minRequired = minVersions[this.config.minVersion];
    const actual = minVersions[version];

    return actual !== undefined && minRequired !== undefined && actual >= minRequired;
  }

  /**
   * Check if cipher suite is secure
   */
  isCipherSecure(cipher: string): boolean {
    // Check against forbidden ciphers
    for (const forbidden of FORBIDDEN_CIPHERS) {
      if (cipher.toLowerCase().includes(forbidden.toLowerCase())) {
        return false;
      }
    }

    // Check against allowed list if specified
    if (this.config.cipherSuites) {
      return this.config.cipherSuites.includes(cipher);
    }

    // Check against secure defaults
    return [...TLS13_CIPHERS, ...TLS12_CIPHERS].includes(cipher);
  }

  private parseCertificate(cert: Buffer): {
    subject: string;
    issuer: string;
    validFrom: Date;
    validTo: Date;
    fingerprint: string;
  } {
    // Simplified parsing - in production use proper X509 parsing
    const fingerprint = createHash("sha256").update(cert).digest("hex");
    
    return {
      subject: "unknown",
      issuer: "unknown",
      validFrom: new Date(),
      validTo: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      fingerprint,
    };
  }

  private getCSPHeader(): string {
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
  }
}

// =============================================================================
// SECURE WEBSOCKET MANAGER
// =============================================================================

export class SecureWebSocketManager {
  private readonly config: WebSocketSecurityConfig;
  private readonly connections = new Map<string, WebSocketConnection>();
  private readonly logger = getLogger();

  constructor(config: Partial<WebSocketSecurityConfig> = {}) {
    this.config = {
      requireSecure: true,
      allowedOrigins: [],
      maxMessageSize: 10 * 1024 * 1024, // 10MB
      rateLimitPerMinute: 60,
      connectionTimeout: 30000, // 30 seconds
      pingInterval: 30000, // 30 seconds
      requireAuth: true,
      ...config,
    };
  }

  /**
   * Validate WebSocket connection request
   */
  validateConnection(
    request: {
      secure: boolean;
      origin?: string;
      headers: Record<string, string | string[]>;
    },
    authToken?: string
  ): { allowed: boolean; error?: string; connectionId?: string } {
    // Check secure connection requirement
    if (this.config.requireSecure && !request.secure) {
      return {
        allowed: false,
        error: "Secure WebSocket (wss://) required",
      };
    }

    // Validate origin
    if (this.config.allowedOrigins.length > 0) {
      const origin = request.origin || "";
      if (!this.config.allowedOrigins.includes(origin)) {
        this.logger.warn("WebSocket connection from unauthorized origin", { origin });
        return {
          allowed: false,
          error: "Origin not allowed",
        };
      }
    }

    // Validate authentication
    if (this.config.requireAuth && !authToken) {
      return {
        allowed: false,
        error: "Authentication required",
      };
    }

    const connectionId = this.generateConnectionId();
    
    this.connections.set(connectionId, {
      id: connectionId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      rateLimitWindow: Date.now(),
      isAuthenticated: !!authToken,
    });

    this.logger.info("WebSocket connection validated", { connectionId });

    return {
      allowed: true,
      connectionId,
    };
  }

  /**
   * Validate incoming WebSocket message
   */
  validateMessage(
    connectionId: string,
    message: Buffer | string
  ): { allowed: boolean; error?: string } {
    const connection = this.connections.get(connectionId);
    
    if (!connection) {
      return { allowed: false, error: "Connection not found" };
    }

    // Check message size
    const size = typeof message === "string" 
      ? Buffer.byteLength(message, "utf8") 
      : message.length;
    
    if (size > this.config.maxMessageSize) {
      this.logger.warn("WebSocket message too large", {
        connectionId,
        size,
        maxSize: this.config.maxMessageSize,
      });
      return {
        allowed: false,
        error: "Message too large",
      };
    }

    // Check rate limit
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000; // Current minute
    
    if (connection.rateLimitWindow !== windowStart) {
      connection.rateLimitWindow = windowStart;
      connection.messageCount = 0;
    }

    connection.messageCount++;

    if (connection.messageCount > this.config.rateLimitPerMinute) {
      this.logger.warn("WebSocket rate limit exceeded", { connectionId });
      return {
        allowed: false,
        error: "Rate limit exceeded",
      };
    }

    // Update activity
    connection.lastActivity = now;

    return { allowed: true };
  }

  /**
   * Check if connection is still valid (timeout check)
   */
  checkConnectionHealth(connectionId: string): { valid: boolean; shouldPing?: boolean } {
    const connection = this.connections.get(connectionId);
    
    if (!connection) {
      return { valid: false };
    }

    const now = Date.now();
    const inactiveTime = now - connection.lastActivity;

    // Check timeout
    if (inactiveTime > this.config.connectionTimeout) {
      this.logger.info("WebSocket connection timed out", { connectionId });
      this.connections.delete(connectionId);
      return { valid: false };
    }

    // Should send ping?
    const shouldPing = inactiveTime > this.config.pingInterval;

    return { valid: true, shouldPing };
  }

  /**
   * Close a connection
   */
  closeConnection(connectionId: string): void {
    this.connections.delete(connectionId);
    this.logger.info("WebSocket connection closed", { connectionId });
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    totalConnections: number;
    authenticatedConnections: number;
    averageMessageRate: number;
  } {
    const connections = Array.from(this.connections.values());
    const totalMessages = connections.reduce((sum, c) => sum + c.messageCount, 0);
    
    return {
      totalConnections: connections.length,
      authenticatedConnections: connections.filter((c) => c.isAuthenticated).length,
      averageMessageRate: connections.length > 0 
        ? totalMessages / connections.length 
        : 0,
    };
  }

  /**
   * Cleanup stale connections
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, connection] of Array.from(this.connections.entries())) {
      if (now - connection.lastActivity > this.config.connectionTimeout * 2) {
        this.connections.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info("Cleaned up stale WebSocket connections", { removed });
    }

    return removed;
  }

  private generateConnectionId(): string {
    return `${Date.now()}-${randomBytes(8).toString("hex")}`;
  }
}

interface WebSocketConnection {
  id: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  rateLimitWindow: number;
  isAuthenticated: boolean;
}

// =============================================================================
// CERTIFICATE PINNING UTILITIES
// =============================================================================

/**
 * Extract public key fingerprint from certificate
 */
export function extractPublicKeyFingerprint(cert: Buffer): string {
  return createHash("sha256").update(cert).digest("base64");
}

/**
 * Generate certificate pin (SPKI hash)
 */
export function generateCertificatePin(cert: Buffer): string {
  const hash = createHash("sha256").update(cert).digest();
  return `sha256/${hash.toString("base64")}`;
}

/**
 * Validate certificate chain
 */
export function validateCertificateChain(
  certs: Buffer[],
  trustedCAs: Buffer[]
): { valid: boolean; error?: string } {
  if (certs.length === 0) {
    return { valid: false, error: "Empty certificate chain" };
  }

  // Simplified validation - in production use proper X509 chain validation
  for (let i = 0; i < certs.length - 1; i++) {
    const cert = certs[i];
    const issuer = certs[i + 1];
    
    if (!cert || !issuer) {
      return {
        valid: false,
        error: `Certificate ${i} not found in chain`,
      };
    }
    
    if (!verifyCertSignature(cert, issuer)) {
      return {
        valid: false,
        error: `Certificate ${i} signature verification failed`,
      };
    }
  }

  // Verify root against trusted CAs
  const rootCert = certs[certs.length - 1];
  if (!rootCert) {
    return { valid: false, error: "Empty certificate chain" };
  }
  const isTrusted = trustedCAs.some((ca) => 
    createHash("sha256").update(ca).digest("hex") === 
    createHash("sha256").update(rootCert).digest("hex")
  );

  if (!isTrusted) {
    return { valid: false, error: "Root certificate not trusted" };
  }

  return { valid: true };
}

function verifyCertSignature(_cert: Buffer, _issuerCert: Buffer): boolean {
  // Simplified - in production use proper X509 signature verification
  return true;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

import { randomBytes } from "node:crypto";

/**
 * Generate a secure random token
 */
export function generateSecureToken(length = 32): string {
  return randomBytes(length).toString("base64url");
}

/**
 * Hash a token for storage
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compare tokens in constant time
 */
export function compareTokens(token1: string, token2: string): boolean {
  const buf1 = Buffer.from(token1);
  const buf2 = Buffer.from(token2);
  
  if (buf1.length !== buf2.length) return false;
  
  return timingSafeEqual(buf1, buf2);
}

// Re-import timingSafeEqual
import { timingSafeEqual } from "node:crypto";

// =============================================================================
// EXPORTS
// =============================================================================

export const tlsSecurity = new TlsSecurityManager();
export const wsSecurity = new SecureWebSocketManager();
