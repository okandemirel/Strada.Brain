# Input Validation

This document describes the input validation strategies and sanitization methods used in Strata Brain to prevent security vulnerabilities.

## Table of Contents

- [Overview](#overview)
- [Validation Strategies](#validation-strategies)
- [Path Validation](#path-validation)
- [Command Validation](#command-validation)
- [Code Injection Prevention](#code-injection-prevention)
- [Secret Sanitization](#secret-sanitization)
- [Schema Validation](#schema-validation)
- [Best Practices](#best-practices)

## Overview

Strata Brain processes untrusted input from multiple channels and must validate all input before processing. Our validation strategy follows the **validate-first** principle: all input is validated before any processing occurs.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Input Validation Pipeline                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  Raw     │───►│   Schema     │───►│   Semantic           │  │
│  │  Input   │    │   Validation │    │   Validation         │  │
│  └──────────┘    └──────────────┘    └──────────────────────┘  │
│                                              │                   │
│                                              ▼                   │
│                                    ┌──────────────────┐         │
│                                    │  Security Check  │         │
│                                    │  - Path guard    │         │
│                                    │  - Command check │         │
│                                    │  - Secret scan   │         │
│                                    └────────┬─────────┘         │
│                                             │                    │
│                              Valid          │         Invalid    │
│                                             ▼                    │
│                                    ┌──────────────────┐         │
│                                    │   Process Input  │         │
│                                    └──────────────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Validation Strategies

### 1. Whitelist Validation

Accept only known-good input:

```typescript
// Good - Whitelist approach
const ALLOWED_COMMANDS = ["dotnet", "git", "ls", "cat"] as const;
function isAllowedCommand(cmd: string): boolean {
  return ALLOWED_COMMANDS.includes(cmd as typeof ALLOWED_COMMANDS[number]);
}

// Bad - Blacklist approach (incomplete)
const BLOCKED = ["rm", "del"]; // Easy to bypass
```

### 2. Defense in Depth

Multiple validation layers:

```
Input
  │
  ├──► Schema Validation (Zod)
  │
  ├──► Type Validation (TypeScript)
  │
  ├──► Range Validation (min/max)
  │
  ├──► Format Validation (regex)
  │
  └──► Business Logic Validation
```

### 3. Fail Securely

Reject by default, accept explicitly:

```typescript
// Secure default
function validate(input: unknown): boolean {
  // Start with rejection
  if (!input) return false;
  
  // Explicit checks for acceptance
  if (typeof input !== "string") return false;
  if (input.length > MAX_LENGTH) return false;
  if (!SAFE_PATTERN.test(input)) return false;
  
  return true;
}
```

## Path Validation

### PathGuard Implementation

The `PathGuard` module prevents path traversal attacks and unauthorized file access.

```typescript
// src/security/path-guard.ts
export interface PathValidationResult {
  valid: boolean;
  fullPath: string;
  error?: string;
}

export async function validatePath(
  projectRoot: string,
  relativePath: string
): Promise<PathValidationResult>
```

### Security Checks

```
┌─────────────────────────────────────────────────────────────────┐
│                    Path Validation Steps                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Null Byte Check                                             │
│     └── Reject paths containing \\x00                            │
│                                                                  │
│  2. Path Resolution                                             │
│     └── Use realpath() to resolve symlinks                      │
│                                                                  │
│  3. Traversal Check                                             │
│     └── Verify resolved path is within project root             │
│                                                                  │
│  4. Prefix Collision Prevention                                 │
│     └── Check trailing separator: /project vs /project-evil     │
│                                                                  │
│  5. Sensitive File Blocklist                                    │
│     └── Check against BLOCKED_PATTERNS                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Blocked Patterns

```typescript
// src/security/path-guard.ts
const BLOCKED_PATTERNS: RegExp[] = [
  // Environment files
  /\\.env$/i,
  /\\.env\\.[a-z]+$/i,
  
  // Git credentials
  /\\.git[/\\\\]config$/i,
  /\\.git[/\\\\]credentials$/i,
  
  // Credential files
  /credentials\\.json$/i,
  /secrets?\\.json$/i,
  /secrets?\\.ya?ml$/i,
  
  // SSH keys
  /\\.ssh[/\\\\]/i,
  /\\.pem$/i,
  /\\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  
  // Keystores
  /\\.pfx$/i,
  /\\.p12$/i,
  /\\.keystore$/i,
  /\\.jks$/i,
  
  // Mobile credentials
  /google-services\\.json$/i,
  /GoogleService-Info\\.plist$/i,
  
  // npm config (may contain auth tokens)
  /\\.npmrc$/i,
  /\\.netrc$/i,
  
  // Dependencies
  /node_modules[/\\\\]/i,
];
```

### Attack Prevention

| Attack | Example | Prevention |
|--------|---------|------------|
| Path Traversal | `../../../etc/passwd` | `realpath()` resolution |
| Symlink Escape | `symlink -> /etc` | `realpath()` resolves target |
| Null Byte | `file.txt\\x00.jpg` | Null byte rejection |
| Prefix Collision | `/project-evil` vs `/project` | Trailing separator check |
| Case Bypass | `.ENV` vs `.env` | Case-insensitive matching |

### Usage Example

```typescript
import { validatePath } from "./security/path-guard.js";

async function safeFileOperation(projectRoot: string, userPath: string) {
  // Validate before any operation
  const result = await validatePath(projectRoot, userPath);
  
  if (!result.valid) {
    throw new Error(`Access denied: ${result.error}`);
  }
  
  // Safe to use result.fullPath
  const content = await readFile(result.fullPath);
  return content;
}
```

## Command Validation

### Shell Command Safety

The `ShellExecTool` implements multiple layers of command validation:

```typescript
// src/agents/tools/shell-exec.ts
const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){",           // Fork bomb
  "fork bomb",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "chmod -R 777 /",
  "chown -R",
  "wget|sh",        // Pipe to shell
  "curl|sh",
  "curl|bash",
  "wget|bash",
] as const;

const DANGEROUS_PIPE_PATTERNS = [
  /\\|\\s*sh\\b/,        // | sh
  /\\|\\s*bash\\b/,      // | bash
  /\\|\\s*zsh\\b/,       // | zsh
  /\\|\\s*rm\\b/,        // | rm
  />\\s*\\/dev\\/sd/,    // > /dev/sd
  />\\s*\\/dev\\/nvme/,  // > /dev/nvme
];
```

### Validation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                 Command Validation Flow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input: "git status"                                            │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 1. Check blocked commands           │                        │
│  │    "git status" not in BLOCKED      │                        │
│  └─────────────────────────────────────┘                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 2. Check dangerous pipe patterns   │                        │
│  │    No pipes in command              │                        │
│  └─────────────────────────────────────┘                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 3. Check read-only mode             │                        │
│  │    Read-write mode active           │                        │
│  └─────────────────────────────────────┘                        │
│       │                                                          │
│       ▼                                                          │
│   ┌──────────┐                                                  │
│   │  APPROVED │                                                  │
│   └──────────┘                                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
function checkCommandSafety(command: string): { safe: boolean; reason?: string } {
  const lower = command.toLowerCase().trim();

  // Check blocked commands
  for (const blocked of BLOCKED_COMMANDS) {
    if (lower.includes(blocked.toLowerCase())) {
      return { safe: false, reason: `blocked command: ${blocked}` };
    }
  }

  // Check pipe patterns
  for (const pattern of DANGEROUS_PIPE_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: "dangerous pipe pattern" };
    }
  }

  return { safe: true };
}
```

## Code Injection Prevention

### C# Identifier Validation

When generating C# code, validate all identifiers to prevent injection:

```typescript
// src/security/path-guard.ts
export function isValidCSharpIdentifier(
  name: string, 
  allowDots = false
): boolean {
  if (!name || name.length > 256) return false;

  const pattern = allowDots
    ? /^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$/
    : /^[A-Za-z_][A-Za-z0-9_]*$/;

  return pattern.test(name);
}

export function isValidCSharpType(typeName: string): boolean {
  if (!name || name.length > 256) return false;

  // Block characters that could inject code
  if (/[;{}()=]/.test(typeName)) return false;
  if (/[\\n\\r]/.test(typeName)) return false;

  return /^[A-Za-z_][A-Za-z0-9_<>, \\[\\].?]*$/.test(typeName);
}
```

### Injection Attack Prevention

| Attack Vector | Example | Prevention |
|---------------|---------|------------|
| Statement injection | `MyClass; DROP TABLE` | Block `;` character |
| Comment injection | `MyClass /* comment */` | Block `/*` pattern |
| Newline injection | `class\\n malicious()` | Block `\\n` character |
| Generic injection | `List<string>; evil` | Length + character validation |

### Usage in Code Generation

```typescript
import { isValidCSharpIdentifier } from "../security/path-guard.js";

function generateComponent(className: string) {
  // Validate before using in template
  if (!isValidCSharpIdentifier(className)) {
    throw new Error(`Invalid class name: ${className}`);
  }

  // Safe to use in template
  return `
public class ${className} : IComponent {
    // ...
}
`;
}
```

## Secret Sanitization

### Overview

The `SecretSanitizer` automatically detects and redacts sensitive information in output.

```typescript
// src/security/secret-sanitizer.ts
export interface SecretPattern {
  name: string;
  pattern: RegExp;
  redaction: string | ((match: string) => string);
}
```

### Detected Secret Types

```typescript
export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  // API Keys
  { name: "openai_api_key", pattern: /sk-[a-zA-Z0-9]{20,}/g, 
    redaction: "[REDACTED_OPENAI_KEY]" },
  { name: "github_token", pattern: /gh[pousr]_[a-zA-Z0-9]{20,}/g,
    redaction: "[REDACTED_GITHUB_TOKEN]" },
  { name: "slack_token", pattern: /xox[bpas]-[a-zA-Z0-9-]{10,}/g,
    redaction: "[REDACTED_SLACK_TOKEN]" },
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g,
    redaction: "[REDACTED_AWS_KEY]" },
  { name: "discord_token", pattern: /[MN][A-Za-z\\d]{20,}\\.[\\w-]{6,}\\.[\\w-]{20,}/g,
    redaction: "[REDACTED_DISCORD_TOKEN]" },
  
  // Auth tokens
  { name: "jwt_token", pattern: /eyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*/g,
    redaction: "[REDACTED_JWT]" },
  { name: "bearer_token", pattern: /Bearer\\s+[a-zA-Z0-9_\\-\\.]{20,}/gi,
    redaction: "Bearer [REDACTED]" },
  
  // Private keys
  { name: "private_key", 
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    redaction: "[REDACTED_PRIVATE_KEY]" },
  
  // Database URLs
  { name: "database_url",
    pattern: /(?:postgres|mysql|mongodb|redis):\\/\\/[^:]+:[^@]+@[^/\\s]+/gi,
    redaction: (match: string) => {
      const urlMatch = match.match(/^(\\w+:\\/\\/)[^:]+:[^@]+(@.+)$/);
      return urlMatch 
        ? `${urlMatch[1]}[REDACTED_CREDENTIALS]${urlMatch[2]}` 
        : "[REDACTED_DATABASE_URL]";
    }
  },
];
```

### Usage Example

```typescript
import { SecretSanitizer } from "./security/secret-sanitizer.js";

const sanitizer = new SecretSanitizer();

const unsafeOutput = `
Here is your config:
OPENAI_API_KEY=sk-abc123def456ghi789
DATABASE_URL=postgres://user:password@localhost/db
`;

const safeOutput = sanitizer.sanitize(unsafeOutput);
// Result:
// Here is your config:
// OPENAI_API_KEY=[REDACTED_OPENAI_KEY]
// DATABASE_URL=postgres://[REDACTED_CREDENTIALS]@localhost/db
```

### Output Truncation

Prevent log injection and excessive output:

```typescript
const MAX_OUTPUT_LENGTH = 8192;
const TRUNCATION_MARKER = "\\n... (truncated)";

if (result.length > MAX_OUTPUT_LENGTH) {
  result = result.substring(0, MAX_OUTPUT_LENGTH) + TRUNCATION_MARKER;
}
```

## Schema Validation

### Zod Schemas

Use Zod for runtime type validation:

```typescript
import { z } from "zod";

// Tool input schema
const FileWriteSchema = z.object({
  path: z.string()
    .min(1, "Path is required")
    .max(1024, "Path too long")
    .regex(/^[\\w\\-\\/.]+$/, "Invalid path characters"),
  content: z.string()
    .max(256 * 1024, "Content exceeds 256KB"),
});

// Validate input
const result = FileWriteSchema.safeParse(input);
if (!result.success) {
  return {
    content: `Validation error: ${result.error.message}`,
    isError: true,
  };
}
```

### Schema Validation Patterns

```typescript
// String validation
const SafeString = z.string()
  .min(1)
  .max(1000)
  .regex(/^[\\w\\s\\-_.]+$/)  // Whitelist characters
  .transform(s => s.trim());   // Normalize

// Number validation
const PortNumber = z.number()
  .int()
  .min(1)
  .max(65535);

// Enum validation
const AllowedCommand = z.enum(["build", "test", "clean"]);
```

## Best Practices

### 1. Validate Early

Validate input as soon as it's received:

```typescript
// Good - Validate immediately
async function handleMessage(message: IncomingMessage) {
  // Validate user first
  if (!auth.isUserAllowed(message.userId)) {
    return { error: "Unauthorized" };
  }
  
  // Then validate content
  const validated = MessageSchema.safeParse(message);
  if (!validated.success) {
    return { error: "Invalid message" };
  }
  
  // Now process
  return processMessage(validated.data);
}
```

### 2. Use Strong Typing

Leverage TypeScript for compile-time safety:

```typescript
// Define strict types
type ValidatedPath = {
  fullPath: string;
  relativePath: string;
};

// Function requires validated path
async function readFile(path: ValidatedPath): Promise<string>;

// Can't accidentally pass unvalidated string
readFile(userInput); // Type error!
```

### 3. Fail with Context

Provide helpful error messages:

```typescript
// Good
return {
  valid: false,
  error: "Path contains invalid characters: '..'
   
   Suggestion: Use relative paths from project root"
};

// Bad
return { valid: false };
```

### 4. Log Validation Failures

Track validation failures for security monitoring:

```typescript
if (!result.valid) {
  getLogger().warn("Validation failed", {
    type: "path_validation",
    input: userInput,
    reason: result.error,
    userId,
    timestamp: new Date().toISOString(),
  });
}
```

### 5. Test Validation Logic

Write comprehensive tests for validators:

```typescript
// path-guard.test.ts
describe("validatePath", () => {
  it("rejects path traversal", async () => {
    const result = await validatePath("/project", "../../../etc/passwd");
    expect(result.valid).toBe(false);
  });

  it("rejects null bytes", async () => {
    const result = await validatePath("/project", "file.txt\\x00.exe");
    expect(result.valid).toBe(false);
  });

  it("revents symlink escape", async () => {
    // Create symlink pointing outside project
    const result = await validatePath("/project", "symlink-to-etc/passwd");
    expect(result.valid).toBe(false);
  });
});
```

### 6. Keep Validators Updated

Regularly review and update validation rules:

- Monitor for new attack patterns
- Update blocklists as needed
- Review false positives/negatives
- Test edge cases

---

Last updated: 2026-03-02
