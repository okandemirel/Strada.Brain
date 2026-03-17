/**
 * Hardened Authentication Module for Strada.Brain
 *
 * Provides:
 * - Multi-factor authentication (MFA)
 * - JWT implementation with secure defaults
 * - Session management with timeout
 * - Brute-force protection
 * - Token refresh mechanism
 * - Secure password hashing
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  permissions: Permission[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  passwordHash?: string;
  failedLoginAttempts: number;
  lockedUntil?: number;
  lastLoginAt?: number;
  createdAt: number;
}

export type UserRole = "superadmin" | "admin" | "developer" | "viewer" | "service";

export type Permission =
  | "system:full"
  | "system:read"
  | "system:write"
  | "files:read"
  | "files:write"
  | "files:delete"
  | "shell:execute"
  | "config:read"
  | "config:write"
  | "users:manage"
  | "audit:read"
  | "agents:manage";

export interface JwtPayload {
  sub: string; // User ID
  username: string;
  role: UserRole;
  permissions: Permission[];
  iat: number; // Issued at
  exp: number; // Expiration
  jti: string; // JWT ID (for revocation)
  iss: string; // Issuer
  aud: string; // Audience
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  refreshToken: string;
  createdAt: number;
  expiresAt: number;
  refreshExpiresAt: number;
  lastActivityAt: number;
  ipAddress: string;
  userAgent: string;
  isValid: boolean;
}

export interface AuthResult {
  success: boolean;
  user?: User;
  session?: Session;
  tokens?: { accessToken: string; refreshToken: string };
  requiresMfa?: boolean;
  mfaToken?: string;
  error?: string;
  retryAfter?: number;
}

export interface MfaVerifyResult {
  success: boolean;
  error?: string;
  remainingAttempts?: number;
}

export interface RegisterUserOptions {
  allowPrivilegedRoleAssignment?: boolean;
}

// =============================================================================
// PERMISSION MATRIX
// =============================================================================

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  superadmin: ["system:full"],
  admin: [
    "system:read",
    "system:write",
    "files:read",
    "files:write",
    "files:delete",
    "shell:execute",
    "config:read",
    "config:write",
    "users:manage",
    "audit:read",
    "agents:manage",
  ],
  developer: [
    "system:read",
    "files:read",
    "files:write",
    "shell:execute",
    "config:read",
    "agents:manage",
  ],
  viewer: ["system:read", "files:read", "config:read"],
  service: ["system:read", "files:read", "config:read"],
};

const SELF_REGISTERABLE_ROLES = new Set<UserRole>(["viewer"]);

// =============================================================================
// CONFIGURATION
// =============================================================================

interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: number; // seconds
  jwtRefreshExpiresIn: number; // seconds
  sessionTimeout: number; // milliseconds
  maxLoginAttempts: number;
  lockoutDuration: number; // milliseconds
  issuer: string;
  audience: string;
  requireMfa: boolean;
  passwordMinLength: number;
  bcryptRounds?: number;
}

const DEFAULT_CONFIG: AuthConfig = {
  jwtSecret: process.env["JWT_SECRET"] ?? "",
  jwtExpiresIn: 15 * 60, // 15 minutes
  jwtRefreshExpiresIn: 7 * 24 * 60 * 60, // 7 days
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
  maxLoginAttempts: 5,
  lockoutDuration: 30 * 60 * 1000, // 30 minutes
  issuer: "strada-brain",
  audience: "strada-brain-api",
  requireMfa: process.env["REQUIRE_MFA"] === "true",
  passwordMinLength: 12,
};

const TOTP_STEP_SECONDS = 30;
const TOTP_WINDOW_STEPS = 1;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(secret: string): Buffer | null {
  const normalized = secret.replace(/[\s=-]/g, "").toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    return null;
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) {
      return null;
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTotpCode(secret: string, timestampMs: number): string | null {
  const secretBytes = decodeBase32(secret);
  if (!secretBytes || secretBytes.length === 0) {
    return null;
  }

  const counter = Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secretBytes).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0");
}

// =============================================================================
// PASSWORD HASHING (Argon2-like with crypto)
// =============================================================================

export class PasswordHasher {
  private readonly saltLength = 32;

  /**
   * Hash a password with salt using scrypt
   */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(this.saltLength);
    const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
  }

  /**
   * Verify a password against a hash
   */
  async verify(password: string, storedHash: string): Promise<boolean> {
    const [algo, saltHex, hashHex] = storedHash.split(":");
    if (algo !== "scrypt" || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, "hex");
    const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(derived, Buffer.from(hashHex, "hex"));
  }
}

// =============================================================================
// JWT IMPLEMENTATION
// =============================================================================

export class JwtManager {
  private readonly config: AuthConfig;
  private readonly revokedTokens = new Map<string, number>(); // jti -> expiresAt
  private readonly logger = getLogger();

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private requireSecret(): string {
    if (!this.config.jwtSecret) {
      throw new Error(
        "JWT_SECRET environment variable is required. Set it before using authentication.",
      );
    }
    return this.config.jwtSecret;
  }

  /**
   * Generate JWT access token
   */
  generateToken(user: User): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions,
      iat: now,
      exp: now + this.config.jwtExpiresIn,
      jti: randomBytes(16).toString("hex"),
      iss: this.config.issuer,
      aud: this.config.audience,
    };

    // Simple JWT implementation (header.payload.signature)
    const header = { alg: "HS256", typ: "JWT" };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const secret = this.requireSecret();
    const signature = createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");

    return `${headerB64}.${payloadB64}.${signature}`;
  }

  /**
   * Verify JWT token
   */
  verifyToken(token: string): { valid: boolean; payload?: JwtPayload; error?: string } {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return { valid: false, error: "Invalid token format" };
      }

      const [headerB64, payloadB64, signature] = parts;
      if (!signature || !payloadB64) {
        return { valid: false, error: "Invalid token format" };
      }

      // Verify signature
      const secret = this.requireSecret();
      const expectedSignature = createHmac("sha256", secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest("base64url");

      const sigBuf = Buffer.from(signature, "base64url");
      const expSigBuf = Buffer.from(expectedSignature, "base64url");
      if (sigBuf.length !== expSigBuf.length) {
        return { valid: false, error: "Invalid signature" };
      }
      if (!timingSafeEqual(sigBuf, expSigBuf)) {
        return { valid: false, error: "Invalid signature" };
      }

      // Parse payload
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as JwtPayload;

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        return { valid: false, error: "Token expired" };
      }

      // Check issuer and audience
      if (payload.iss !== this.config.issuer) {
        return { valid: false, error: "Invalid issuer" };
      }
      if (payload.aud !== this.config.audience) {
        return { valid: false, error: "Invalid audience" };
      }

      // Check revocation
      if (this.revokedTokens.has(payload.jti)) {
        return { valid: false, error: "Token revoked" };
      }

      return { valid: true, payload };
    } catch (_error) {
      return { valid: false, error: "Token verification failed" };
    }
  }

  /**
   * Generate refresh token
   */
  generateRefreshToken(): string {
    return randomBytes(32).toString("hex");
  }

  /**
   * Revoke a token
   */
  revokeToken(jti: string, expiresAt?: number): void {
    this.revokedTokens.set(jti, expiresAt ?? Date.now() + this.config.jwtExpiresIn * 1000);
    this.logger.info("Token revoked", { jti });
  }

  /**
   * Clean up expired revoked tokens (time-based, not full clear)
   */
  cleanupRevokedTokens(): void {
    const now = Date.now();
    for (const [jti, expiresAt] of this.revokedTokens) {
      if (now > expiresAt) this.revokedTokens.delete(jti);
    }
  }
}

// =============================================================================
// MFA MANAGER
// =============================================================================

export class MfaManager {
  private readonly backupCodes = new Map<string, Set<string>>();
  private readonly verifyAttempts = new Map<string, { count: number; resetTime: number }>();
  private readonly maxAttempts = 5;
  private readonly windowMs = 5 * 60 * 1000; // 5 minutes

  /**
   * Generate a base32 TOTP secret compatible with authenticator apps.
   */
  generateSecret(): string {
    return encodeBase32(randomBytes(20));
  }

  /**
   * Generate backup codes
   */
  generateBackupCodes(userId: string): string[] {
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push(randomBytes(4).toString("hex").toUpperCase());
    }
    this.backupCodes.set(userId, new Set(codes));
    return codes;
  }

  /**
   * Verify a 6-digit TOTP code using RFC 6238 semantics with a small clock skew window.
   */
  verifyTotp(secret: string, code: string): boolean {
    const normalizedCode = code.trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
      return false;
    }

    const candidate = Buffer.from(normalizedCode, "utf8");
    const now = Date.now();

    for (let stepOffset = -TOTP_WINDOW_STEPS; stepOffset <= TOTP_WINDOW_STEPS; stepOffset++) {
      const generated = generateTotpCode(secret, now + stepOffset * TOTP_STEP_SECONDS * 1000);
      if (!generated) {
        return false;
      }

      const expected = Buffer.from(generated, "utf8");
      if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Verify MFA code with rate limiting
   */
  verifyMfa(userId: string, secret: string, code: string): MfaVerifyResult {
    // Check rate limit
    const attempts = this.verifyAttempts.get(userId);
    const now = Date.now();

    if (attempts && now < attempts.resetTime && attempts.count >= this.maxAttempts) {
      return {
        success: false,
        error: "Too many attempts. Please try again later.",
        remainingAttempts: 0,
      };
    }

    // Check backup code
    const backupCodes = this.backupCodes.get(userId);
    if (backupCodes?.has(code)) {
      backupCodes.delete(code); // One-time use
      this.resetAttempts(userId);
      return { success: true };
    }

    const isValid = this.verifyTotp(secret, code);

    if (!isValid) {
      const currentAttempts = attempts || { count: 0, resetTime: now + this.windowMs };
      currentAttempts.count++;
      this.verifyAttempts.set(userId, currentAttempts);

      return {
        success: false,
        error: "Invalid code",
        remainingAttempts: this.maxAttempts - currentAttempts.count,
      };
    }

    this.resetAttempts(userId);
    return { success: true };
  }

  private resetAttempts(userId: string): void {
    this.verifyAttempts.delete(userId);
  }
}

// =============================================================================
// SESSION MANAGER
// =============================================================================

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly userSessions = new Map<string, Set<string>>();
  private readonly config: AuthConfig;
  private readonly logger = getLogger();

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a new session
   */
  createSession(
    user: User,
    token: string,
    refreshToken: string,
    ipAddress: string,
    userAgent: string,
  ): Session {
    const now = Date.now();
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      userId: user.id,
      token,
      refreshToken,
      createdAt: now,
      expiresAt: now + this.config.sessionTimeout,
      refreshExpiresAt: now + this.config.jwtRefreshExpiresIn * 1000,
      lastActivityAt: now,
      ipAddress,
      userAgent,
      isValid: true,
    };

    this.sessions.set(session.id, session);

    const userSessionIds = this.userSessions.get(user.id) || new Set();
    userSessionIds.add(session.id);
    this.userSessions.set(user.id, userSessionIds);

    this.logger.info("Session created", {
      sessionId: session.id,
      userId: user.id,
      ipAddress,
    });

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Validate and update session activity
   */
  validateSession(sessionId: string): { valid: boolean; session?: Session; error?: string } {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return { valid: false, error: "Session not found" };
    }

    if (!session.isValid) {
      return { valid: false, error: "Session invalidated" };
    }

    const now = Date.now();

    if (now > session.expiresAt) {
      this.invalidateSession(sessionId);
      return { valid: false, error: "Session expired" };
    }

    // Update last activity
    session.lastActivityAt = now;
    session.expiresAt = now + this.config.sessionTimeout;

    return { valid: true, session };
  }

  /**
   * Invalidate a session
   */
  invalidateSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isValid = false;

      const userSessionIds = this.userSessions.get(session.userId);
      if (userSessionIds) {
        userSessionIds.delete(sessionId);
        if (userSessionIds.size === 0) this.userSessions.delete(session.userId);
      }

      this.sessions.delete(sessionId);
      this.logger.info("Session invalidated", { sessionId, userId: session.userId });
    }
  }

  /**
   * Invalidate all sessions for a user
   */
  invalidateUserSessions(userId: string): number {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return 0;

    let count = 0;
    for (const sessionId of Array.from(sessionIds)) {
      this.invalidateSession(sessionId);
      count++;
    }

    this.userSessions.delete(userId);
    return count;
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    let count = 0;

    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (now > session.expiresAt || !session.isValid) {
        this.sessions.delete(sessionId);
        const userSet = this.userSessions.get(session.userId);
        if (userSet) {
          userSet.delete(sessionId);
          if (userSet.size === 0) this.userSessions.delete(session.userId);
        }
        count++;
      }
    }

    return count;
  }

  /**
   * Get active sessions for a user
   */
  getUserSessions(userId: string): Session[] {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined && s.isValid);
  }
}

// =============================================================================
// BRUTE FORCE PROTECTION
// =============================================================================

export class BruteForceProtection {
  private readonly attempts = new Map<string, { count: number; lockUntil: number }>();
  private readonly maxAttempts: number;
  private readonly lockoutDuration: number;

  constructor(maxAttempts = 5, lockoutDuration = 30 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.lockoutDuration = lockoutDuration;
  }

  /**
   * Check if login is allowed
   */
  canAttempt(key: string): { allowed: boolean; retryAfter?: number } {
    const record = this.attempts.get(key);
    const now = Date.now();

    if (!record) {
      return { allowed: true };
    }

    if (record.lockUntil > 0 && now < record.lockUntil) {
      return {
        allowed: false,
        retryAfter: Math.ceil((record.lockUntil - now) / 1000),
      };
    }

    // Evict only if a lock actually existed and expired (not pre-lockout accumulation)
    if (record.lockUntil > 0) {
      this.attempts.delete(key);
    }
    return { allowed: true };
  }

  /**
   * Record failed attempt with escalating lockout
   */
  recordFailure(key: string): void {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record) {
      this.attempts.set(key, { count: 1, lockUntil: 0 });
    } else {
      record.count++;
      if (record.count >= this.maxAttempts) {
        const escalation = Math.min(
          Math.pow(2, Math.floor(record.count / this.maxAttempts) - 1),
          32,
        );
        record.lockUntil = now + this.lockoutDuration * escalation;
      }
    }
  }

  /**
   * Record successful login
   */
  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Reset attempts for a key
   */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Get current attempt count
   */
  getAttemptCount(key: string): number {
    return this.attempts.get(key)?.count || 0;
  }
}

// =============================================================================
// MAIN AUTHENTICATION MANAGER
// =============================================================================

export class HardenedAuthManager {
  private readonly users = new Map<string, User>();
  private readonly sessions: SessionManager;
  private readonly jwt: JwtManager;
  private readonly mfa: MfaManager;
  private readonly bruteForce: BruteForceProtection;
  private readonly passwordHasher: PasswordHasher;
  private readonly config: AuthConfig;
  private readonly logger = getLogger();

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessions = new SessionManager(config);
    this.jwt = new JwtManager(config);
    this.mfa = new MfaManager();
    this.bruteForce = new BruteForceProtection(
      this.config.maxLoginAttempts,
      this.config.lockoutDuration,
    );
    this.passwordHasher = new PasswordHasher();
  }

  /**
   * Register a new user
   */
  async registerUser(
    username: string,
    email: string,
    password: string,
    role: UserRole = "viewer",
    options: RegisterUserOptions = {},
  ): Promise<{ success: boolean; user?: User; error?: string }> {
    // Validate password
    if (password.length < this.config.passwordMinLength) {
      return {
        success: false,
        error: `Password must be at least ${this.config.passwordMinLength} characters`,
      };
    }

    // Check if user exists
    const existingUser = Array.from(this.users.values()).find(
      (u) => u.username === username || u.email === email,
    );

    if (existingUser) {
      return { success: false, error: "User already exists" };
    }

    if (!SELF_REGISTERABLE_ROLES.has(role) && !options.allowPrivilegedRoleAssignment) {
      this.logger.warn("Rejected privileged role assignment during registration", {
        username,
        email,
        requestedRole: role,
      });
      return {
        success: false,
        error: "Privileged role assignment requires explicit approval",
      };
    }

    // Create user
    const user: User = {
      id: randomBytes(16).toString("hex"),
      username,
      email,
      role,
      permissions: ROLE_PERMISSIONS[role],
      mfaEnabled: false,
      passwordHash: await this.passwordHasher.hash(password),
      failedLoginAttempts: 0,
      createdAt: Date.now(),
    };

    this.users.set(user.id, user);
    this.logger.info("User registered", { userId: user.id, username, role });

    return { success: true, user };
  }

  /**
   * Authenticate user with brute-force protection
   */
  async authenticate(
    username: string,
    password: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<AuthResult> {
    const bruteKey = `${ipAddress}:${username}`;
    const bruteCheck = this.bruteForce.canAttempt(bruteKey);

    if (!bruteCheck.allowed) {
      this.logger.warn("Brute force protection triggered", {
        username,
        ipAddress,
        retryAfter: bruteCheck.retryAfter,
      });
      return {
        success: false,
        error: "Too many failed attempts",
        retryAfter: bruteCheck.retryAfter,
      };
    }

    const user = Array.from(this.users.values()).find((u) => u.username === username);

    if (!user || !user.passwordHash) {
      this.bruteForce.recordFailure(bruteKey);
      return { success: false, error: "Invalid credentials" };
    }

    // Check if user is locked
    if (user.lockedUntil && Date.now() < user.lockedUntil) {
      return {
        success: false,
        error: "Account locked",
        retryAfter: Math.ceil((user.lockedUntil - Date.now()) / 1000),
      };
    }

    // Verify password
    const passwordValid = await this.passwordHasher.verify(password, user.passwordHash);

    if (!passwordValid) {
      this.bruteForce.recordFailure(bruteKey);
      user.failedLoginAttempts++;

      if (user.failedLoginAttempts >= this.config.maxLoginAttempts) {
        user.lockedUntil = Date.now() + this.config.lockoutDuration;
        this.logger.warn("User account locked", { userId: user.id, username });
      }

      return { success: false, error: "Invalid credentials" };
    }

    // Reset failed attempts
    this.bruteForce.recordSuccess(bruteKey);
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = Date.now();

    // Check if MFA required
    if (this.config.requireMfa || user.mfaEnabled) {
      const mfaToken = this.jwt.generateToken({
        ...user,
        permissions: [] as Permission[], // No permissions until MFA verified
      });

      return {
        success: false, // Not fully authenticated yet
        requiresMfa: true,
        mfaToken,
        user: { id: user.id, username: user.username, email: user.email, role: user.role } as User,
      };
    }

    // Create session and tokens
    return this.createAuthenticatedSession(user, ipAddress, userAgent);
  }

  /**
   * Verify MFA and complete authentication
   */
  verifyMfaAndAuthenticate(
    mfaToken: string,
    code: string,
    ipAddress: string,
    userAgent: string,
  ): AuthResult {
    const tokenResult = this.jwt.verifyToken(mfaToken);

    if (!tokenResult.valid || !tokenResult.payload) {
      return { success: false, error: "Invalid MFA token" };
    }

    const user = this.users.get(tokenResult.payload.sub);

    if (!user || !user.mfaSecret) {
      return { success: false, error: "User not found or MFA not configured" };
    }

    const mfaResult = this.mfa.verifyMfa(user.id, user.mfaSecret, code);

    if (!mfaResult.success) {
      return {
        success: false,
        error: mfaResult.error || "MFA verification failed",
      };
    }

    return this.createAuthenticatedSession(user, ipAddress, userAgent);
  }

  /**
   * Refresh access token
   */
  refreshToken(refreshToken: string, sessionId: string): AuthResult {
    const session = this.sessions.getSession(sessionId);

    if (!session || session.refreshToken !== refreshToken) {
      return { success: false, error: "Invalid refresh token" };
    }

    // Check refresh token expiry
    if (Date.now() > session.refreshExpiresAt) {
      this.sessions.invalidateSession(sessionId);
      return { success: false, error: "Refresh token expired" };
    }

    const validation = this.sessions.validateSession(sessionId);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const user = this.users.get(session.userId);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    const newToken = this.jwt.generateToken(user);
    const newRefreshToken = this.jwt.generateRefreshToken();

    session.token = newToken;
    session.refreshToken = newRefreshToken;

    return {
      success: true,
      user,
      session,
      tokens: {
        accessToken: newToken,
        refreshToken: newRefreshToken,
      },
    };
  }

  /**
   * Logout user
   */
  logout(sessionId: string): boolean {
    const session = this.sessions.getSession(sessionId);
    if (session) {
      this.sessions.invalidateSession(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Logout all sessions for user
   */
  logoutAll(userId: string): number {
    return this.sessions.invalidateUserSessions(userId);
  }

  /**
   * Check if user has permission
   */
  hasPermission(user: User, permission: Permission): boolean {
    if (user.permissions.includes("system:full")) return true;
    return user.permissions.includes(permission);
  }

  /**
   * Enable MFA for user
   */
  enableMfa(userId: string): {
    success: boolean;
    secret?: string;
    backupCodes?: string[];
    error?: string;
  } {
    const user = this.users.get(userId);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    const secret = this.mfa.generateSecret();
    const backupCodes = this.mfa.generateBackupCodes(userId);

    user.mfaEnabled = true;
    user.mfaSecret = secret;

    this.logger.info("MFA enabled", { userId });

    return { success: true, secret, backupCodes };
  }

  /**
   * Get user by ID
   */
  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  /**
   * Get all users
   */
  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  /**
   * Cleanup expired sessions
   */
  cleanup(): { sessionsRemoved: number } {
    const sessionsRemoved = this.sessions.cleanupExpiredSessions();
    return { sessionsRemoved };
  }

  private createAuthenticatedSession(user: User, ipAddress: string, userAgent: string): AuthResult {
    const token = this.jwt.generateToken(user);
    const refreshToken = this.jwt.generateRefreshToken();
    const session = this.sessions.createSession(user, token, refreshToken, ipAddress, userAgent);

    this.logger.info("User authenticated", {
      userId: user.id,
      username: user.username,
      sessionId: session.id,
      ipAddress,
    });

    return {
      success: true,
      user,
      session,
      tokens: {
        accessToken: token,
        refreshToken,
      },
    };
  }
}

// =============================================================================
// RBAC UTILITIES
// =============================================================================

export function hasPermission(user: User, permission: Permission): boolean {
  if (user.permissions.includes("system:full")) return true;
  return user.permissions.includes(permission);
}

export function hasAnyPermission(user: User, permissions: Permission[]): boolean {
  if (user.permissions.includes("system:full")) return true;
  return permissions.some((p) => user.permissions.includes(p));
}

export function hasAllPermissions(user: User, permissions: Permission[]): boolean {
  if (user.permissions.includes("system:full")) return true;
  return permissions.every((p) => user.permissions.includes(p));
}

export function getRolePermissions(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role];
}

// =============================================================================
// EXPORTS
// =============================================================================

let _authManager: HardenedAuthManager | null = null;

/**
 * Lazy singleton — created on first call, not at import time.
 * Throws if JWT_SECRET is not set.
 */
export function getAuthManager(): HardenedAuthManager {
  if (!_authManager) {
    if (!process.env["JWT_SECRET"]) {
      throw new Error(
        "JWT_SECRET environment variable is required. Set it before starting the application.",
      );
    }
    _authManager = new HardenedAuthManager({ jwtSecret: process.env["JWT_SECRET"] });
  }
  return _authManager;
}

/** @deprecated Use getAuthManager() instead */
export const authManager = new Proxy({} as HardenedAuthManager, {
  get(_, prop) {
    return (getAuthManager() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
