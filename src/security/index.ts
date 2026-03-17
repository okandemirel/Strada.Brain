/**
 * Security Module for Strada.Brain
 *
 * Centralized security exports for all security features.
 */

// =============================================================================
// CORE SECURITY
// =============================================================================

// Authentication
export { AuthManager } from "./auth.js";
export {
  HardenedAuthManager,
  JwtManager,
  MfaManager,
  SessionManager,
  BruteForceProtection,
  PasswordHasher,
  type User,
  type UserRole,
  type Permission,
  type AuthResult,
  type Session,
  type JwtPayload,
  authManager,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  getRolePermissions,
} from "./auth-hardened.js";

// Authorization / RBAC
export {
  RbacManager,
  PolicyEngine,
  AbacEngine,
  rbacManager,
  abacEngine,
  type Resource,
  type ResourceType,
  type Action,
  type AccessContext,
  type AuthorizationResult,
  type Policy,
  type PolicyCondition,
  type AbacAttributes,
} from "./rbac.js";

// Communication Security
export {
  TlsSecurityManager,
  SecureWebSocketManager,
  tlsSecurity,
  wsSecurity,
  type TlsConfig,
  type PinnedCertificate,
  type WebSocketSecurityConfig,
  TLS13_CIPHERS,
  TLS12_CIPHERS,
  FORBIDDEN_CIPHERS,
  extractPublicKeyFingerprint,
  generateCertificatePin,
  validateCertificateChain,
  generateSecureToken,
  hashToken,
  compareTokens,
} from "./communication.js";

// File System Security
export {
  ChrootJail,
  FileIntegrityMonitor,
  FileAuditLogger,
  SecureFileOperations,
  fileAuditLogger,
  fileIntegrityMonitor,
  type ChrootConfig,
  type FileIntegrityRecord,
  type FileBackup,
  type FileOperationAudit,
} from "./filesystem-security.js";

// Origin Validation
export { isAllowedOrigin } from "./origin-validation.js";

// Original Security Modules
export { validatePath, isValidCSharpIdentifier, isValidCSharpType } from "./path-guard.js";
export {
  RateLimiter,
  estimateCost,
  type RateLimitConfig,
  type RateLimitResult,
} from "./rate-limiter.js";
export { sanitizeSecrets, type SecretPattern } from "./secret-sanitizer.js";
export { ReadOnlyGuard } from "./read-only-guard.js";
export { SecretRotationWatcher } from "./secret-rotation.js";
export { DMPolicy, createDMPolicy } from "./dm-policy.js";
export { DMStateManager } from "./dm-state.js";

// =============================================================================
// NETWORK SECURITY
// =============================================================================

export {
  Firewall,
  RateLimiter as NetworkRateLimiter,
  DdosProtection,
  IpUtils,
  firewall,
  rateLimiter,
  ddosProtection,
  type FirewallRule,
  type IpRange,
  type ConnectionInfo,
  type DdosProtectionConfig,
} from "../network/firewall.js";

// =============================================================================
// AUDIT & MONITORING
// =============================================================================

export {
  SecurityAuditLogger,
  AlertManager,
  AnomalyDetector,
  securityAudit,
  alertManager,
  anomalyDetector,
  type SecurityEvent,
  type SecurityEventType,
  type SecuritySeverity,
  type SecurityAlert,
  type AlertRule,
  type AlertChannel,
  type ComplianceReport,
} from "../audit/security-audit.js";

// =============================================================================
// DEPENDENCY SECURITY
// =============================================================================

export {
  DependencySecurityScanner,
  SnykIntegration,
  dependencyScanner,
  type Vulnerability,
  type AuditReport,
  type DependencyInfo,
  type SecurityCheckResult,
  type DependencyUpdate,
} from "./dependency-security.js";

// =============================================================================
// VALIDATION
// =============================================================================

export {
  InputValidator,
  ValidationErrorException,
  ValidationRateLimiter,
  validate,
  validateOrThrow,
  validateAsync,
  getValidator,
  sanitizeInput,
  sanitizeHtml,
  sanitizePath,
  escapeRegex,
  sanitizeString,
  validateFilePath,
  // Schemas
  uuidSchema,
  emailSchema,
  urlSchema,
  safeStringSchema,
  identifierSchema,
  namespaceSchema,
  safePathSchema,
  portSchema,
  ipAddressSchema,
  cidrSchema,
  fileReadSchema,
  fileWriteSchema,
  fileEditSchema,
  fileDeleteSchema,
  fileMoveSchema,
  fileSearchSchema,
  shellCommandSchema,
  apiKeySchema,
  webhookUrlSchema,
  jwtTokenSchema,
  csharpIdentifierSchema,
  csharpNamespaceSchema,
  csharpTypeSchema,
  unityComponentSchema,
  moduleCreateSchema,
  systemCreateSchema,
  telegramMessageSchema,
  discordMessageSchema,
  slackMessageSchema,
  searchQuerySchema,
  ragQuerySchema,
  rateLimitConfigSchema,
  securityConfigSchema,
} from "../validation/index.js";

// =============================================================================
// ENCRYPTION
// =============================================================================

export {
  KeyManager,
  EncryptionService,
  DataMasking,
  TokenizationService,
  keyManager,
  encryptionService,
  tokenizationService,
  encryptEnvValue,
  decryptEnvValue,
  type EncryptedData,
  type DataEncryptionKey,
  type KeyRotationPolicy,
  type MaskingOptions,
  type TokenMapping,
} from "../encryption/data-protection.js";

// =============================================================================
// SECURITY INITIALIZATION
// =============================================================================

import { getLogger } from "../utils/logger.js";
import { securityAudit } from "../audit/security-audit.js";
import { alertManager } from "../audit/security-audit.js";

const logger = getLogger();

/**
 * Initialize all security modules
 */
export function initializeSecurity(): void {
  logger.info("Initializing security modules...");

  // Initialize default alert rules
  alertManager.addRule({
    name: "Multiple Authentication Failures",
    enabled: true,
    conditions: [{ field: "type", operator: "equals", value: "authentication_failure" }],
    severity: "high",
    channels: ["console"],
    throttleMs: 60000,
  });

  alertManager.addRule({
    name: "Suspicious Activity Detected",
    enabled: true,
    conditions: [{ field: "type", operator: "equals", value: "suspicious_activity" }],
    severity: "critical",
    channels: ["console", "email"],
    throttleMs: 300000,
  });

  alertManager.addRule({
    name: "High Severity Security Events",
    enabled: true,
    conditions: [{ field: "severity", operator: "equals", value: "critical" }],
    severity: "critical",
    channels: ["console", "email"],
  });

  logger.info("Security modules initialized");
}

/**
 * Security middleware for Express/Fastify
 */
export function createSecurityMiddleware() {
  return {
    // Request security headers
    securityHeaders: {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    },

    // Request validation
    validateRequest: (req: { headers: Record<string, string>; ip?: string }) => {
      // Check for required headers
      if (!req.headers["content-type"] && req.headers["content-length"]) {
        return { valid: false, error: "Missing content-type header" };
      }

      return { valid: true };
    },

    // Log security event
    logEvent: (event: Parameters<typeof securityAudit.log>[0]) => {
      const loggedEvent = securityAudit.log(event);
      alertManager.processEvent(loggedEvent);
      return loggedEvent;
    },
  };
}

// =============================================================================
// SECURITY UTILITIES
// =============================================================================

/**
 * Generate a secure random ID
 */
export function generateSecureId(length = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);

  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i]! % chars.length];
  }

  return result;
}

/**
 * Constant time comparison
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Sanitize log output
 */
export function sanitizeLogOutput(data: unknown): unknown {
  if (typeof data !== "object" || data === null) {
    return data;
  }

  const sensitiveKeys = [
    "password",
    "token",
    "secret",
    "key",
    "apiKey",
    "auth",
    "credential",
    "credit_card",
    "ssn",
  ];

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeLogOutput(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
