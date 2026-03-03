# Authorization

This document describes the Role-Based Access Control (RBAC) model and permission system in Strata Brain.

## Table of Contents

- [Overview](#overview)
- [RBAC Model](#rbac-model)
- [Permission System](#permission-system)
- [Read-Only Mode](#read-only-mode)
- [Diff/Merge Confirmation](#diffmerge-confirmation)
- [Implementation](#implementation)
- [Configuration](#configuration)
- [Best Practices](#best-practices)

## Overview

Strata Brain implements a multi-layered authorization system that controls access at various levels:

1. **Channel Level**: Which channels are enabled
2. **User Level**: Who can access the system
3. **Tool Level**: Which tools can be executed
4. **Operation Level**: Which specific operations are allowed

```
┌─────────────────────────────────────────────────────────────────┐
│                     Authorization Layers                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: Channel Access                                         │
│  ├── Telegram: User ID whitelist                                 │
│  ├── Discord: User/Role whitelist                                │
│  └── Slack: Workspace + User whitelist                           │
│                                                                  │
│  Layer 2: Global Mode                                            │
│  ├── Read-Only: All writes blocked                               │
│  └── Read-Write: Full access (with confirmations)                │
│                                                                  │
│  Layer 3: Tool Permissions                                       │
│  ├── Read Tools: file_read, code_search                          │
│  ├── Write Tools: file_write, file_edit                          │
│  ├── Dangerous Tools: shell_exec, git_push                       │
│  └── Blocked Tools: (none by default)                            │
│                                                                  │
│  Layer 4: Operation Confirmation                                 │
│  ├── Auto-approve: Safe, small changes                           │
│  ├── Require approval: Destructive/large changes                 │
│  └── Always confirm: All modifications                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## RBAC Model

### Role Definitions

Strata Brain supports implicit roles based on configuration:

| Role | Capabilities | Configuration |
|------|--------------|---------------|
| **Admin** | Full access, can modify settings | Listed in whitelist |
| **User** | Standard access with confirmations | Listed in whitelist |
| **Read-Only** | View-only access | READ_ONLY_MODE=true |
| **Blocked** | No access | Not in whitelist |

### Permission Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    Permission Hierarchy                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    Full Access                       │   │
│  │  ┌───────────────────────────────────────────────┐  │   │
│  │  │              Read-Write Mode                   │  │   │
│  │  │  ┌─────────────────────────────────────────┐  │  │   │
│  │  │  │         Confirmation Required           │  │  │   │
│  │  │  │  ┌───────────────────────────────┐     │  │  │   │
│  │  │  │  │       Read-Only Mode          │     │  │  │   │
│  │  │  │  │  ┌───────────────────────┐   │     │  │  │   │
│  │  │  │  │  │     No Access         │   │     │  │  │   │
│  │  │  │  │  └───────────────────────┘   │     │  │  │   │
│  │  │  │  └───────────────────────────────┘     │  │  │   │
│  │  │  └─────────────────────────────────────────┘  │  │   │
│  │  └───────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Discord-Specific RBAC

Discord supports both user and role-based authorization:

```typescript
// src/security/auth.ts
isDiscordUserAllowed(userId: string, userRoles?: string[]): boolean {
  // Check if user ID is explicitly allowed
  if (this.allowedDiscordUserIds.has(userId)) {
    return true;
  }

  // Check if user has an allowed role
  if (userRoles?.some(role => this.allowedDiscordRoleIds.has(role))) {
    return true;
  }

  return false;
}
```

#### Role Hierarchy Example

```
Discord Server
│
├── Role: @StrataAdmin (ID: 123456)
│   └── Full access to all operations
│
├── Role: @StrataUser (ID: 234567)
│   └── Standard access with confirmations
│
└── Role: @StrataReadOnly (ID: 345678)
    └── View-only access (enforced by mode)
```

## Permission System

### Tool Categories

Tools are categorized by their permission requirements:

```typescript
// src/security/read-only-guard.ts
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  // File operations
  "file_write", "file_edit", "file_delete", "file_rename", 
  "file_delete_directory",
  // Git operations
  "git_commit", "git_push", "git_branch", "git_stash", 
  "git_reset", "git_checkout", "git_merge", "git_rebase",
  // Shell & Code generation
  "shell_exec",
  "strata_create_module", "strata_create_component", 
  "strata_create_mediator", "strata_create_system",
  // .NET operations
  "dotnet_add_package", "dotnet_remove_package", "dotnet_new",
]);

const READ_TOOLS: ReadonlySet<string> = new Set([
  "file_read", "file_search", "file_list", "file_exists", "file_grep",
  "code_search", "code_find_references", "code_find_usages",
  "git_status", "git_log", "git_diff", "git_show",
  "dotnet_build", "dotnet_test", "dotnet_list_packages",
  "analyze_project", "analyze_code_quality", "strata_analyze_project",
  "memory_search", "memory_recall", "rag_search",
]);
```

### Permission Matrix

| Operation | Read-Only | Read-Write | Dangerous | Admin Only |
|-----------|-----------|------------|-----------|------------|
| `file_read` | ✅ | ✅ | ✅ | ✅ |
| `code_search` | ✅ | ✅ | ✅ | ✅ |
| `git_status` | ✅ | ✅ | ✅ | ✅ |
| `file_edit` | ❌ | ✅ (confirm) | ✅ (confirm) | ✅ |
| `file_write` | ❌ | ✅ (confirm) | ✅ (confirm) | ✅ |
| `git_commit` | ❌ | ✅ (confirm) | ✅ (confirm) | ✅ |
| `shell_exec` | ❌ | ⚠️ (confirm) | ⚠️ (confirm) | ✅ |
| `git_push` | ❌ | ⚠️ (confirm) | ⚠️ (confirm) | ✅ |
| `git_reset` | ❌ | ❌ | ⚠️ (confirm) | ✅ |

Legend:
- ✅ Allowed
- ❌ Blocked
- ⚠️ Requires confirmation

## Read-Only Mode

### Overview

Read-only mode is a global setting that disables all write operations. It's useful for:

- **Analysis deployments**: Safe exploration of codebases
- **Demo environments**: Show capabilities without risk
- **Incident response**: Investigate without making changes
- **Compliance**: Enforce separation of duties

### Implementation

```typescript
// src/security/read-only-guard.ts
export class ReadOnlyGuard {
  private readonly enabled: boolean;
  private readonly blockedTools: Set<string>;

  constructor(enabled: boolean, additionalBlockedTools: string[] = []) {
    this.enabled = enabled;
    this.blockedTools = new Set([...Array.from(WRITE_TOOLS), ...additionalBlockedTools]);
  }

  canExecute(toolName: string): boolean {
    return !this.enabled || !this.blockedTools.has(toolName);
  }

  check(toolName: string): ReadOnlyCheckResult {
    return checkReadOnlyBlock(toolName, this.enabled);
  }

  filterTools<T extends { name: string }>(tools: T[]): T[] {
    return filterToolsForReadOnly(tools, this.enabled);
  }
}
```

### User Experience

When read-only mode is active:

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠️ READ-ONLY MODE ACTIVE                                    │
│                                                              │
│  The following operations are disabled:                     │
│                                                              │
│  ❌ Creating, editing, or deleting files                    │
│  ❌ Executing shell commands                                │
│  ❌ Making git commits or pushing changes                   │
│  ❌ Generating new code                                     │
│                                                              │
│  Available operations:                                      │
│  ✅ Reading files and searching code                        │
│  ✅ Analyzing project structure                             │
│  ✅ Running builds and tests                                │
│  ✅ Searching memory and documentation                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Configuration

```bash
# Enable read-only mode
READ_ONLY_MODE=true

# Disable read-only mode (default)
READ_ONLY_MODE=false
```

## Diff/Merge Confirmation

### Overview

The Diff/Merge (DM) Policy provides user confirmation for file modifications. It implements a smart approval system based on change characteristics.

### Approval Levels

```typescript
// src/security/dm-policy.ts
export enum ApprovalLevel {
  ALWAYS = "always",           // Always require approval
  DESTRUCTIVE_ONLY = "destructive_only",  // Only for destructive ops
  SMART = "smart",             // Based on thresholds
  NEVER = "never",             // Auto-approve (use with caution)
}
```

### Smart Approval Logic

```
┌─────────────────────────────────────────────────────────────┐
│                  Smart Approval Flow                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Incoming Operation                                          │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────────────────────────┐                    │
│  │ Is it destructive?                  │                    │
│  │ (delete, shell with rm, etc.)       │                    │
│  └─────────────┬───────────────────────┘                    │
│                │                                             │
│           Yes  │        No                                   │
│                │                                             │
│                ▼                                             │
│  ┌─────────────────────────────────────┐                    │
│  │ Exceeds thresholds?                 │                    │
│  │ - File threshold: 3 files           │                    │
│  │ - Line threshold: 50 lines          │                    │
│  └─────────────┬───────────────────────┘                    │
│                │                                             │
│           Yes  │        No                                   │
│                │                                             │
│                ▼                                             │
│         ┌──────────┐    ┌──────────┐                        │
│         │ Require  │    │ Auto-    │                        │
│         │ Approval │    │ Approve  │                        │
│         └──────────┘    └──────────┘                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Configuration

```typescript
// Default configuration
const DEFAULT_CONFIG: DMPolicyConfig = {
  defaultLevel: ApprovalLevel.SMART,
  defaultTimeoutMs: 300_000,  // 5 minutes
  smartFileThreshold: 3,      // 3+ files require approval
  smartLineThreshold: 50,     // 50+ lines changed require approval
  maxPreviewLines: 50,
  allowEditing: true,
};
```

### User Confirmation Flow

```
┌─────────────────────────────────────────────────────────────┐
│                Confirmation Request UI                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ⚠️ Approval Required                                        │
│                                                              │
│  Operation: file_edit                                        │
│  File: Assets/Scripts/PlayerController.cs                    │
│                                                              │
│  Preview:                                                    │
│  ```diff                                                     │
│  - public float speed = 5f;                                  │
│  + public float speed = 10f;                                 │
│  ```                                                         │
│                                                              │
│  [✅ Approve]  [❌ Reject]  [📋 View Full]                   │
│                                                              │
│  _Timeout: 4:32 remaining_                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Implementation

### ReadOnlyGuard

```typescript
// src/security/read-only-guard.ts
export function checkReadOnlyBlock(
  toolName: string,
  readOnlyMode: boolean
): ReadOnlyCheckResult {
  if (!readOnlyMode) {
    return { allowed: true };
  }

  const normalizedName = toolName.toLowerCase().trim();

  if (WRITE_TOOLS.has(normalizedName)) {
    return {
      allowed: false,
      error: `Tool '${toolName}' is disabled in read-only mode.`,
      suggestion: SUGGESTIONS[normalizedName] ?? "Use read-only tools to explore the codebase.",
    };
  }

  return { allowed: true };
}
```

### DMPolicy Integration

```typescript
// src/security/dm-policy.ts
export class DMPolicy {
  async requestApproval(
    chatId: string,
    userId: string,
    diff: FileDiff | BatchDiff,
    operation: string,
    isDestructive = false
  ): Promise<ApprovalResult> {
    const prefs = this.getSessionPrefs(userId, chatId);

    // Check if approval is required based on level and thresholds
    if (!this.isApprovalRequired(prefs, diff, isDestructive)) {
      return { approved: true, action: "approve" };
    }

    // Send confirmation request to user
    return this.createConfirmation(chatId, userId, diff, operation);
  }
}
```

### Tool-Level Integration

```typescript
// Example: File write tool with authorization checks
async execute(input: Record<string, unknown>, context: ToolContext) {
  // Check 1: Read-only mode
  if (context.readOnly) {
    return {
      content: "Error: file writing is disabled in read-only mode",
      isError: true,
    };
  }

  // Check 2: Path validation
  const pathCheck = await validatePath(context.projectPath, relPath);
  if (!pathCheck.valid) {
    return { content: `Error: ${pathCheck.error}`, isError: true };
  }

  // Check 3: DM Policy confirmation (if required)
  // ... handled by orchestrator

  // Execute operation
  await writeFile(pathCheck.fullPath, content);
}
```

## Configuration

### Environment Variables

```bash
# Global Mode
READ_ONLY_MODE=false

# Confirmation Settings
REQUIRE_EDIT_CONFIRMATION=true

# DM Policy (future enhancement)
# DM_POLICY_LEVEL=smart
# DM_FILE_THRESHOLD=3
# DM_LINE_THRESHOLD=50
# DM_TIMEOUT_MS=300000
```

### Runtime Configuration

Some settings can be changed at runtime through admin commands:

```typescript
// Enable read-only mode at runtime
orchestrator.setReadOnlyMode(true);

// Check current mode
const isReadOnly = orchestrator.isReadOnlyMode();

// Get DM policy status
const pending = dmPolicy.getPendingConfirmations();
```

## Best Practices

### 1. Default to Restrictive

Start with restrictive settings and relax as needed:

```bash
# Recommended initial configuration
READ_ONLY_MODE=true
REQUIRE_EDIT_CONFIRMATION=true
# DM_POLICY_LEVEL=always  # Most restrictive
```

### 2. Layered Authorization

Combine multiple authorization controls:

```
User Access
    │
    ├──► Channel Whitelist (who)
    │
    ├──► Read-Only Mode (what globally)
    │
    ├──► Tool Permissions (what specifically)
    │
    └──► DM Confirmation (when in doubt)
```

### 3. Audit Authorization Decisions

Log all authorization decisions:

```typescript
getLogger().info("Authorization decision", {
  userId,
  tool: toolName,
  allowed: result.allowed,
  reason: result.reason,
  readOnlyMode: context.readOnly,
});
```

### 4. Session-Based Preferences

Store user preferences per session:

```typescript
// src/security/dm-policy.ts
getSessionPrefs(userId: string, chatId: string): SessionApprovalPrefs {
  const key = `${userId}:${chatId}`;
  let prefs = this.sessionPrefs.get(key);

  if (!prefs || this.isExpired(prefs)) {
    prefs = {
      userId,
      level: this.config.defaultLevel,
      // ... defaults
    };
    this.sessionPrefs.set(key, prefs);
  }

  return prefs;
}
```

### 5. Clear User Communication

Always explain why an operation was blocked:

```typescript
// Good
return {
  allowed: false,
  error: "Tool 'shell_exec' is disabled in read-only mode.",
  suggestion: "Use built-in read tools instead.",
};

// Bad
return { allowed: false };
```

---

Last updated: 2026-03-02
