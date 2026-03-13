# src/validation/

Zod-based input validation schemas, sanitization functions, and a validation engine with statistics tracking.

## Schemas (`schemas.ts`)

Zod schemas organized by domain, each with strict constraints and security-focused refinements.

**Common validators:**
- `uuidSchema` — UUID v4
- `emailSchema` — max 254 chars, lowercased and trimmed
- `urlSchema` — enforces `https://` or `wss://` protocol
- `safeStringSchema` — 1-10,000 chars, rejects `< > " ' & ; \` | $ ( ) { } [ ] \n \r \0`
- `identifierSchema` — 1-256 chars, must start with letter or underscore
- `namespaceSchema` — dot-separated identifiers (e.g., `Game.Modules.Combat`)
- `safePathSchema` — 1-4,096 chars, rejects null bytes and path traversal (`..`, `~/`, leading `/`)
- `portSchema` — integer 1024-65535
- `ipAddressSchema` — IPv4 or IPv6
- `cidrSchema` — CIDR notation with IP validation

**Sanitization functions:**
- `sanitizeInput()` — strips dangerous characters, normalizes whitespace
- `sanitizeHtml()` — HTML entity encoding for 6 characters (`& < > " ' /`)
- `sanitizePath()` — removes null bytes, normalizes slashes
- `escapeRegex()` — escapes regex special characters

**File operation schemas:** `fileReadSchema`, `fileWriteSchema` (max 50 MB), `fileEditSchema`, `fileDeleteSchema`, `fileMoveSchema`, `fileSearchSchema` (max 10,000 results)

**Shell command schema:** whitelist of 20 allowed commands (ls, git, dotnet, npm, node, curl, etc.); rejects 11 dangerous shell metacharacters (`;`, `|`, `&`, `` ` ``, `$`, etc.); timeout 1s-5min default 60s

**API schemas:** `apiKeySchema` (16-512 chars alphanumeric), `webhookUrlSchema` (HTTPS, blocks localhost/private IPs), `jwtTokenSchema` (3-part dot-separated)

**Strada-specific schemas:** `csharpIdentifierSchema`, `csharpNamespaceSchema`, `csharpTypeSchema`, `unityComponentSchema` (up to 50 fields, 50 methods), `moduleCreateSchema`, `systemCreateSchema` (Update/FixedUpdate/LateUpdate)

**Channel message schemas:** `telegramMessageSchema` (4,096 char limit), `discordMessageSchema` (2,000 char, snowflake IDs), `slackMessageSchema` (40,000 char)

**Config schemas:** `rateLimitConfigSchema`, `securityConfigSchema` (max file size 50 MB, max request 10 MB)

## Input Validator (`index.ts` — `InputValidator`)

Stateful validation engine wrapping Zod with logging and performance tracking.

- `validate()` — returns `ValidationResult<T>` (success with parsed data or failure with error array)
- `validateAsync()` — async variant for async Zod schemas
- `validateOrThrow()` — throws `ValidationErrorException` on failure
- `matches()` — boolean type guard
- Tracks `totalValidations`, `failedValidations`, `successRate`, `lastError`
- Logs validation duration in milliseconds

**Security validators:**
- `sanitizeString()` — configurable max length (default 10,000), optional newline/HTML allowance, null byte removal
- `validateFilePath()` — checks null bytes, path traversal (`../`), absolute paths, allowed base path enforcement; returns normalized path
- `ValidationRateLimiter` — sliding window rate limiter (default 100 attempts per 60s) for validation endpoints

**Module-level functions:** `validate()`, `validateOrThrow()`, `validateAsync()`, `getValidator()` — delegates to a global `InputValidator` singleton.

## Key Files

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod schemas for files, shell commands, APIs, channels, C#/Unity types, search, and config |
| `index.ts` | InputValidator class, sanitization utilities, file path validation, rate limiter, global singleton |
