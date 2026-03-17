import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { createHmac } from "node:crypto";

// Set JWT_SECRET before importing to avoid the guard
beforeAll(() => {
  process.env["JWT_SECRET"] = "test-secret-minimum-length-for-jwt-signing-purposes";
});

import {
  PasswordHasher,
  JwtManager,
  BruteForceProtection,
  MfaManager,
  SessionManager,
  HardenedAuthManager,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  getRolePermissions,
  type User,
  type Permission,
} from "./auth-hardened.js";

const TEST_JWT_SECRET = "test-secret-minimum-length-for-jwt-signing-purposes";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Mock logger to suppress output during tests
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createLogger: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    role: "developer",
    permissions: getRolePermissions("developer"),
    mfaEnabled: false,
    failedLoginAttempts: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeSuperadmin(overrides: Partial<User> = {}): User {
  return makeUser({
    id: "superadmin-1",
    username: "superadmin",
    role: "superadmin",
    permissions: getRolePermissions("superadmin"),
    ...overrides,
  });
}

function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) {
      throw new Error(`Invalid base32 char: ${char}`);
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

function generateTotp(secret: string, timestampMs: number): string {
  const secretBytes = decodeBase32(secret);
  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secretBytes).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

// =============================================================================
// PasswordHasher
// =============================================================================

describe("PasswordHasher", () => {
  let hasher: PasswordHasher;

  beforeEach(() => {
    hasher = new PasswordHasher();
  });

  it("should hash a password and return scrypt format", async () => {
    const hash = await hasher.hash("my-secure-password");
    expect(hash).toContain(":");
    const [algo, salt, hashValue] = hash.split(":");
    expect(algo).toBe("scrypt");
    expect(salt).toBeTruthy();
    expect(hashValue).toBeTruthy();
    // Salt is 32 bytes = 64 hex chars
    expect(salt!.length).toBe(64);
    // scrypt 64-byte key = 128 hex chars
    expect(hashValue!.length).toBe(128);
  });

  it("should verify a correct password", async () => {
    const password = "correct-horse-battery-staple";
    const hash = await hasher.hash(password);
    const isValid = await hasher.verify(password, hash);
    expect(isValid).toBe(true);
  });

  it("should reject an incorrect password", async () => {
    const hash = await hasher.hash("real-password");
    const isValid = await hasher.verify("wrong-password", hash);
    expect(isValid).toBe(false);
  });

  it("should produce different hashes for the same password (random salt)", async () => {
    const password = "same-password";
    const hash1 = await hasher.hash(password);
    const hash2 = await hasher.hash(password);
    expect(hash1).not.toBe(hash2);
  });

  it("should return false for malformed hash strings", async () => {
    const isValid = await hasher.verify("password", "not-a-valid-hash");
    expect(isValid).toBe(false);
  });

  it("should return false for empty salt or hash part", async () => {
    const isValid = await hasher.verify("password", ":");
    expect(isValid).toBe(false);
  });

  it("should use timing-safe comparison", async () => {
    // Verify that both correct and incorrect passwords complete without timing-based errors.
    // The implementation uses timingSafeEqual internally.
    const hash = await hasher.hash("test-password");
    const result1 = await hasher.verify("test-password", hash);
    const result2 = await hasher.verify("wrong-password", hash);
    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });
});

// =============================================================================
// JwtManager
// =============================================================================

describe("JwtManager", () => {
  let jwt: JwtManager;

  const testUser: User = {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    role: "developer",
    permissions: ["system:read", "files:read"],
    mfaEnabled: false,
    failedLoginAttempts: 0,
    createdAt: Date.now(),
  };

  beforeEach(() => {
    jwt = new JwtManager({ jwtSecret: TEST_JWT_SECRET });
  });

  it("should generate a valid JWT token with three parts", () => {
    const token = jwt.generateToken(testUser);
    const parts = token.split(".");
    expect(parts.length).toBe(3);
  });

  it("should verify a valid token", () => {
    const token = jwt.generateToken(testUser);
    const result = jwt.verifyToken(token);
    expect(result.valid).toBe(true);
    expect(result.payload).toBeDefined();
    expect(result.payload!.sub).toBe("user-1");
    expect(result.payload!.username).toBe("testuser");
    expect(result.payload!.role).toBe("developer");
  });

  it("should reject an expired token", () => {
    const shortJwt = new JwtManager({
      jwtSecret: TEST_JWT_SECRET,
      jwtExpiresIn: -1, // Already expired
    });
    const token = shortJwt.generateToken(testUser);
    const result = shortJwt.verifyToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token expired");
  });

  it("should reject a tampered token", () => {
    const token = jwt.generateToken(testUser);
    // Tamper with the payload part
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "hacker" })).toString("base64url");
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = jwt.verifyToken(tamperedToken);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("should reject a token with wrong issuer", () => {
    const otherJwt = new JwtManager({
      jwtSecret: TEST_JWT_SECRET,
      issuer: "other-issuer",
    });
    const token = otherJwt.generateToken(testUser);

    // Verify with the default issuer manager
    const result = jwt.verifyToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid issuer");
  });

  it("should reject a token with wrong audience", () => {
    const otherJwt = new JwtManager({
      jwtSecret: TEST_JWT_SECRET,
      audience: "other-audience",
    });
    const token = otherJwt.generateToken(testUser);

    const result = jwt.verifyToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid audience");
  });

  it("should revoke a token by jti", () => {
    const token = jwt.generateToken(testUser);
    const verifyBefore = jwt.verifyToken(token);
    expect(verifyBefore.valid).toBe(true);

    const jti = verifyBefore.payload!.jti;
    jwt.revokeToken(jti);

    const verifyAfter = jwt.verifyToken(token);
    expect(verifyAfter.valid).toBe(false);
    expect(verifyAfter.error).toBe("Token revoked");
  });

  it("should throw when JWT_SECRET is empty (requireSecret)", () => {
    const noSecretJwt = new JwtManager({ jwtSecret: "" });
    expect(() => noSecretJwt.generateToken(testUser)).toThrow(
      "JWT_SECRET environment variable is required",
    );
  });

  it("should reject invalid token format", () => {
    const result = jwt.verifyToken("not-a-jwt");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid token format");
  });

  it("should reject token with only two parts", () => {
    const result = jwt.verifyToken("only.two");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid token format");
  });

  it("should generate a refresh token as 64-char hex string", () => {
    const refreshToken = jwt.generateRefreshToken();
    expect(typeof refreshToken).toBe("string");
    expect(refreshToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should cleanup only expired revoked tokens", () => {
    vi.useFakeTimers();
    try {
      const token = jwt.generateToken(testUser);
      const payload = jwt.verifyToken(token).payload!;
      jwt.revokeToken(payload.jti);

      // Token is revoked
      expect(jwt.verifyToken(token).valid).toBe(false);

      // Cleanup does NOT clear non-expired revocations
      jwt.cleanupRevokedTokens();
      expect(jwt.verifyToken(token).valid).toBe(false);

      // Advance past token expiry, then cleanup removes it
      vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2 hours
      jwt.cleanupRevokedTokens();
      // Token itself is also expired now, so still invalid
      expect(jwt.verifyToken(token).valid).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// BruteForceProtection
// =============================================================================

describe("BruteForceProtection", () => {
  let protection: BruteForceProtection;

  beforeEach(() => {
    protection = new BruteForceProtection(3, 60_000); // 3 attempts, 60s lockout
  });

  it("should allow initial attempts", () => {
    const result = protection.canAttempt("user@192.168.1.1");
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  it("should track failures and return count", () => {
    const key = "user@192.168.1.1";
    expect(protection.getAttemptCount(key)).toBe(0);
    protection.recordFailure(key);
    expect(protection.getAttemptCount(key)).toBe(1);
    protection.recordFailure(key);
    expect(protection.getAttemptCount(key)).toBe(2);
  });

  it("should allow attempts below the max threshold", () => {
    const key = "user@192.168.1.1";
    protection.recordFailure(key);
    protection.recordFailure(key);
    // 2 failures, max is 3 => still allowed
    const result = protection.canAttempt(key);
    expect(result.allowed).toBe(true);
  });

  it("should lock after max failed attempts", () => {
    const key = "user@192.168.1.1";
    protection.recordFailure(key);
    protection.recordFailure(key);
    protection.recordFailure(key); // Hits max => locked

    const result = protection.canAttempt(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("should allow after lockout expires", () => {
    vi.useFakeTimers();
    try {
      const key = "user@192.168.1.1";
      const lockoutMs = 5000;
      const shortProtection = new BruteForceProtection(2, lockoutMs);
      shortProtection.recordFailure(key);
      shortProtection.recordFailure(key); // locked

      // Still locked
      expect(shortProtection.canAttempt(key).allowed).toBe(false);

      // Advance past the lockout duration
      vi.advanceTimersByTime(lockoutMs + 1);

      const result = shortProtection.canAttempt(key);
      expect(result.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should reset on successful login", () => {
    const key = "user@192.168.1.1";
    protection.recordFailure(key);
    protection.recordFailure(key);
    protection.recordSuccess(key);

    expect(protection.getAttemptCount(key)).toBe(0);
    expect(protection.canAttempt(key).allowed).toBe(true);
  });

  it("should reset via the reset method", () => {
    const key = "user@192.168.1.1";
    protection.recordFailure(key);
    protection.recordFailure(key);
    protection.reset(key);
    expect(protection.getAttemptCount(key)).toBe(0);
  });
});

// =============================================================================
// MfaManager
// =============================================================================

describe("MfaManager", () => {
  let mfa: MfaManager;

  beforeEach(() => {
    mfa = new MfaManager();
  });

  it("should generate a secret as a non-empty string", () => {
    const secret = mfa.generateSecret();
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(0);
  });

  it("should generate 10 backup codes", () => {
    const codes = mfa.generateBackupCodes("user-1");
    expect(codes.length).toBe(10);
    codes.forEach((code) => {
      // Each code is 4 random bytes as uppercase hex = 8 chars
      expect(code).toMatch(/^[0-9A-F]{8}$/);
    });
  });

  it("should verify a backup code successfully (one-time use)", () => {
    const codes = mfa.generateBackupCodes("user-1");
    const firstCode = codes[0]!;

    // First use succeeds (backup codes bypass TOTP)
    const result1 = mfa.verifyMfa("user-1", "any-secret", firstCode);
    expect(result1.success).toBe(true);

    // Second use of the same code fails (one-time)
    const result2 = mfa.verifyMfa("user-1", "any-secret", firstCode);
    expect(result2.success).toBe(false);
  });

  it("should rate limit MFA attempts", () => {
    const userId = "user-rate-limit";
    mfa.generateBackupCodes(userId);

    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      mfa.verifyMfa(userId, "secret", "INVALID!");
    }

    // 6th attempt should be rate limited
    const result = mfa.verifyMfa(userId, "secret", "INVALID!");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Too many attempts");
    expect(result.remainingAttempts).toBe(0);
  });

  it("should report remaining attempts on failure", () => {
    const userId = "user-attempts";
    const result = mfa.verifyMfa(userId, "secret", "INVALID!");
    expect(result.success).toBe(false);
    expect(result.remainingAttempts).toBeDefined();
    expect(result.remainingAttempts).toBe(4); // 5 max - 1 attempt = 4
  });

  it("should verify a valid TOTP code", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T12:00:00Z"));

    const secret = mfa.generateSecret();
    const code = generateTotp(secret, Date.now());
    const result = mfa.verifyMfa("user-totp", secret, code);

    expect(result.success).toBe(true);
    vi.useRealTimers();
  });

  it("should accept a TOTP code within the allowed clock skew window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T12:00:30Z"));

    const secret = mfa.generateSecret();
    const previousWindowCode = generateTotp(secret, Date.now() - 30_000);
    const result = mfa.verifyMfa("user-totp-window", secret, previousWindowCode);

    expect(result.success).toBe(true);
    vi.useRealTimers();
  });

  it("should reject invalid code format", () => {
    const result = mfa.verifyMfa("user-totp", mfa.generateSecret(), "abc");
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SessionManager
// =============================================================================

describe("SessionManager", () => {
  let sessions: SessionManager;

  const testUser: User = {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    role: "developer",
    permissions: ["system:read"],
    mfaEnabled: false,
    failedLoginAttempts: 0,
    createdAt: Date.now(),
  };

  beforeEach(() => {
    sessions = new SessionManager({ sessionTimeout: 30 * 60 * 1000 });
  });

  it("should create a session with correct fields", () => {
    const session = sessions.createSession(
      testUser,
      "token-abc",
      "refresh-xyz",
      "127.0.0.1",
      "TestAgent/1.0",
    );

    expect(session.id).toBeTruthy();
    expect(session.userId).toBe("user-1");
    expect(session.token).toBe("token-abc");
    expect(session.refreshToken).toBe("refresh-xyz");
    expect(session.ipAddress).toBe("127.0.0.1");
    expect(session.userAgent).toBe("TestAgent/1.0");
    expect(session.isValid).toBe(true);
  });

  it("should validate an active session", () => {
    const session = sessions.createSession(testUser, "token", "refresh", "127.0.0.1", "Agent");

    const result = sessions.validateSession(session.id);
    expect(result.valid).toBe(true);
    expect(result.session).toBeDefined();
  });

  it("should return error for nonexistent session", () => {
    const result = sessions.validateSession("nonexistent-id");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Session not found");
  });

  it("should invalidate a session", () => {
    const session = sessions.createSession(testUser, "token", "refresh", "127.0.0.1", "Agent");

    sessions.invalidateSession(session.id);

    const result = sessions.validateSession(session.id);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Session not found");
  });

  it("should return active sessions for a user", () => {
    sessions.createSession(testUser, "t1", "r1", "127.0.0.1", "Agent");
    sessions.createSession(testUser, "t2", "r2", "127.0.0.1", "Agent");

    const userSessions = sessions.getUserSessions("user-1");
    expect(userSessions.length).toBe(2);
  });

  it("should return empty array for user with no sessions", () => {
    const userSessions = sessions.getUserSessions("nonexistent-user");
    expect(userSessions).toHaveLength(0);
  });

  it("should invalidate all sessions for a user", () => {
    sessions.createSession(testUser, "t1", "r1", "127.0.0.1", "Agent");
    sessions.createSession(testUser, "t2", "r2", "127.0.0.1", "Agent");
    sessions.createSession(testUser, "t3", "r3", "127.0.0.1", "Agent");

    const count = sessions.invalidateUserSessions("user-1");
    expect(count).toBe(3);

    const userSessions = sessions.getUserSessions("user-1");
    expect(userSessions.length).toBe(0);
  });

  it("should cleanup expired sessions", () => {
    vi.useFakeTimers();
    try {
      const sessionTimeout = 5000;
      const shortSessions = new SessionManager({ sessionTimeout });
      shortSessions.createSession(testUser, "t1", "r1", "127.0.0.1", "Agent");

      // Not yet expired
      expect(shortSessions.cleanupExpiredSessions()).toBe(0);

      // Advance past timeout
      vi.advanceTimersByTime(sessionTimeout + 1);

      const removed = shortSessions.cleanupExpiredSessions();
      expect(removed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should get session by ID", () => {
    const session = sessions.createSession(testUser, "token", "refresh", "127.0.0.1", "Agent");

    const retrieved = sessions.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it("should return undefined for unknown session ID", () => {
    const retrieved = sessions.getSession("unknown");
    expect(retrieved).toBeUndefined();
  });

  it("should update lastActivityAt on validate", () => {
    const session = sessions.createSession(testUser, "token", "refresh", "127.0.0.1", "Agent");
    const originalActivity = session.lastActivityAt;

    const result = sessions.validateSession(session.id);
    expect(result.valid).toBe(true);
    expect(result.session!.lastActivityAt).toBeGreaterThanOrEqual(originalActivity);
  });
});

// =============================================================================
// HardenedAuthManager
// =============================================================================

describe("HardenedAuthManager", () => {
  let auth: HardenedAuthManager;

  beforeEach(() => {
    auth = new HardenedAuthManager({
      jwtSecret: TEST_JWT_SECRET,
      passwordMinLength: 8,
      maxLoginAttempts: 3,
      lockoutDuration: 60_000,
    });
  });

  describe("registerUser", () => {
    it("should register a new user successfully", async () => {
      const result = await auth.registerUser(
        "alice",
        "alice@example.com",
        "strong-password-123",
        "developer",
      );

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user!.username).toBe("alice");
      expect(result.user!.role).toBe("developer");
      expect(result.user!.passwordHash).toBeDefined();
    });

    it("should reject a password shorter than minimum length", async () => {
      const result = await auth.registerUser("bob", "bob@example.com", "short", "viewer");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Password must be at least");
    });

    it("should reject duplicate username", async () => {
      await auth.registerUser("alice", "alice@example.com", "strong-password-123", "viewer");
      const result = await auth.registerUser(
        "alice",
        "alice2@example.com",
        "another-password-1",
        "viewer",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("User already exists");
    });

    it("should reject duplicate email", async () => {
      await auth.registerUser("alice", "alice@example.com", "strong-password-123", "viewer");
      const result = await auth.registerUser(
        "alice2",
        "alice@example.com",
        "another-password-1",
        "viewer",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("User already exists");
    });

    it("should default to viewer role", async () => {
      const result = await auth.registerUser(
        "charlie",
        "charlie@example.com",
        "strong-password-123",
      );
      expect(result.success).toBe(true);
      expect(result.user!.role).toBe("viewer");
    });
  });

  describe("authenticate", () => {
    beforeEach(async () => {
      await auth.registerUser("testuser", "test@example.com", "correct-password", "developer");
    });

    it("should authenticate with correct credentials", async () => {
      const result = await auth.authenticate(
        "testuser",
        "correct-password",
        "127.0.0.1",
        "TestAgent",
      );

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.session).toBeDefined();
      expect(result.tokens).toBeDefined();
      expect(result.tokens!.accessToken).toBeTruthy();
      expect(result.tokens!.refreshToken).toBeTruthy();
    });

    it("should reject wrong password", async () => {
      const result = await auth.authenticate(
        "testuser",
        "wrong-password",
        "127.0.0.1",
        "TestAgent",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid credentials");
    });

    it("should reject unknown user", async () => {
      const result = await auth.authenticate(
        "nonexistent",
        "some-password",
        "127.0.0.1",
        "TestAgent",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid credentials");
    });

    it("should lock account after max failed attempts", async () => {
      for (let i = 0; i < 3; i++) {
        await auth.authenticate("testuser", "wrong-password", "127.0.0.1", "TestAgent");
      }

      // Account should now be locked
      const result = await auth.authenticate(
        "testuser",
        "correct-password",
        "127.0.0.1",
        "TestAgent",
      );

      expect(result.success).toBe(false);
      // Could be "Account locked" or "Too many failed attempts" depending on which check fires first
      expect(result.error).toMatch(/locked|Too many/);
    });

    it("should reset failed attempts on successful login", async () => {
      // Fail twice (below threshold)
      await auth.authenticate("testuser", "wrong-password", "127.0.0.1", "TestAgent");
      await auth.authenticate("testuser", "wrong-password", "127.0.0.1", "TestAgent");

      // Then succeed
      const result = await auth.authenticate(
        "testuser",
        "correct-password",
        "127.0.0.1",
        "TestAgent",
      );
      expect(result.success).toBe(true);

      // User's failedLoginAttempts should be reset
      const user = auth.getUser(result.user!.id);
      expect(user!.failedLoginAttempts).toBe(0);
    });

    it("requires MFA for enabled users and completes authentication with a valid TOTP", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-17T12:00:00Z"));

      const reg = await auth.registerUser(
        "totp-user",
        "totp@example.com",
        "correct-password",
        "developer",
      );
      const enabled = auth.enableMfa(reg.user!.id);

      const firstStep = await auth.authenticate(
        "totp-user",
        "correct-password",
        "127.0.0.1",
        "TestAgent",
      );

      expect(firstStep.success).toBe(false);
      expect(firstStep.requiresMfa).toBe(true);
      expect(firstStep.mfaToken).toBeTruthy();

      const code = generateTotp(enabled.secret!, Date.now());
      const completed = auth.verifyMfaAndAuthenticate(
        firstStep.mfaToken!,
        code,
        "127.0.0.1",
        "TestAgent",
      );

      expect(completed.success).toBe(true);
      expect(completed.session).toBeDefined();
      expect(completed.tokens?.accessToken).toBeTruthy();
      vi.useRealTimers();
    });

    it("rejects MFA completion when the TOTP code is wrong", async () => {
      const reg = await auth.registerUser(
        "totp-fail-user",
        "totp-fail@example.com",
        "correct-password",
        "developer",
      );
      auth.enableMfa(reg.user!.id);

      const firstStep = await auth.authenticate(
        "totp-fail-user",
        "correct-password",
        "127.0.0.1",
        "TestAgent",
      );

      const completed = auth.verifyMfaAndAuthenticate(
        firstStep.mfaToken!,
        "000000",
        "127.0.0.1",
        "TestAgent",
      );

      expect(completed.success).toBe(false);
      expect(completed.error).toBe("Invalid code");
    });
  });

  describe("hasPermission (method)", () => {
    it("should return true when user has the permission", async () => {
      const reg = await auth.registerUser("dev", "dev@example.com", "password-12345", "developer");
      const user = reg.user!;

      expect(auth.hasPermission(user, "system:read")).toBe(true);
      expect(auth.hasPermission(user, "files:read")).toBe(true);
    });

    it("should return false when user lacks the permission", async () => {
      const reg = await auth.registerUser(
        "viewer",
        "viewer@example.com",
        "password-12345",
        "viewer",
      );
      const user = reg.user!;

      expect(auth.hasPermission(user, "files:write")).toBe(false);
      expect(auth.hasPermission(user, "shell:execute")).toBe(false);
    });

    it("should grant all permissions to superadmin via system:full", async () => {
      const reg = await auth.registerUser(
        "admin",
        "admin@example.com",
        "password-12345",
        "superadmin",
      );
      const user = reg.user!;

      expect(auth.hasPermission(user, "files:delete")).toBe(true);
      expect(auth.hasPermission(user, "users:manage")).toBe(true);
      expect(auth.hasPermission(user, "shell:execute")).toBe(true);
    });
  });

  describe("logout", () => {
    it("should logout a session", async () => {
      await auth.registerUser("logoutuser", "logout@example.com", "correct-password", "developer");
      const authResult = await auth.authenticate(
        "logoutuser",
        "correct-password",
        "127.0.0.1",
        "TestAgent",
      );
      const sessionId = authResult.session!.id;

      const loggedOut = auth.logout(sessionId);
      expect(loggedOut).toBe(true);
    });

    it("should return false for nonexistent session", () => {
      const loggedOut = auth.logout("nonexistent");
      expect(loggedOut).toBe(false);
    });
  });

  describe("enableMfa", () => {
    it("should enable MFA for an existing user", async () => {
      const reg = await auth.registerUser(
        "mfauser",
        "mfa@example.com",
        "password-12345",
        "developer",
      );
      const result = auth.enableMfa(reg.user!.id);

      expect(result.success).toBe(true);
      expect(result.secret).toBeTruthy();
      expect(result.backupCodes).toBeDefined();
      expect(result.backupCodes!.length).toBe(10);
    });

    it("should return error for nonexistent user", () => {
      const result = auth.enableMfa("nonexistent-user-id");
      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
    });
  });

  describe("getUser / getAllUsers", () => {
    it("should return a user by ID", async () => {
      const reg = await auth.registerUser(
        "lookup",
        "lookup@example.com",
        "password-12345",
        "viewer",
      );
      const user = auth.getUser(reg.user!.id);
      expect(user).toBeDefined();
      expect(user!.username).toBe("lookup");
    });

    it("should return undefined for unknown user", () => {
      expect(auth.getUser("unknown-id")).toBeUndefined();
    });

    it("should return all registered users", async () => {
      await auth.registerUser("user1", "u1@example.com", "password-12345", "viewer");
      await auth.registerUser("user2", "u2@example.com", "password-12345", "viewer");
      const all = auth.getAllUsers();
      expect(all.length).toBe(2);
    });
  });

  describe("cleanup", () => {
    it("should return cleanup result", () => {
      const result = auth.cleanup();
      expect(result).toHaveProperty("sessionsRemoved");
      expect(typeof result.sessionsRemoved).toBe("number");
    });
  });
});

// =============================================================================
// RBAC Utility Functions
// =============================================================================

describe("RBAC utility functions", () => {
  const superadminUser = makeSuperadmin();

  const developerUser = makeUser({
    id: "dev-1",
    username: "developer",
    email: "dev@example.com",
    role: "developer",
    permissions: getRolePermissions("developer"),
  });

  const viewerUser = makeUser({
    id: "viewer-1",
    username: "viewer",
    email: "viewer@example.com",
    role: "viewer",
    permissions: getRolePermissions("viewer"),
  });

  describe("hasPermission", () => {
    it("should return true when user has the permission", () => {
      expect(hasPermission(developerUser, "files:read")).toBe(true);
    });

    it("should return false when user lacks the permission", () => {
      expect(hasPermission(viewerUser, "files:write")).toBe(false);
    });

    it("should return true for superadmin with system:full on any permission", () => {
      expect(hasPermission(superadminUser, "files:delete")).toBe(true);
      expect(hasPermission(superadminUser, "users:manage")).toBe(true);
      expect(hasPermission(superadminUser, "shell:execute")).toBe(true);
      expect(hasPermission(superadminUser, "audit:read")).toBe(true);
      expect(hasPermission(superadminUser, "agents:manage")).toBe(true);
    });
  });

  describe("hasAnyPermission", () => {
    it("should return true when user has at least one permission", () => {
      expect(hasAnyPermission(developerUser, ["files:delete", "files:read"])).toBe(true);
    });

    it("should return false when user has none of the permissions", () => {
      expect(hasAnyPermission(viewerUser, ["files:write", "files:delete"])).toBe(false);
    });

    it("should return true for superadmin regardless", () => {
      expect(hasAnyPermission(superadminUser, ["files:delete", "users:manage"])).toBe(true);
    });
  });

  describe("hasAllPermissions", () => {
    it("should return true when user has all permissions", () => {
      expect(hasAllPermissions(developerUser, ["system:read", "files:read"])).toBe(true);
    });

    it("should return false when user is missing one permission", () => {
      expect(hasAllPermissions(developerUser, ["system:read", "users:manage"])).toBe(false);
    });

    it("should return true for superadmin regardless", () => {
      expect(
        hasAllPermissions(superadminUser, ["files:delete", "users:manage", "shell:execute"]),
      ).toBe(true);
    });

    it("should return true for empty permission list", () => {
      expect(hasAllPermissions(viewerUser, [])).toBe(true);
    });
  });

  describe("getRolePermissions", () => {
    it("should return correct permissions for each role", () => {
      expect(getRolePermissions("superadmin")).toContain("system:full");
      expect(getRolePermissions("admin")).toContain("users:manage");
      expect(getRolePermissions("developer")).toContain("shell:execute");
      expect(getRolePermissions("viewer")).toContain("system:read");
      expect(getRolePermissions("viewer")).not.toContain("shell:execute");
      expect(getRolePermissions("service")).toContain("config:read");
    });
  });
});
