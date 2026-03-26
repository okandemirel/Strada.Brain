# Security

Strada.Brain runs AI agents with access to your file system, shell, and git. Security is layered to prevent unintended access and data leakage. This document describes the security features that are implemented in the codebase today.

## Reporting Security Issues

If you discover a security vulnerability, please report it privately via email rather than opening a public issue. Contact the maintainers directly so the issue can be assessed and patched before disclosure.

## Security Layers

### 1. Channel Authentication

Each messaging channel enforces an allowlist of authorized users. Unauthorized requests are rejected before reaching the agent.

- **Telegram**: `ALLOWED_TELEGRAM_USER_IDS` -- comma-separated numeric IDs. If empty, all users are denied.
- **Slack**: `ALLOWED_SLACK_USER_IDS` and `ALLOWED_SLACK_WORKSPACES` -- if empty, all users are allowed (open by default).
- **Discord**: `ALLOWED_DISCORD_USER_IDS` and `ALLOWED_DISCORD_ROLE_IDS` -- if empty, all users are denied (closed by default). Supports both user-level and role-level authorization.
- **Web**: JWT-based authentication (see below).

Implementation: `src/security/auth.ts`

### 2. Rate Limiting and Budget Caps

A token-bucket rate limiter enforces per-user and global limits to prevent abuse and runaway costs.

- **Per-user**: configurable messages per minute and per hour.
- **Global**: daily token quota, daily spend cap (USD), monthly spend cap (USD).
- **Cost model**: built-in cost estimates for Claude, OpenAI, DeepSeek, Groq, Mistral, and Ollama.
- **Auto-rotation**: counters reset at UTC day/month boundaries.

When any limit is hit, the request is rejected with a reason string and optional `retryAfterMs`.

Implementation: `src/security/rate-limiter.ts`

### 3. Path Guard

All file tool operations pass through a path validator that prevents escape from the project directory.

- **Symlink resolution**: uses `realpath()` to resolve symlinks before checking boundaries. Prevents symlink escape attacks.
- **Trailing separator check**: avoids prefix collisions (e.g., `/project` vs `/project-evil`).
- **Null byte rejection**: blocks null bytes in paths (defense-in-depth).
- **Sensitive file blocklist**: denies access to `.env`, `.git/config`, `.git/credentials`, `credentials.json`, `secrets.json`, `.ssh/`, `node_modules/`, private keys (`.pem`, `.key`, `id_rsa`, `id_ed25519`), keystores (`.pfx`, `.p12`, `.jks`), `google-services.json`, `GoogleService-Info.plist`, `.npmrc`, `.netrc`.
- **C# identifier validation**: prevents code injection in generated Unity files.

Implementation: `src/security/path-guard.ts`

### 4. Secret Sanitizer

All tool output is scrubbed for credentials before being returned to the LLM or displayed to users. Detection uses pattern-matching against known credential formats.

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

Output is also capped at 8192 characters to prevent context window flooding.

Implementation: `src/security/secret-sanitizer.ts`, `src/agents/orchestrator.ts` (inline `sanitizeToolResult`)

### 5. Read-Only Mode

When `READ_ONLY_MODE=true`, all write tools are removed from the agent's tool set entirely -- not just blocked at execution time, but filtered out before the LLM sees them. The system prompt is augmented to inform the agent that write operations are unavailable.

Blocked tools include: `file_write`, `file_edit`, `file_delete`, `file_rename`, `git_commit`, `git_push`, `git_branch`, `git_reset`, `git_merge`, `git_rebase`, `shell_exec`, `strada_create_module`, `strada_create_component`, `dotnet_add_package`, and others.

Allowed tools: `file_read`, `file_search`, `file_list`, `git_status`, `git_log`, `git_diff`, `code_search`, `memory_search`, `analyze_project`, and others.

Implementation: `src/security/read-only-guard.ts`

### 6. Operation Confirmation

Write operations can require explicit user approval before execution. The DM (Diff/Merge) policy supports four approval levels:

- **always**: every write operation requires confirmation.
- **destructive_only**: only high-risk operations require confirmation (file_delete, shell_exec, git_push, git_reset, etc.).
- **smart**: confirmation triggered when changes exceed thresholds (file count, line count).
- **never**: no confirmation required.

Controlled by `REQUIRE_EDIT_CONFIRMATION`. The confirmation flow shows a diff preview to the user and waits for approval (default timeout: 5 minutes).

Implementation: `src/security/dm-policy.ts`, `src/security/dm-state.ts`

### 7. Tool Output Sanitization (Orchestrator)

Beyond the SecretSanitizer, the orchestrator applies an additional pass on every tool result:

- Regex-based stripping of API key patterns (`sk-`, `key-`, `token-`, `ghp_`, `Bearer`, etc.).
- Hard length cap at 8192 characters with truncation marker.
- Learning event inputs are also sanitized and capped at 2048 characters before storage.
- Prompt injection defense: embedded section markers (`<!-- section:start -->`) are stripped from memory/RAG content before injection into prompts.

Implementation: `src/agents/orchestrator.ts`

### 8. Role-Based Access Control (RBAC)

A full RBAC system with role hierarchy, permission matrix, and policy engine.

**Roles** (highest to lowest privilege): `superadmin`, `admin`, `developer`, `viewer`, `service`.

**Permission matrix** maps resource types (file, directory, system, config, shell_command, user, agent, memory, log, api_key) to actions (create, read, update, delete, execute, manage, admin) with minimum role requirements.

**Policy engine**: supports custom policies with conditions based on role, permission, ownership, time window, IP address, and custom functions. Policies are priority-ordered. Default behavior is deny-all with explicit allow policies.

**ABAC engine**: attribute-based access control for fine-grained rules based on subject, resource, action, and environment attributes.

Implementation: `src/security/rbac.ts`, `src/security/auth-hardened.ts`

### 9. Multi-Agent Session Isolation

When multi-agent mode is enabled, each agent instance operates in an isolated session context to prevent cross-agent data leakage.

- **Per-channel isolation**: agents on different channels cannot access each other's session state or conversation history.
- **Budget isolation**: `AgentBudgetTracker` enforces per-agent token and cost limits, preventing a single agent from exhausting shared resources.
- **Registry controls**: `AgentRegistry` tracks all active instances with health checks and supports forced shutdown of misbehaving agents.
- **Delegation depth enforcement**: maximum delegation depth (default: 2) prevents infinite delegation loops that could exhaust resources.

Implementation: `src/multi-agent/agent-manager.ts`, `src/multi-agent/agent-budget-tracker.ts`, `src/delegation/delegation-manager.ts`

### 10. Deployment Security

The deployment subsystem enforces human-in-the-loop approval and circuit breaker protection.

- **Approval gate**: all deployments require explicit human approval via the `ApprovalQueue` before execution begins. Pending approvals expire after a configurable timeout.
- **Circuit breaker**: consecutive deployment failures trigger automatic cooldown with exponential backoff, preventing cascading failures.
- **Environment sanitization**: the `DeploymentExecutor` strips environment variables from deployment logs to prevent credential leakage.
- **Readiness validation**: `ReadinessChecker` validates system health (build status, test results, resource availability) before allowing deployment to proceed.
- **Opt-in only**: deployment is disabled by default (`DEPLOY_ENABLED=false`) and requires explicit activation.

Implementation: `src/daemon/triggers/deploy-trigger.ts`, `src/daemon/deployment/deployment-executor.ts`

### 11. Daemon Security

`DaemonSecurityPolicy` enforces tool-level approval requirements for daemon-triggered operations. Write tools require explicit user approval via the `ApprovalQueue` before execution.

Implementation: `src/daemon/security/daemon-security-policy.ts`, `src/daemon/security/approval-queue.ts`

### 12. WebSocket Origin Validation

WebSocket connections are validated against an origin allowlist. By default, only `localhost` and `127.0.0.1` are accepted. Additional origins can be configured via `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS`.

Connections with empty or `"null"` Origin headers are rejected. Non-browser clients (no Origin header) are permitted. Malformed Origin URLs are rejected.

Implementation: `src/security/origin-validation.ts`

### 13. JWT Authentication

The web channel uses JWT (HS256) for authentication with the following protections:

- **Secure defaults**: 15-minute access token expiry, 7-day refresh tokens, 30-minute session timeout.
- **Brute-force protection**: account lockout after 5 failed attempts (30-minute lockout with exponential escalation up to 32x).
- **Token revocation**: in-memory revocation list checked on every request.
- **Timing-safe comparison**: signature verification uses `timingSafeEqual` to prevent timing attacks.
- **Claims validation**: issuer and audience are checked on every token.
- **Password hashing**: scrypt with 32-byte salt (N=16384, r=8, p=1).
- **Session management**: per-user session tracking, idle timeout, forced logout.
- **MFA support**: TOTP framework with backup codes and rate-limited verification (5 attempts per 5-minute window). Note: TOTP verification requires installing `otplib` for production use.

Implementation: `src/security/auth-hardened.ts`

### 14. Input Validation

All inputs are validated using Zod schemas before processing.

- **Path safety**: blocks null bytes, path traversal (`..`, `~/`), absolute paths.
- **Shell commands**: whitelist of allowed base commands (`ls`, `git`, `dotnet`, `npm`, etc.) with dangerous pattern rejection (`;`, `|`, `&`, backticks, `$()`, etc.).
- **C# identifiers**: validated against strict regex patterns to prevent code injection.
- **Message inputs**: channel-specific schemas enforce size limits and format requirements.
- **URL validation**: enforces HTTPS/WSS protocols, blocks private/internal webhook targets.
- **API keys and tokens**: format validation with character and length constraints.

Implementation: `src/validation/schemas.ts`, `src/validation/index.ts`

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

TLS and WebSocket security hardening:

- **TLS configuration**: minimum TLS 1.2, configurable cipher suites with forbidden cipher blocklist.
- **Certificate pinning**: SHA-256 fingerprint pinning with expiration tracking.
- **HSTS support**: configurable max-age, subdomain inclusion, and preload.
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`.

Implementation: `src/security/communication.ts`

## Configuration

Security-related environment variables:

| Variable | Description | Default |
|---|---|---|
| `ALLOWED_TELEGRAM_USER_IDS` | Comma-separated Telegram user IDs | (empty = deny all) |
| `ALLOWED_SLACK_USER_IDS` | Comma-separated Slack user IDs | (empty = allow all) |
| `ALLOWED_SLACK_WORKSPACES` | Comma-separated Slack workspace IDs | (empty = allow all) |
| `ALLOWED_DISCORD_USER_IDS` | Comma-separated Discord user IDs | (empty = deny all) |
| `ALLOWED_DISCORD_ROLE_IDS` | Comma-separated Discord role IDs | (empty) |
| `JWT_SECRET` | Secret for JWT signing (required for web channel) | (none) |
| `REQUIRE_MFA` | Require MFA for authentication | `false` |
| `REQUIRE_EDIT_CONFIRMATION` | Require user approval for write operations | `true` |
| `READ_ONLY_MODE` | Disable all write tools | `false` |
| `SHELL_ENABLED` | Allow shell command execution | `false` |
| `RATE_LIMIT_ENABLED` | Enable rate limiting | `true` |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | Max messages per user per minute | `30` |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | Max messages per user per hour | `500` |
| `RATE_LIMIT_TOKENS_PER_DAY` | Max API tokens per day (all users) | `1000000` |
| `RATE_LIMIT_DAILY_BUDGET_USD` | Max daily spend | `50` |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | Max monthly spend | `1000` |
| `MULTI_AGENT_ENABLED` | Enable multi-agent orchestration | `true` |
| `TASK_DELEGATION_ENABLED` | Enable task delegation | `true` |
| `AGENT_MAX_DELEGATION_DEPTH` | Maximum delegation chain depth | `2` |
| `DEPLOY_ENABLED` | Enable deployment subsystem | `false` |
| `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` | Additional allowed WebSocket origins | (localhost only) |

Fresh setup now writes both `MULTI_AGENT_ENABLED=true` and `TASK_DELEGATION_ENABLED=true` by default. Delegation still remains gated by multi-agent initialization, so it does not activate when `MULTI_AGENT_ENABLED=false`.

## Deployment Recommendations

1. **Set `JWT_SECRET`** to a cryptographically random value (at least 32 bytes). Never reuse across environments.
2. **Configure channel allowlists** -- especially `ALLOWED_TELEGRAM_USER_IDS` and `ALLOWED_DISCORD_USER_IDS`, which deny all users when empty.
3. **Keep `SHELL_ENABLED=false`** unless you specifically need shell access. Shell commands are validated against a whitelist, but the attack surface is inherently larger.
4. **Set budget caps** -- configure `RATE_LIMIT_DAILY_BUDGET_USD` and `RATE_LIMIT_MONTHLY_BUDGET_USD` to prevent runaway API costs.
5. **Use read-only mode** for analysis-only deployments by setting `READ_ONLY_MODE=true`.
6. **Bind to localhost** -- the web channel binds to `127.0.0.1` by default. Use a reverse proxy (nginx, Caddy) for external access.
7. **Enable confirmation** -- keep `REQUIRE_EDIT_CONFIRMATION=true` in production so destructive operations require explicit user approval.
8. **Never commit `.env` files** -- the path guard blocks access to `.env` files, but they should also be in `.gitignore`.
9. **Monitor logs** -- the security audit logger records authentication failures, suspicious activity, and policy violations. Review these regularly.
10. **Keep dependencies updated** -- the dependency security scanner (`src/security/dependency-security.ts`) can audit packages for known vulnerabilities.
