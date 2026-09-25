# Security

Strada.Brain runs AI agents with access to your file system, shell, and git. Security is layered to prevent unintended access and data leakage. This document describes the security features that are implemented in the codebase today.

## Reporting Security Issues

If you discover a security vulnerability, please report it privately via email rather than opening a public issue. Contact the maintainers directly so the issue can be assessed and patched before disclosure.

## Security Layers

### 1. Channel Authentication

Each messaging channel enforces an allowlist of authorized users. Unauthorized requests are rejected before reaching the agent.

- **Telegram**: `ALLOWED_TELEGRAM_USER_IDS` -- comma-separated numeric IDs. If empty, all users are denied.
- **Slack**: `ALLOWED_SLACK_USER_IDS` and `ALLOWED_SLACK_WORKSPACES` -- both closed by default: an empty list denies, and a message must pass both lists, so setting only `ALLOWED_SLACK_USER_IDS` still denies everyone.
- **Discord**: `ALLOWED_DISCORD_USER_IDS` and `ALLOWED_DISCORD_ROLE_IDS` -- if empty, all users are denied (closed by default). Supports both user-level and role-level authorization.
- **Web**: no login, and no JWT (the module in section 13 is not used by any channel). The portal binds `127.0.0.1` by default and relies on the Host allow-list (`HTTP_ALLOWED_HOSTS`), same-origin checks on its WebSocket and on mutating requests (`WEB_TRUSTED_ORIGINS` adds a reverse proxy's public origin), and a per-browser profile identity (an id and token the channel issues). Anyone who can load the portal can use it: put an authenticating reverse proxy in front before exposing it beyond one machine.

Implementation: `src/security/auth.ts`, `src/security/access-policy.ts`, `src/security/host-validation.ts`

### 2. Rate Limiting and Budget Caps

A token-bucket rate limiter enforces per-user and global limits to prevent abuse and runaway costs.

- **Per-user**: configurable messages per minute and per hour.
- **Global**: daily token quota, daily spend cap (USD), monthly spend cap (USD).
- **Cost model**: built-in cost estimates for Claude, OpenAI, DeepSeek, Groq, Mistral, and Ollama.
- **Auto-rotation**: counters reset at UTC day/month boundaries.
- **Durable spend**: at startup the daily and monthly spend counters are seeded from the budget ledger in `daemon.db` (the spend the unified budget manager recorded for the current UTC day and month), so a restart does not reset the spend caps. The daily token quota and the per-user message windows are kept in memory only and start from zero after a restart.
- **Unset vs `0`**: a limit left unset uses the built-in default (see the table under Configuration Reference); an explicit `0` means unlimited.

When any limit is hit, the request is rejected with a reason string and optional `retryAfterMs`.

Implementation: `src/security/rate-limiter.ts`, `src/budget/unified-budget-manager.ts` (spend ledger)

### 3. Path Guard

All file tool operations pass through a path validator that prevents escape from the project directory.

- **Symlink resolution**: uses `realpath()` to resolve symlinks before checking boundaries. Prevents symlink escape attacks.
- **Trailing separator check**: avoids prefix collisions (e.g., `/project` vs `/project-evil`).
- **Null byte rejection**: blocks null bytes in paths (defense-in-depth).
- **Sensitive file blocklist**: denies access to `.env`, `.git/config`, `.git/credentials`, `credentials.json`, `secrets.json`, `.ssh/`, `node_modules/`, private keys (`.pem`, `.key`, `id_rsa`, `id_ed25519`), keystores (`.pfx`, `.p12`, `.jks`), `google-services.json`, `GoogleService-Info.plist`, `.npmrc`, `.netrc`.
- **C# identifier validation**: prevents code injection in generated Unity files.

Implementation: `src/security/path-guard.ts`

### 4. Secret Sanitizer

`sanitizeSecrets()` scrubs credentials by pattern-matching against known formats. Audited 2026-09-02: this section used to promise the scrub on every tool output and cite `sanitizeToolResult` as the place it happens. It does not happen there. The 26-pattern set below runs on **stored and forwarded text**, not on tool results:

- Task results and errors (`src/tasks/task-manager.ts`, `src/tasks/background-executor.ts`)
- Memory writes (`src/memory/file-memory-manager.ts`, `src/memory/unified/agentdb-memory.ts`)
- Learning storage (`src/learning/storage/learning-storage.ts`)
- Channel sends from bootstrap (`src/core/bootstrap-stages/stage-runtime.ts`)
- Provider error messages (`src/agents/providers/fallback-chain.ts`)
- Dashboard config masking (`src/dashboard/server.ts`) and `src/common/fetch-with-retry.ts` response bodies (rate-limit and error responses)

Tool results take a different path — `sanitizeToolResult` (section 7), which applies one API-key regex, not this set. A tool result containing a Stripe `sk_live_…` key, a raw JWT or a `postgres://user:pass@host` URL reaches the model unredacted.

Detected patterns include:
- OpenAI keys (`sk-`, `sk-proj-`), Anthropic keys (`sk-ant-api03-`), GCP keys (`AIza...`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)
- Slack tokens (`xox[bpas]-`), Slack webhooks
- AWS access keys (`AKIA...`), AWS secret keys
- Discord tokens, Telegram bot tokens, WhatsApp/Meta tokens (`EAA...`)
- Azure keys, Firebase service account fields
- JWT tokens (`eyJ...`), Bearer tokens, Basic auth headers
- Database connection strings (postgres, mysql, mongodb, redis URLs with embedded credentials)
- Private keys (PEM-encoded RSA, DSA, EC, OpenSSH)
- Generic `password=`, `api_key=`, `secret=`, `token=` patterns
- Bare `KEY=VALUE` lines (catches `.env` content)

Sanitized output is also capped at 8192 characters to prevent context window flooding.

Implementation: `src/security/secret-patterns.ts`, `src/security/secret-sanitizer.ts`

### 5. Read-Only Mode

When `READ_ONLY_MODE=true`, all write tools are removed from the agent's tool set entirely -- not just blocked at execution time, but filtered out before the LLM sees them. The system prompt is augmented to inform the agent that write operations are unavailable.

A tool counts as a write unless its metadata explicitly declares it read-only, so tools with missing or inferred metadata (plugins, skills, MCP servers) are withheld too; the name list below is a backstop.

Blocked tools include: `file_write`, `file_edit`, `file_delete`, `file_rename`, `git_commit`, `git_push`, `git_branch`, `git_stash`, `shell_exec`, `strada_create_module`, `strada_create_component`, `dotnet_build`, `dotnet_test`, and others.

Allowed tools: `file_read`, `file_search`, `file_list`, `git_status`, `git_log`, `git_diff`, `code_search`, `memory_search`, `analyze_project`, and others.

Implementation: `src/security/read-only-guard.ts`

### 6. Operation Confirmation

`REQUIRE_EDIT_CONFIRMATION` (default `true`) decides whether an **interactive** run asks the user before a write operation; with `false`, writes run without asking. Autonomous and non-interactive runs (including daemon tasks) never ask: they manage write approval themselves (see section 11).

When a run does ask, the DM (Diff/Merge) policy decides which writes need confirmation. `dm-policy.ts` defines four levels, but only two are reachable at runtime:

- **smart** (the default): confirmation when an operation is destructive or exceeds thresholds (file count, line count).
- **never**: no confirmation -- what enabling autonomous mode sets for that session.
- **always** and **destructive_only**: defined but **not enforced** -- no setting selects them and `setSessionPrefs()` has no caller, so no session ever runs at these levels.

The confirmation flow shows a diff preview to the user and waits for approval (default timeout: 5 minutes).

Implementation: `src/security/dm-policy.ts` (pending-confirmation state is in-memory; there is no persisted operation audit trail)

### 7. Tool Output Sanitization (Orchestrator)

Beyond the SecretSanitizer, the orchestrator applies an additional pass on every tool result:

- Regex-based stripping of API key patterns (`sk-`, `key-`, `token-`, `ghp_`, `Bearer`, etc.).
- Hard length cap at 8192 characters with truncation marker.
- Learning event inputs are also sanitized and capped at 2048 characters before storage.
- Prompt injection defense: embedded section markers (`<!-- section:start -->`) are stripped from memory/RAG content before injection into prompts.

Implementation: `src/agents/orchestrator.ts`

### 8. Roles (static table only)

`src/security/auth-hardened.ts` defines five roles (`superadmin`, `admin`, `developer`, `viewer`, `service`) and a static `ROLE_PERMISSIONS` table consulted by `hasPermission()` / `hasAnyPermission()` / `hasAllPermissions()`. Those helpers have no callers outside `src/security/`.

**Not implemented** (audited 2026-09-02): there is no RBAC policy engine, no ABAC engine, no resource/action permission matrix, no ownership or time/IP conditions and no default-deny authorization. The earlier rbac module under src/security/ was deleted as unused in commit 9d34babb (2026-03-22); nothing in the runtime denies a tool call because of a role. Do not plan a multi-tenant deployment around role-based authorization.

Implementation: `src/security/auth-hardened.ts`

### 9. Multi-Agent Session Isolation

When multi-agent mode is enabled, each agent instance operates in an isolated session context to prevent cross-agent data leakage.

- **Per-channel isolation**: agents on different channels cannot access each other's session state or conversation history.
- **Budget isolation**: `AgentBudgetTracker` enforces per-agent token and cost limits, preventing a single agent from exhausting shared resources.
- **Registry controls**: `AgentRegistry` tracks all active instances with health checks and supports forced shutdown of misbehaving agents.
- **Delegation depth enforcement**: maximum delegation depth (default: 2) prevents infinite delegation loops that could exhaust resources.

Implementation: `src/agents/multi/agent-manager.ts`, `src/agents/multi/agent-budget-tracker.ts`, `src/agents/multi/delegation/delegation-manager.ts`

### 10. Deployment Security

The deployment subsystem enforces human-in-the-loop approval and circuit breaker protection.

- **Approval gate**: all deployments require explicit human approval via the `ApprovalQueue` before execution begins. Pending approvals expire after a configurable timeout.
- **Circuit breaker**: consecutive deployment failures trigger automatic cooldown with exponential backoff, preventing cascading failures.
- **Environment sanitization**: the `DeploymentExecutor` strips environment variables from deployment logs to prevent credential leakage.
- **Readiness validation**: `ReadinessChecker` validates system health (build status, test results, resource availability) before allowing deployment to proceed.
- **Opt-in only**: deployment is disabled by default (`DEPLOY_ENABLED=false`) and requires explicit activation.

Implementation: `src/daemon/triggers/deploy-trigger.ts`, `src/daemon/deployment/deployment-executor.ts`

### 11. Daemon Security (classification only -- not enforced)

`DaemonSecurityPolicy` classifies tools as "allow" or "queue for approval" for daemon-triggered operations, but **nothing enforces it**: `checkPermission()` and `requestApproval()` have no production caller. Daemon trigger tasks are submitted straight to the task manager, and the write gate they pass through is the orchestrator's self-managed write review, which consults neither this policy nor `security.autoApproveTools`. Daemon write tools do **not** wait for user approval; do not deploy the daemon on the assumption that they do.

The `ApprovalQueue` is used for deployments (section 10), not for individual daemon tool calls.

Implementation: `src/daemon/security/daemon-security-policy.ts` (unenforced), `src/daemon/security/approval-queue.ts`

### 12. WebSocket Origin Validation

WebSocket connections are validated against an origin allowlist. By default, only `localhost` and `127.0.0.1` are accepted. Additional origins can be configured via `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS`.

Connections with empty or `"null"` Origin headers are rejected. Non-browser clients (no Origin header) are permitted. Malformed Origin URLs are rejected.

Implementation: `src/security/origin-validation.ts`

### 13. JWT / Session Module (not used by any channel)

`src/security/auth-hardened.ts` contains a JWT (HS256), session, password and MFA implementation, but **no channel authenticates with it**: the web channel does not use it (see section 1), and `getAuthManager()` has no caller outside the module. Bootstrap only hands it configuration (`configureAuthManager`). Setting `JWT_SECRET` or `REQUIRE_MFA` therefore protects nothing today. What the module implements, for when it is wired in:

- **Defaults**: 15-minute access token expiry, 7-day refresh tokens, 30-minute session timeout.
- **Token revocation**: in-memory revocation list.
- **Timing-safe comparison**: signature verification uses `timingSafeEqual`.
- **Claims validation**: issuer and audience checks.
- **Password hashing**: scrypt with 32-byte salt (N=32768, r=8, p=1).
- **MFA**: backup codes and TOTP verification.

One piece is in use: its `BruteForceProtection` class (escalating lockouts, up to 32x) guards the WebSocket dashboard's token check, per client IP (`src/dashboard/websocket-server.ts`: 5 failed attempts, then a 5-minute base lockout).

Implementation: `src/security/auth-hardened.ts`

### 14. Input Validation

There is no central validation module (the earlier `src/validation/` was deleted as unreachable in commit a219a99c). Validation lives at the point of use:

- **Configuration**: `src/config/config-schema.ts` is a Zod schema applied to the loaded config.
- **Path safety**: `src/security/path-guard.ts` blocks null bytes, traversal out of the project root (symlinks resolved) and sensitive filenames.
- **Shell commands**: `src/agents/tools/shell-exec.ts` (`checkCommandSafety`) is a denylist, not a whitelist -- it rejects known-destructive commands, dangerous pipes (`| sh`, `| bash`, `> /dev/sd*`) and injection vectors (command substitution, inline interpreters, `core.fsmonitor`). The command string itself is otherwise run as authored and does not pass through the path guard's sensitive-file blocklist.
- **C# identifiers**: `isValidCSharpIdentifier()` / `isValidCSharpType()` in `src/security/path-guard.ts` prevent code injection in scaffold tools.
- **URLs for browser tools**: `src/security/browser-security.ts` (`validateUrlWithConfig`) blocks `file://`, `data:`, `javascript:`, private/internal IPs and admin paths.
- **Message inputs**: per-channel length limits are enforced in each channel adapter when sending (e.g. Discord chunks at 2000 characters); there is no shared inbound message schema.

### 15. Media Attachment Security

All incoming media attachments are validated through multiple security layers before processing.

**MIME allowlist:**
- Images: JPEG, PNG, GIF, WebP
- Video: MP4, WebM, QuickTime
- Audio: MPEG, OGG, WAV, WebM, MP4
- Documents: PDF, plain text, CSV
- All other MIME types are rejected.

**Size limits:**
- Images: 20 MB
- Video: 50 MB
- Audio: 25 MB
- Documents: 10 MB

**Magic bytes verification:** File headers are checked against known signatures for JPEG, PNG, GIF, WebP, MP4, and PDF to prevent MIME type spoofing.

**SSRF protection:** All media download URLs are validated before fetching:
- Private/reserved IP ranges blocked (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1)
- Only HTTP/HTTPS schemes allowed
- Known host allowlist for platform APIs (api.telegram.org, cdn.discordapp.com, files.slack.com, mmg.whatsapp.net)
- HTTP redirects rejected (`redirect: "error"`) to prevent redirect-based SSRF bypass
- AWS metadata endpoint (`169.254.169.254`) explicitly blocked

**Streaming download:** Response bodies are read incrementally with a 50 MB absolute cap. Downloads exceeding the limit are aborted mid-stream to prevent memory exhaustion. A 30-second timeout prevents slow-loris attacks.

**Bot token protection:** Telegram file download URLs (which embed the bot token) are sanitized before logging using `sanitizeUrlForLog()`.

Implementation: `src/utils/media-processor.ts`

### 16. Communication Security

Strada.Brain's own listeners speak plain HTTP/WS; there is **no in-process TLS**. Terminate TLS in a reverse proxy (the Docker Compose stack ships an nginx config for this).

`src/security/communication.ts` (TLS minimum version, cipher blocklist, certificate pinning, HSTS) is **not enforced**: no runtime code imports it. It is also not ready to be wired in as-is: its certificate-chain check is a simplified placeholder (its own comment says so) and needs review first.

What is in effect: the web channel sends its own security headers (`X-Content-Type-Options: nosniff`, frame and referrer restrictions) on its responses.

Implementation: `src/channels/web/channel.ts` (headers); `src/security/communication.ts` (unused)

## Configuration

Security-related environment variables:

| Variable | Description | Default |
|---|---|---|
| `ALLOWED_TELEGRAM_USER_IDS` | Comma-separated Telegram user IDs | (empty = deny all) |
| `ALLOWED_SLACK_USER_IDS` | Comma-separated Slack user IDs (a message must also pass the workspace list) | (empty = deny all) |
| `ALLOWED_SLACK_WORKSPACES` | Comma-separated Slack workspace IDs | (empty = deny all) |
| `ALLOWED_DISCORD_USER_IDS` | Comma-separated Discord user IDs | (empty = deny all) |
| `ALLOWED_DISCORD_ROLE_IDS` | Comma-separated Discord role IDs | (empty) |
| `JWT_SECRET` | Secret for the JWT module (section 13). **Not enforced**: no channel authenticates with it | (none) |
| `REQUIRE_MFA` | MFA flag for the same module. **Not enforced** | `false` |
| `REQUIRE_EDIT_CONFIRMATION` | Ask before write operations in interactive runs (section 6) | `true` |
| `READ_ONLY_MODE` | Disable all write tools | `false` |
| `SHELL_ENABLED` | Allow shell command execution | `true` |
| `RATE_LIMIT_ENABLED` | Enable rate limiting | `false` |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | Max messages per user per minute (`0` = unlimited) | unset: unlimited |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | Max messages per user per hour (`0` = unlimited) | unset: unlimited |
| `RATE_LIMIT_TOKENS_PER_DAY` | Max API tokens per day, all users (`0` = unlimited) | unset: `500000` |
| `RATE_LIMIT_DAILY_BUDGET_USD` | Max daily spend, survives restarts (`0` = unlimited) | unset: `5` |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | Max monthly spend, survives restarts (`0` = unlimited) | unset: `100` |
| `MULTI_AGENT_ENABLED` | Enable multi-agent orchestration | `false` (setup writes `true`) |
| `TASK_DELEGATION_ENABLED` | Enable task delegation | `false` (setup writes `true`) |
| `AGENT_MAX_DELEGATION_DEPTH` | Maximum delegation chain depth | `2` |
| `DEPLOY_ENABLED` | Enable deployment subsystem | `false` |
| `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` | Additional allowed WebSocket origins | (localhost only) |

Fresh setup now writes both `MULTI_AGENT_ENABLED=true` and `TASK_DELEGATION_ENABLED=true` by default. Delegation still remains gated by multi-agent initialization, so it does not activate when `MULTI_AGENT_ENABLED=false`.

## Deployment Recommendations

1. **Do not expose the web portal without an authenticating reverse proxy** -- it has no login of its own (section 1), and `JWT_SECRET` does not add one (section 13).
2. **Configure channel allowlists** -- `ALLOWED_TELEGRAM_USER_IDS`, `ALLOWED_DISCORD_USER_IDS`, and for Slack both `ALLOWED_SLACK_USER_IDS` and `ALLOWED_SLACK_WORKSPACES`; all deny everyone when empty.
3. **Set `SHELL_ENABLED=false`** unless you specifically need shell access (it defaults to `true`). Shell commands are checked against a denylist of known-dangerous patterns (section 14), not an allowlist, so the attack surface is inherently larger.
4. **Set budget caps** -- configure `RATE_LIMIT_DAILY_BUDGET_USD` and `RATE_LIMIT_MONTHLY_BUDGET_USD` to prevent runaway API costs.
5. **Use read-only mode** for analysis-only deployments by setting `READ_ONLY_MODE=true`.
6. **Bind to localhost** -- the web channel binds to `127.0.0.1` by default. Use a reverse proxy (nginx, Caddy) for external access.
7. **Enable confirmation** -- keep `REQUIRE_EDIT_CONFIRMATION=true` so interactive runs ask before destructive or large writes. It does not cover autonomous runs or daemon tasks (sections 6 and 11).
8. **Never commit `.env` files** -- the path guard blocks access to `.env` files, but they should also be in `.gitignore`.
9. **Monitor logs** -- authentication failures and brute-force lockouts are written to the application logger (`src/utils/logger.ts`). There is no dedicated security audit logger or alert rule engine; review the application logs directly.
10. **Keep dependencies updated** -- run `npm run security:audit` (`npm audit --audit-level=high`, also run by `.github/workflows/ci.yml`). There is no in-tree dependency security scanner.
