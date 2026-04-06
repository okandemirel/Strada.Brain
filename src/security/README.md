# src/security/

Security modules protecting Strada.Brain at multiple layers. All modules are re-exported from `index.ts`, which also provides `initializeSecurity()` for bootstrap and `createSecurityMiddleware()` for HTTP/WebSocket.

## Architecture

```
Channel Adapters
  └── AuthManager (auth.ts)              ← Platform allowlists (Telegram IDs, Discord IDs/roles, Slack users)
      └── RateLimiter (rate-limiter.ts)  ← Per-user message throttle + budget caps

Agent / Tool Execution
  ├── ReadOnlyGuard (read-only-guard.ts) ← Removes 23 write tools from LLM's tool list
  ├── PathGuard (path-guard.ts)          ← Symlink-resolving directory traversal prevention
  ├── DMPolicy (dm-policy.ts)            ← Confirmation flow for destructive/large operations
  │   └── DMStateManager (dm-state.ts)   ← Operation audit trail with lifecycle tracking
  └── SecretSanitizer (secret-sanitizer.ts) ← 24-pattern credential scrubbing on all outputs

Internal System Auth (auth-hardened.ts)
  ├── JwtManager         ← HS256 JWT with jti-based revocation, 15min expiry
  ├── SessionManager     ← Sliding-window sessions with 7-day refresh
  ├── PasswordHasher     ← scrypt (N=16384, r=8, p=1) with timingSafeEqual
  ├── MfaManager         ← Backup codes + RFC 6238 TOTP verification
  └── BruteForceProtection ← Escalating lockouts (5 attempts, 30min base, 32x max)

Infrastructure
  ├── RbacManager (rbac.ts)                ← 5 roles, 9 resource types, policy engine
  ├── TlsSecurityManager (communication.ts) ← HTTPS/WSS hardening, cert pinning
  ├── ChrootJail (filesystem-security.ts)   ← Software chroot for file operations
  ├── Firewall (network/firewall.ts)        ← IP allow/block, CIDR, DDoS protection
  ├── SecretRotationWatcher (secret-rotation.ts) ← Live .env reload on file changes
  └── SecurityAuditLogger (audit/)          ← 30+ event types, alert rules
```

## Authentication: Two Tiers

### Tier 1 — Channel Identity (`auth.ts` + `access-policy.ts`)

Pre-configured platform allowlists and explicit open-access flags. No JWT involved.

- **Telegram:** `Set<number>` of allowed user IDs. Closed by default.
- **Discord:** `Set<string>` for user IDs + role IDs. Closed by default unless one of those allowlists matches.
- **Slack:** `Set<string>` for user IDs + workspace IDs. Open by default when both allowlists are empty.
- **WhatsApp:** `Set<string>` of phone numbers. Open by default when the allowlist is empty.
- **Matrix / IRC / Teams:** closed by default unless allowlists match or the explicit `*_ALLOW_OPEN_ACCESS=true` flag is set.

Auth is checked at the earliest point — inside the platform event handler — before any processing. Channel adapters use the shared access-policy helpers so empty-allowlist behavior stays consistent with the runtime configuration.

### Tier 2 — System Auth (`auth-hardened.ts`)

Internal user authentication with JWT, sessions, MFA, and brute force protection.

Bootstrap wires this module from the main config surface. `auth-hardened.ts` does not read `process.env` directly; `JWT_SECRET` and `REQUIRE_MFA` are loaded by `src/config/config.ts` and injected via bootstrap.

- **JWT:** Hand-rolled HS256 using `createHmac("sha256")`. 15-minute expiry. `jti`-based revocation via in-memory Map. Signature comparison uses `timingSafeEqual`.
- **Sessions:** `Map<string, Session>` with sliding window expiry. 7-day refresh token. Per-user session tracking.
- **Password hashing:** `scryptSync` with `N=16384, r=8, p=1`. 32-byte random salt. Format: `scrypt:<saltHex>:<hashHex>`.
- **MFA:** Backup codes work (10 one-time 8-hex codes). TOTP verification is implemented with a 30-second step and ±1 step skew window.
- **Brute force:** 5 attempts per 30-minute window. Lockout escalates exponentially (2^n, capped at 32x). Count persists across lock periods until successful login.

**Note:** Sessions, revoked tokens, and brute force state are all in-memory. Server restart clears them.

## Authorization: RBAC (`rbac.ts`)

5 roles with numeric rank:

| Role | Rank | Key Permissions |
|------|------|-----------------|
| superadmin | 100 | `system:full` (bypasses all checks) |
| admin | 80 | system read/write, files, shell, config, user management |
| developer | 60 | system read, files read/write, shell, agents |
| viewer | 40 | system read, files read, config read |
| service | 20 | system read, files read, config read |

**Permission matrix:** 22 entries covering 9 resource types. `authorize()` checks the static matrix first, then the dynamic policy engine.

**Policy engine:** Priority-ordered rules with conditions (role, permission, ownership, time-based, IP-based, custom function). First matching policy wins; no match = default deny.

**Default policies:**
1. `superadmin-bypass` (priority 1000): always allow superadmin
2. `ownership-policy` (priority 500): allow if resource.owner === user.id
3. `default-deny` (priority 0): deny everything else

## Rate Limiting (`rate-limiter.ts`)

Sliding window per-user throttle:

- Per-minute message count
- Per-hour message count
- Daily token quota (aggregate across all users)
- Daily USD budget ceiling
- Monthly USD budget ceiling

Cost estimation uses provider cost tables for: Claude, OpenAI, DeepSeek, Groq, Mistral, Ollama. All limits default to 0 (unlimited). Counters reset at UTC midnight/month boundary.

## Path Guard (`path-guard.ts`)

`validatePath(projectRoot, relativePath)`:

1. Reject null bytes
2. Resolve symlinks with `realpath()` on both root and target
3. Trailing separator check (prevents `/project-evil` matching `/project`)
4. For new files: walk up to first existing ancestor, validate it's within root
5. Block 30+ sensitive patterns: `.env`, `.git/config`, `.git/credentials`, SSH keys, `.pem`, `.key`, certificates, `node_modules/`, service account files

Also exports `isValidCSharpIdentifier()` and `isValidCSharpType()` for code injection prevention in scaffold tools.

## Secret Sanitizer (`secret-sanitizer.ts`)

24 regex patterns applied to all tool outputs and error logs:

OpenAI keys, GitHub tokens (ghp_, ghs_, ghr_, gho_, github_pat_), Slack tokens (xox[bpas]-), AWS access keys (AKIA), Discord tokens, Telegram bot tokens, Anthropic keys (sk-ant-api03-), GCP keys (AIza), Azure keys, WhatsApp/Meta tokens (EAA), Firebase service accounts, JWTs (eyJ), Bearer/Basic auth headers, Slack webhook URLs, database connection strings (postgres/mysql/mongodb/redis with credentials), PEM private keys, generic env var patterns.

Output truncated at 8192 characters. Global singleton via `getGlobalSanitizer()`.

## Read-Only Guard (`read-only-guard.ts`)

When `READ_ONLY_MODE=true`, 23 write tools are blocked:
- File: `write`, `edit`, `delete`, `rename`, `delete_directory`
- Git: `commit`, `push`, `branch`, `stash`, `reset`, `checkout`, `merge`, `rebase`
- Shell: `exec`
- Strada: `create_module`, `create_component`, `create_mediator`, `create_system`
- .NET: `add_package`, `remove_package`, `new`

`filterToolsForReadOnly()` removes these from the tool array before the LLM receives them — the agent cannot even attempt to call them.

## DM Policy (`dm-policy.ts`)

"DM" stands for **Diff/Merge** (not Direct Message). Implements the confirmation flow for write operations.

Four approval levels:
- `ALWAYS` — every write requires confirmation
- `DESTRUCTIVE_ONLY` — only file_delete, shell_exec, git_push, git_reset, etc.
- `SMART` — destructive OR exceeds thresholds (3+ files or 50+ lines changed)
- `NEVER` — auto-approve everything

Generates diff previews (max 50 lines), sends via channel, waits for user response (5-minute timeout). Parses yes/no/view/edit responses via regex.

## Additional Modules

| Module | Purpose |
|--------|---------|
| `dm-state.ts` | Operation lifecycle tracking: PENDING → APPROVED → EXECUTING → COMPLETED. 24h retention. |
| `browser-security.ts` | URL validation, blocks `file://`/`data://`/`javascript://`, private IPs, admin paths. Per-session rate limit (60 ops/min). Max 5 concurrent browser sessions. |
| `communication.ts` | TLS 1.2+ with secure cipher suites, HSTS, security headers (CSP, X-Frame-Options, etc.), certificate pinning, WebSocket security (origin allowlist, message size limit, connection rate limiting). |
| `filesystem-security.ts` | `ChrootJail` (software chroot), `FileIntegrityMonitor` (SHA-256 change detection), `FileAuditLogger` (10K-entry ring buffer). |
| `dependency-security.ts` | `npm audit` + Snyk integration for vulnerability scanning. |
| `secret-rotation.ts` | Watches `.env` file for changes (2s poll), diffs values, calls registered callbacks, updates `process.env` live. |

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export, `initializeSecurity()`, middleware |
| `auth.ts` | Channel identity — platform allowlists |
| `auth-hardened.ts` | JWT, sessions, MFA, brute force, password hashing |
| `rbac.ts` | RBAC with policy engine and ABAC |
| `rate-limiter.ts` | Per-user message and budget rate limiting |
| `path-guard.ts` | Directory traversal prevention |
| `secret-sanitizer.ts` | 24-pattern credential masking |
| `read-only-guard.ts` | Write tool blocking (23 tools) |
| `dm-policy.ts` | Diff/Merge confirmation flow |
| `dm-state.ts` | Operation audit trail |
| `browser-security.ts` | URL validation, SSRF prevention |
| `communication.ts` | TLS hardening, WebSocket security |
| `filesystem-security.ts` | Chroot jail, file integrity, audit log |
