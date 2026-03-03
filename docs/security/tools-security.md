# Tools Security

This document describes security measures for file operations, shell execution, and browser automation tools in Strata Brain.

## Table of Contents

- [Overview](#overview)
- [File Operation Security](#file-operation-security)
- [Shell Execution Security](#shell-execution-security)
- [Browser Automation Security](#browser-automation-security)
- [Tool Registry Security](#tool-registry-security)
- [Best Practices](#best-practices)

## Overview

Strata Brain provides powerful tools that interact with the file system, execute shell commands, and automate browsers. Each tool category has specific security controls to prevent abuse and protect the system.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Tools Security Model                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Security Controls                      │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │  │
│  │  │ Read-Only  │  │ Path Guard │  │ Command Validation │  │  │
│  │  │    Mode    │  │            │  │                    │  │  │
│  │  └─────┬──────┘  └─────┬──────┘  └─────────┬──────────┘  │  │
│  │        │               │                   │              │  │
│  │        └───────────────┼───────────────────┘              │  │
│  │                        │                                  │  │
│  │                        ▼                                  │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │                  Tool Registry                       │ │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │ │  │
│  │  │  │  File    │  │  Shell   │  │     Browser      │  │ │  │
│  │  │  │  Tools   │  │  Tool    │  │     Tools        │  │ │  │
│  │  │  └──────────┘  └──────────┘  └──────────────────┘  │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## File Operation Security

### File Tools Overview

| Tool | Operation | Security Controls |
|------|-----------|-------------------|
| `file_read` | Read file contents | Path validation |
| `file_write` | Create/overwrite file | Path validation, size limit, read-only mode |
| `file_edit` | Modify file contents | Path validation, read-only mode, diff confirmation |
| `file_list` | List directory | Path validation |
| `file_delete` | Delete file | Path validation, read-only mode, confirmation |
| `file_search` | Search files | Path validation |

### Path Validation

All file operations use the `PathGuard` system:

```typescript
// src/agents/tools/file-write.ts
async execute(input: Record<string, unknown>, context: ToolContext) {
  const relPath = String(input["path"] ?? "");
  
  // Validate path before any operation
  const pathCheck = await validatePath(context.projectRoot, relPath);
  if (!pathCheck.valid) {
    return { content: `Error: ${pathCheck.error}`, isError: true };
  }
  
  // Safe to use pathCheck.fullPath
  await writeFile(pathCheck.fullPath, content);
}
```

### File Write Protections

```typescript
// src/agents/tools/file-write.ts
const MAX_WRITE_SIZE = 256 * 1024; // 256KB max

async execute(input: Record<string, unknown>, context: ToolContext) {
  // Check read-only mode
  if (context.readOnly) {
    return {
      content: "Error: file writing is disabled in read-only mode",
      isError: true,
    };
  }

  const content = String(input["content"] ?? "");
  const byteLength = Buffer.byteLength(content, "utf-8");
  
  // Size limit check
  if (byteLength > MAX_WRITE_SIZE) {
    return {
      content: `Error: content too large (${Math.round(byteLength / 1024)}KB). Max: ${MAX_WRITE_SIZE / 1024}KB`,
      isError: true,
    };
  }

  // Path validation...
}
```

### Sensitive File Protection

```typescript
// src/security/path-guard.ts
const BLOCKED_PATTERNS: RegExp[] = [
  // Environment files
  /\\.env$/i,
  /\\.env\\.[a-z]+$/i,
  
  // Git credentials
  /\\.git[/\\\\]config$/i,
  /\\.git[/\\\\]credentials$/i,
  
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
];
```

### File Edit Security

File edits require confirmation through the DM Policy:

```
┌─────────────────────────────────────────────────────────────────┐
│                    File Edit Flow                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Request: "Edit PlayerController.cs"                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 1. Validate path                    │                        │
│  └─────────────────────────────────────┘                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 2. Read current content             │                        │
│  └─────────────────────────────────────┘                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 3. Generate diff                    │                        │
│  └─────────────────────────────────────┘                        │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────┐                        │
│  │ 4. Request confirmation             │                        │
│  │    (if required by DM policy)       │                        │
│  └─────────────┬───────────────────────┘                        │
│                │                                                 │
│       Approved │        Rejected                                 │
│                │                                                 │
│                ▼                                                 │
│         ┌──────────┐    ┌──────────┐                            │
│         │ Apply    │    │ Cancel   │                            │
│         │ Changes  │    │ Operation│                            │
│         └──────────┘    └──────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Shell Execution Security

### ShellExecTool Overview

The `shell_exec` tool allows running shell commands with strict security controls.

### Blocked Commands

```typescript
// src/agents/tools/shell-exec.ts
const BLOCKED_COMMANDS = [
  // Filesystem destruction
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  
  // Fork bombs
  ":(){",
  "fork bomb",
  
  // System shutdown
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  
  // Permission changes
  "chmod -R 777 /",
  "chown -R",
  
  // Pipe to shell attacks
  "wget|sh",
  "curl|sh",
  "curl|bash",
  "wget|bash",
] as const;
```

### Dangerous Patterns

```typescript
const DANGEROUS_PIPE_PATTERNS = [
  /\\|\\s*sh\\b/,        // Pipe to sh
  /\\|\\s*bash\\b/,      // Pipe to bash
  /\\|\\s*zsh\\b/,       // Pipe to zsh
  /\\|\\s*rm\\b/,        // Pipe to rm
  />\\s*\\/dev\\/sd/,    // Write to block device
  />\\s*\\/dev\\/nvme/,  // Write to NVMe
];
```

### Implementation

```typescript
// src/agents/tools/shell-exec.ts
async execute(input: Record<string, unknown>, context: ToolContext) {
  // Check read-only mode
  if (context.readOnly) {
    return {
      content: "Error: shell execution is disabled in read-only mode",
      isError: true,
    };
  }

  const command = String(input["command"] ?? "").trim();
  
  // Validate command safety
  const safety = checkCommandSafety(command);
  if (!safety.safe) {
    return {
      content: `Error: command blocked for safety — ${safety.reason}`,
      isError: true,
    };
  }

  // Validate working directory
  const relWd = String(input["working_directory"] ?? "");
  if (relWd) {
    const pathCheck = await validatePath(context.projectPath, relWd);
    if (!pathCheck.valid) {
      return {
        content: "Error: working directory must be within the project",
        isError: true,
      };
    }
  }

  // Execute with timeout
  const timeoutMs = Math.min(
    Math.max(1000, Number(input["timeout_ms"] ?? 30000)),
    300000 // Max 5 minutes
  );

  return runProcess({
    command: "/bin/bash",
    args: ["-c", command],
    cwd,
    timeoutMs,
  });
}
```

### Timeout Protection

```typescript
const DEFAULT_TIMEOUT_MS = 30_000;  // 30 seconds
const MAX_TIMEOUT_MS = 300_000;      // 5 minutes

// Kill process if it exceeds timeout
const result = await runProcess({
  command: "/bin/bash",
  args: ["-c", command],
  timeoutMs,
});

if (result.timedOut) {
  return {
    content: "⚠ Command timed out and was killed",
    isError: true,
  };
}
```

## Browser Automation Security

### Overview

The browser automation tool uses Playwright with strict security controls to prevent access to internal systems and malicious websites.

### URL Validation

```typescript
// src/security/browser-security.ts
export interface BrowserSecurityConfig {
  allowedUrlPatterns: string[];
  blockedUrlPatterns: string[];
  blockLocalhost: boolean;
  blockFileProtocol: boolean;
  blockDataProtocol: boolean;
  blockJavascriptProtocol: boolean;
  maxNavigationTimeMs: number;
  maxScreenshotSizeMb: number;
  maxDownloadSizeMb: number;
  maxConcurrentSessions: number;
  maxOperationsPerMinute: number;
}
```

### Default Security Configuration

```typescript
export const DEFAULT_SECURITY_CONFIG: BrowserSecurityConfig = {
  allowedUrlPatterns: [],
  blockedUrlPatterns: [
    // Admin panels
    "\\/admin",
    "\\/wp-admin",
    "\\/phpmyadmin",
    "\\/server-status",
    
    // Internal paths
    "\\.git\\/",
    "\\.env",
    "\\.ssh\\/",
    "\\/etc\\/",
    "\\/proc\\/",
    "\\/sys\\/",
  ],
  blockLocalhost: true,
  blockFileProtocol: true,
  blockDataProtocol: true,
  blockJavascriptProtocol: true,
  maxNavigationTimeMs: 30000,
  maxScreenshotSizeMb: 10,
  maxDownloadSizeMb: 50,
  maxConcurrentSessions: 5,
  maxOperationsPerMinute: 60,
};
```

### URL Validation Implementation

```typescript
export function validateUrlWithConfig(
  url: string,
  config: Partial<BrowserSecurityConfig> = {}
): UrlValidationResult {
  const mergedConfig = { ...DEFAULT_SECURITY_CONFIG, ...config };

  try {
    const parsedUrl = new URL(url);

    // Protocol checks
    if (mergedConfig.blockFileProtocol && parsedUrl.protocol === "file:") {
      return { valid: false, reason: "file:// protocol is blocked" };
    }

    if (mergedConfig.blockDataProtocol && parsedUrl.protocol === "data:") {
      return { valid: false, reason: "data:// protocol is blocked" };
    }

    if (mergedConfig.blockJavascriptProtocol && parsedUrl.protocol === "javascript:") {
      return { valid: false, reason: "javascript:// protocol is blocked" };
    }

    // Localhost check
    if (mergedConfig.blockLocalhost) {
      const hostname = parsedUrl.hostname.toLowerCase();
      
      if (hostname === "localhost" || 
          hostname === "127.0.0.1" ||
          hostname.endsWith(".local")) {
        return { valid: false, reason: "Localhost access is blocked" };
      }

      // Private IP ranges
      if (isPrivateIp(hostname)) {
        return { valid: false, reason: "Private IP range access is blocked" };
      }
    }

    // Pattern checks...

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: "Invalid URL" };
  }
}
```

### Private IP Detection

```typescript
function isPrivateIp(ip: string): boolean {
  // IPv4 private ranges
  const privateRanges = [
    /^10\\./,                                    // 10.0.0.0/8
    /^172\\.(1[6-9]|2[0-9]|3[01])\\./,         // 172.16.0.0/12
    /^192\\.168\\./,                            // 192.168.0.0/16
    /^169\\.254\\./,                            // Link-local
    /^127\\./,                                  // Loopback
  ];

  for (const range of privateRanges) {
    if (range.test(ip)) return true;
  }

  // IPv6
  if (ip === "::1" || 
      ip.startsWith("fc") || 
      ip.startsWith("fd") ||
      ip.startsWith("fe80:")) {
    return true;
  }

  return false;
}
```

### Session Management

```typescript
// src/security/browser-security.ts
export class BrowserSessionManager {
  private readonly maxConcurrentSessions: number;
  private activeSessions = new Set<string>();

  acquireSession(sessionId: string): boolean {
    if (this.activeSessions.has(sessionId)) {
      return true; // Already acquired
    }

    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      return false; // Max sessions reached
    }

    this.activeSessions.add(sessionId);
    return true;
  }

  releaseSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }
}
```

### Rate Limiting

```typescript
export class BrowserRateLimiter {
  private readonly maxOperationsPerMinute: number;
  private readonly sessions = new Map<string, RateLimitEntry>();

  checkLimit(sessionId: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { timestamps: [] };
      this.sessions.set(sessionId, entry);
    }

    // Clean old timestamps
    entry.timestamps = entry.timestamps.filter(t => t > oneMinuteAgo);

    // Check limit
    if (entry.timestamps.length >= this.maxOperationsPerMinute) {
      const oldest = entry.timestamps[0]!;
      return { 
        allowed: false, 
        retryAfterMs: oldest + 60_000 - now 
      };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }
}
```

## Tool Registry Security

### Tool Registration

Tools are registered in a central registry with their security metadata:

```typescript
// src/core/tool-registry.ts
interface ToolMetadata {
  name: string;
  category: "read" | "write" | "dangerous";
  requiresConfirmation: boolean;
  readOnlyCompatible: boolean;
}

const toolRegistry = new Map<string, ToolMetadata>([
  ["file_read", { category: "read", requiresConfirmation: false, readOnlyCompatible: true }],
  ["file_write", { category: "write", requiresConfirmation: true, readOnlyCompatible: false }],
  ["shell_exec", { category: "dangerous", requiresConfirmation: true, readOnlyCompatible: false }],
]);
```

### Tool Filtering

```typescript
// Filter tools based on mode
function getAvailableTools(readOnlyMode: boolean): ITool[] {
  if (!readOnlyMode) {
    return allTools;
  }
  
  return allTools.filter(tool => {
    const metadata = toolRegistry.get(tool.name);
    return metadata?.readOnlyCompatible ?? false;
  });
}
```

## Best Practices

### 1. Principle of Least Privilege

Grant minimal necessary permissions:

```typescript
// Good - Limited scope
async function safeFileRead(projectPath: string, userPath: string) {
  const result = await validatePath(projectPath, userPath);
  if (!result.valid) {
    throw new Error(`Access denied: ${result.error}`);
  }
  return readFile(result.fullPath);
}

// Bad - Unrestricted access
async function unsafeFileRead(userPath: string) {
  return readFile(userPath); // No validation!
}
```

### 2. Defense in Depth

Multiple security layers:

```
Shell Command
    │
    ├──► Read-Only Mode Check
    │
    ├──► Blocked Command Check
    │
    ├──► Dangerous Pattern Check
    │
    ├──► Working Directory Validation
    │
    └──► Timeout Protection
```

### 3. Clear Error Messages

Inform users why operations were blocked:

```typescript
return {
  content: [
    "❌ Command blocked for safety",
    "",
    "Reason: Attempted to use 'rm -rf /'",
    "",
    "💡 Use 'file_delete' for safe file removal",
  ].join("\\n"),
  isError: true,
};
```

### 4. Audit Logging

Log all security-relevant events:

```typescript
getLogger().info("Tool execution", {
  tool: toolName,
  userId,
  input: sanitizeSecrets(JSON.stringify(input)),
  allowed: result.allowed,
  reason: result.reason,
});
```

### 5. Resource Limits

Always enforce limits:

```typescript
// Time limits
const timeoutMs = Math.min(userTimeout, MAX_TIMEOUT_MS);

// Size limits
if (content.length > MAX_SIZE) {
  return { error: "Content too large" };
}

// Count limits
if (operations.length > MAX_OPERATIONS) {
  return { error: "Too many operations" };
}
```

---

Last updated: 2026-03-02
