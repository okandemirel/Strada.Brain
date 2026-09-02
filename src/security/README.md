# src/security/

Security modules protecting Strada.Brain at multiple layers. There is no barrel
export; each module is imported directly by the subsystem that uses it.

Audited 2026-09-02: this document previously described a chroot jail, a
default-deny RBAC policy engine, a firewall, a security audit logger, live
`.env` rotation and a dependency scanner. Those modules were deleted as dead
code in commit 9d34babb (2026-03-22) and the document was not updated. Every
module named below exists on disk; `readme-cites-real-modules.test.ts` fails
if that stops being true. See "Not implemented" at the end for what is absent.

## Architecture

```
Channel Adapters
  └── AuthManager (auth.ts + access-policy.ts) ← Platform allowlists (Telegram IDs, Discord IDs/roles, Slack users/workspaces)
      └── RateLimiter (rate-limiter.ts)         ← Per-user message throttle + budget caps

Agent / Tool Execution
  ├── ReadOnlyGuard (read-only-guard.ts)     ← Removes 23 write tools from the LLM's tool list
  ├── PathGuard (path-guard.ts)              ← Symlink-resolving directory traversal prevention + sensitive-file blocklist
  ├── UserAuthorizedPaths (user-authorized-paths.ts) ← Read-only exceptions for files the user named themselves
  ├── DMPolicy (dm-policy.ts)                ← Confirmation flow for destructive/large operations
  └── SecretSanitizer (secret-patterns.ts + secret-sanitizer.ts) ← 26-pattern credential scrubbing (see reach below)

Internal System Auth (auth-hardened.ts)
  ├── JwtManager         ← HS256 JWT with jti-based revocation, 15min expiry
  ├── SessionManager     ← Sliding-window sessions with 7-day refresh
  ├── PasswordHasher     ← scrypt (N=16384, r=8, p=1) with timingSafeEqual
  ├── MfaManager         ← Backup codes + RFC 6238 TOTP verification
  ├── BruteForceProtection ← Escalating lockouts (5 attempts, 30min base, 32x max)
  └── ROLE_PERMISSIONS   ← Static 5-role permission table (no policy engine; see below)

Transport
  ├── TlsSecurityManager (communication.ts)  ← HTTPS/WSS hardening, cert pinning
  ├── Origin validation (origin-validation.ts) ← WebSocket Origin allowlist (localhost by default)
  └── BrowserSecurity (browser-security.ts)  ← URL validation / SSRF prevention for browser tools
```

## Authentication: Two Tiers

### Tier 1 — Channel Identity (`auth.ts` + `access-policy.ts`)

Pre-configured platform allowlists and explicit open-access flags. No JWT involved.

- **Telegram:** `Set<number>` of allowed user IDs. Closed by default.
- **Discord:** `Set<string>` for user IDs + role IDs. Closed by default unless one of those allowlists matches.
- **Slack:** `Set<string>` for user IDs + workspace IDs. Closed by default: `src/channels/slack/app.ts` passes `"closed"` to `isAllowedBySingleIdPolicy` for both lists, so an empty allowlist denies.
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

## Roles (`auth-hardened.ts`)

What exists is a static table, not an authorization system:

- `UserRole` = `superadmin | admin | developer | viewer | service`
- `ROLE_PERMISSIONS`: a `Record<UserRole, Permission[]>` consulted by `hasPermission()`, `hasAnyPermission()`, `hasAllPermissions()` and `getRolePermissions()`.

Those helpers have no callers outside `src/security/`. There is no role rank,
no `authorize()`, no resource/action matrix, no ownership rule, no
priority-ordered policies and no default-deny engine — nothing in the runtime
denies a tool call because of a role.

## Rate Limiting (`rate-limiter.ts`)

Sliding window per-user throttle:

- Per-minute message count
- Per-hour message count
- Daily token quota (aggregate across all users)
- Daily USD budget ceiling
- Monthly USD budget ceiling

Cost estimation uses provider cost tables for: Claude, OpenAI, DeepSeek, Groq, Mistral, Ollama. All limits default to 0 (unlimited). Counters reset at UTC midnight/month boundary.

## Path Guard (`path-guard.ts`)

`validatePath(projectRoot, relativePath, { allowMissingParents? })`:

1. Reject null bytes
2. Resolve symlinks with `realpath()` on both root and target
3. Trailing separator check (prevents `/project-evil` matching `/project`)
4. For new files: walk up to first existing ancestor, validate it's within root. With `allowMissingParents` (write tools that `mkdir -p`) a missing parent chain is accepted once the deepest existing ancestor is proven inside the root.
5. Block sensitive patterns on every accepted path, including the missing-parent case: `.env` and any `.env.*` suffix chain, `.git/config`, `.git/credentials`, SSH keys, `.pem`, `.key`, certificates, `node_modules/`, service account files

The blocklist matches names, not content. It is a per-tool guardrail: `shell_exec` runs a model-authored command string and does not consult it.

Also exports `isValidCSharpIdentifier()` and `isValidCSharpType()` for code injection prevention in scaffold tools.

`user-authorized-paths.ts` is the one read-side exception: an exact absolute path the user typed in their own message may be read (never written, never a directory).

## Secret Sanitizer (`secret-patterns.ts` + `secret-sanitizer.ts`)

`DEFAULT_SECRET_PATTERNS` holds 26 regexes: OpenAI keys, GitHub tokens (ghp_, ghs_, ghr_, gho_, github_pat_), Slack tokens (xox[bpas]-), AWS access keys (AKIA), Discord tokens, Telegram bot tokens, Anthropic keys (sk-ant-api03-), GCP keys (AIza), Azure keys, WhatsApp/Meta tokens (EAA), Firebase service accounts, JWTs (eyJ), Bearer/Basic auth headers, Slack webhook URLs, database connection strings (postgres/mysql/mongodb/redis with credentials), PEM private keys, generic env var patterns.

Output truncated at 8192 characters. Global singleton via `getGlobalSanitizer()`.

**Reach — where `sanitizeSecrets()` actually runs:** task results and errors (`src/tasks/task-manager.ts`, `src/tasks/background-executor.ts`), memory writes (`src/memory/file-memory-manager.ts`, `src/memory/unified/agentdb-memory.ts`), learning storage (`src/learning/storage/learning-storage.ts`), channel sends from bootstrap (`src/core/bootstrap-stages/stage-runtime.ts`), provider error messages (`src/agents/providers/fallback-chain.ts`), dashboard config masking (`src/dashboard/server.ts`) and `src/common/fetch-with-retry.ts` bodies.

**Not on tool outputs.** The tool-result path (`sanitizeToolResult` in `src/agents/orchestrator-runtime-utils.ts`, called from `src/agents/orchestrator.ts`) applies prompt-injection stripping, one API-key regex (`redactSensitiveText` in `src/agents/orchestrator-text-utils.ts`) and the 8192-character cap — not the 26-pattern set. Tool output containing e.g. `sk_live_…`, a JWT or a `postgres://user:pass@host` URL reaches the model unredacted.

## Read-Only Guard (`read-only-guard.ts`)

When `READ_ONLY_MODE=true`, 23 write tools are blocked:
- File: `write`, `edit`, `delete`, `rename`, `delete_directory`
- Git: `commit`, `push`, `branch`, `stash`, `reset`, `checkout`, `merge`, `rebase`
- Shell: `exec`
- Strada: `create_module`, `create_component`, `create_mediator`, `create_system`
- .NET: `add_package`, `remove_package`, `new`, `build`, `test`

`filterToolsForReadOnly()` removes these from the tool array before the LLM receives them — the agent cannot even attempt to call them. (`create_skill` writes to disk but carries its own read-only check so it can give a better error.)

Audited 2026-09-02: this section said "22" in three places (here, the
architecture diagram and the key-files table) and omitted `dotnet_build` /
`dotnet_test`, which had already moved into `WRITE_TOOLS` because they write
`bin/`, `obj/` and the NuGet cache. `readme-cites-real-modules.test.ts` now
reads these counts and this list off disk and compares them to `WRITE_TOOLS`,
so the prose cannot drift from the set again.

## DM Policy (`dm-policy.ts`)

"DM" stands for **Diff/Merge** (not Direct Message). Implements the confirmation flow for write operations.

Four approval levels:
- `ALWAYS` — every write requires confirmation
- `DESTRUCTIVE_ONLY` — only file_delete, shell_exec, git_push, git_reset, etc.
- `SMART` — destructive OR exceeds thresholds (3+ files or 50+ lines changed)
- `NEVER` — auto-approve everything

Generates diff previews (max 50 lines), sends via channel, waits for user response (5-minute timeout). Parses yes/no/view/edit responses via regex. There is no persisted operation audit trail; the pending-confirmation state lives in memory for the duration of the prompt.

## Additional Modules

| Module | Purpose |
|--------|---------|
| `browser-security.ts` | URL validation, blocks `file://`/`data://`/`javascript://`, private IPs, admin paths. Per-session rate limit (60 ops/min). Max 5 concurrent browser sessions. |
| `communication.ts` | TLS 1.2+ with secure cipher suites, HSTS, security headers (CSP, X-Frame-Options, etc.), certificate pinning, WebSocket security (origin allowlist, message size limit, connection rate limiting). |
| `origin-validation.ts` | Shared WebSocket `Origin` check for the web channel and dashboard; localhost only unless extra hostnames are configured. |
| `user-authorized-paths.ts` | Extracts exact absolute paths from the user's own message and authorizes read-only access to them. |

## Key Files

| File | Purpose |
|------|---------|
| `auth.ts` | Channel identity — platform allowlists |
| `access-policy.ts` | Shared empty-allowlist semantics (`open` / `closed`) |
| `auth-hardened.ts` | JWT, sessions, MFA, brute force, password hashing, static role table |
| `rate-limiter.ts` | Per-user message and budget rate limiting |
| `path-guard.ts` | Directory traversal prevention + sensitive-file blocklist |
| `user-authorized-paths.ts` | User-named files readable outside the project |
| `secret-patterns.ts` | 26-pattern credential masking core (dependency-free) |
| `secret-sanitizer.ts` | Configurable sanitizer class over `secret-patterns.ts` |
| `read-only-guard.ts` | Write tool blocking (23 tools) |
| `dm-policy.ts` | Diff/Merge confirmation flow |
| `browser-security.ts` | URL validation, SSRF prevention |
| `communication.ts` | TLS hardening, WebSocket security |
| `origin-validation.ts` | WebSocket Origin allowlist |
| `no-tracked-secrets.test.ts` | Guards against `.env*` backups being committed (the 2026-08-22 leak) |

## Not implemented

None of the following exist anywhere in the repository. They were deleted in
commit 9d34babb because nothing imported them, so no runtime behaviour was
lost, but a reader must not plan a deployment around them:

- RBAC policy engine / ABAC (no `authorize()`, no priority-ordered or default-deny policies)
- Software chroot / file integrity monitoring / file audit ring buffer
- Network firewall (IP allow/block, CIDR, DDoS protection)
- Live `.env` rotation watcher
- Dependency vulnerability scanner (`npm audit` / Snyk integration)
- Security audit logger with event types and alert rules
- Persisted DM operation lifecycle tracking
