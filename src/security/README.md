# src/security/

Security modules that protect Strada.Brain at multiple layers: authentication, authorization, input validation, rate limiting, and secret sanitization.

## Security Modules Overview

All modules are re-exported from `index.ts`, which also provides `initializeSecurity()` for bootstrapping alert rules and `createSecurityMiddleware()` for HTTP/WebSocket integration.

## Authentication (JWT, MFA, Brute Force Protection)

- **`auth.ts`** -- JWT token generation and verification with configurable expiry. Session management with refresh tokens.
- **`auth-hardened.ts`** -- `HardenedAuthManager` adds multi-factor authentication (TOTP) with backup codes, brute-force protection with account lockout, and `PasswordHasher` for secure credential storage.
- **Exports**: `JwtManager`, `MfaManager`, `SessionManager`, `BruteForceProtection`, `PasswordHasher`, role-based permission helpers (`hasPermission`, `hasAnyPermission`, `hasAllPermissions`).

## Rate Limiting

- **`rate-limiter.ts`** -- Per-user message rate limiting (per-minute, per-hour) and token usage tracking with daily/monthly budget caps. Configurable via `RATE_LIMIT_*` environment variables. Includes `estimateCost()` for provider cost estimation.

## Path Guard (Directory Traversal Prevention)

- **`path-guard.ts`** -- `validatePath()` prevents directory traversal attacks by ensuring file paths stay within allowed project boundaries. Blocks access to sensitive files (`.env`, credentials). Also exports `isValidCSharpIdentifier` and `isValidCSharpType` validators.

## Secret Sanitizer

- **`secret-sanitizer.ts`** -- `sanitizeSecrets()` detects and masks 18+ secret patterns (API keys, tokens, passwords, bearer tokens). Applied to all tool outputs before they are sent back to the LLM, and also sanitizes log output and channel messages.

## Additional Modules

| Module | Purpose |
|---|---|
| **`read-only-guard.ts`** | Enforces read-only mode, blocks file write/delete/shell operations |
| **`rbac.ts`** | Role-based access control (5 roles, 14 resource types), `PolicyEngine`, `AbacEngine` |
| **`browser-security.ts`** | URL validation, domain allowlisting, SSRF prevention for browser tools |
| **`dm-policy.ts` / `dm-state.ts`** | Direct message authorization policies and per-user DM state |
| **`communication.ts`** | TLS 1.3 configuration, certificate pinning, secure WebSocket management |
| **`dependency-security.ts`** | Vulnerability scanning via `npm audit`, Snyk integration |
| **`filesystem-security.ts`** | Chroot jail for file operations, file integrity monitoring, audit logging |

## Key Files

| File | Purpose |
|---|---|
| `index.ts` | Barrel export, `initializeSecurity()`, security middleware |
| `auth.ts` | JWT and session authentication |
| `auth-hardened.ts` | MFA, lockout, hardened auth manager |
| `rbac.ts` | Role-based access control, ABAC engine |
| `rate-limiter.ts` | Message and token rate limiting |
| `path-guard.ts` | Directory traversal prevention |
| `secret-sanitizer.ts` | API key and credential masking |
| `read-only-guard.ts` | Write operation blocking |
| `browser-security.ts` | URL validation for browser tools |
| `dm-policy.ts` | DM authorization policies |
| `communication.ts` | TLS and WebSocket security |
| `dependency-security.ts` | npm/Snyk vulnerability scanning |
| `filesystem-security.ts` | Chroot jail and file integrity |
