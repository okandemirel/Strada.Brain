# Security Architecture

This document describes the security architecture of Strata Brain, including the threat model, security boundaries, and data flow diagrams.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Threat Model](#threat-model)
- [Security Boundaries](#security-boundaries)
- [Data Flow Diagrams](#data-flow-diagrams)
- [Security Layers](#security-layers)
- [Trust Boundaries](#trust-boundaries)
- [Attack Surface Analysis](#attack-surface-analysis)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Strata Brain Architecture                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Telegram   │  │   Discord   │  │    Slack    │  │  WhatsApp   │        │
│  │   Channel   │  │   Channel   │  │   Channel   │  │   Channel   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│         └────────────────┴────────────────┴────────────────┘               │
│                                   │                                        │
│                         ┌─────────┴─────────┐                              │
│                         │  Auth Manager     │                              │
│                         │  (Authentication) │                              │
│                         └─────────┬─────────┘                              │
│                                   │                                        │
│                    ┌──────────────┼──────────────┐                         │
│                    │              │              │                         │
│         ┌──────────┴───┐ ┌────────┴────────┐ ┌──┴──────────┐             │
│         │ Rate Limiter │ │  DMPolicy       │ │  Read-Only  │             │
│         │              │ │ (Confirmation)  │ │    Guard    │             │
│         └──────────────┘ └────────┬────────┘ └─────────────┘             │
│                                   │                                        │
│                         ┌─────────┴─────────┐                              │
│                         │   Orchestrator    │                              │
│                         │   (Core Router)   │                              │
│                         └─────────┬─────────┘                              │
│                                   │                                        │
│         ┌─────────────────────────┼─────────────────────────┐              │
│         │                         │                         │              │
│  ┌──────┴──────┐        ┌─────────┴─────────┐    ┌──────────┴──────┐      │
│  │ AI Provider │        │   Tool Registry   │    │ Memory System   │      │
│  │   (LLM)     │        │                   │    │                 │      │
│  └─────────────┘        └─────────┬─────────┘    └─────────────────┘      │
│                                   │                                        │
│                    ┌──────────────┼──────────────┐                         │
│                    │              │              │                         │
│         ┌──────────┴───┐ ┌────────┴────────┐ ┌──┴──────────┐             │
│         │ File Tools   │ │  Shell Tool     │ │  Browser    │             │
│         │ (Path Guard) │ │ (Command Block) │ │  (URL Val)  │             │
│         └──────────────┘ └─────────────────┘ └─────────────┘             │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     Security Subsystem                              │   │
│  │  ┌──────────┐ ┌────────────┐ ┌──────────────┐ ┌─────────────────┐  │   │
│  │  │Path Guard│ │Secret San. │ │ Rate Limiter │ │ Browser Security│  │   │
│  │  └──────────┘ └────────────┘ └──────────────┘ └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Threat Model

### STRIDE Analysis

| Threat | Component | Risk Level | Mitigation |
|--------|-----------|------------|------------|
| **Spoofing** | Authentication | Medium | User ID validation, token verification |
| **Tampering** | File Operations | High | Path validation, diff confirmation |
| **Repudiation** | Audit Logging | Low | Comprehensive logging |
| **Information Disclosure** | Secret Leakage | High | Secret sanitization, path restrictions |
| **Denial of Service** | Rate Limiting | Medium | Multi-tier rate limiting |
| **Elevation of Privilege** | Authorization | High | RBAC, read-only mode |

### Threat Actors

```
┌────────────────────────────────────────────────────────────────┐
│                      Threat Actors                              │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────┐                                            │
│  │ External Attacker│                                          │
│  │ (No system access)│                                         │
│  └───────┬────────┘                                            │
│          │  ▶ Unauthorized bot access                          │
│          │  ▶ Social engineering                               │
│          │  ▶ Token theft                                      │
│          ▼                                                     │
│  ┌────────────────┐                                            │
│  │  Malicious User │                                           │
│  │  (Authorized but│                                           │
│  │   harmful intent)│                                          │
│  └───────┬────────┘                                            │
│          │  ▶ Data exfiltration                                │
│          │  ▶ Unauthorized modifications                       │
│          │  ▶ Resource exhaustion                              │
│          ▼                                                     │
│  ┌────────────────┐                                            │
│  │  Compromised    │                                           │
│  │  Channel Token  │                                           │
│  └───────┬────────┘                                            │
│          │  ▶ Impersonation                                    │
│          │  ▶ Unauthorized access via stolen tokens            │
│          ▼                                                     │
│  ┌────────────────┐                                            │
│  │  Insider Threat │                                           │
│  │  (Admin/Operator)│                                          │
│  └────────────────┘                                            │
│           ▶ System compromise                                  │
│           ▶ Configuration tampering                            │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Attack Scenarios

#### Scenario 1: Path Traversal Attack

```
Attacker Input: "../../../etc/passwd"
                    │
                    ▼
┌─────────────────────────────────────┐
│ PathGuard.validatePath()            │
│ 1. Resolve real path                │
│ 2. Check if within project root     │
│ 3. Validate against blocklist       │
└─────────────────────────────────────┘
                    │
                    ▼
           ┌──────────────┐
           │   BLOCKED    │
           │ Access denied│
           └──────────────┘
```

#### Scenario 2: Command Injection

```
Attacker Input: "; rm -rf /"
                    │
                    ▼
┌─────────────────────────────────────┐
│ ShellExecTool.checkCommandSafety()  │
│ 1. Check against blocked patterns   │
│ 2. Validate pipe sequences          │
│ 3. Detect dangerous patterns        │
└─────────────────────────────────────┘
                    │
                    ▼
           ┌──────────────┐
           │   BLOCKED    │
           │ Command not  │
           │ permitted    │
           └──────────────┘
```

#### Scenario 3: Secret Leakage

```
AI Response contains:
"Here's the API key: sk-abc123..."
                    │
                    ▼
┌─────────────────────────────────────┐
│ SecretSanitizer.sanitize()          │
│ 1. Pattern matching for secrets     │
│ 2. Redaction of sensitive data      │
│ 3. Statistics collection            │
└─────────────────────────────────────┘
                    │
                    ▼
User sees:
"Here's the API key: [REDACTED_OPENAI_KEY]"
```

## Security Boundaries

### Boundary 1: Network Perimeter

```
┌───────────────────────────────────────────────────────────────┐
│                      Network Perimeter                         │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   External         Firewall          DMZ            Internal  │
│   Network            │                │               Network │
│       │              │                │                  │    │
│       │              ▼                ▼                  │    │
│       │         ┌─────────┐     ┌──────────┐            │    │
│       │         │  WAF    │────▶│  Bot     │            │    │
│       │         │         │     │  Servers │            │    │
│       │         └─────────┘     └────┬─────┘            │    │
│       │                              │                  │    │
│       │                         ┌────┴─────┐            │    │
│       │                         │  Brain   │            │    │
│       │                         │  Core    │            │    │
│       │                         └──────────┘            │    │
│                                                                │
│   Controls:                                                   │
│   - TLS 1.3 encryption                                        │
│   - IP allowlisting (optional)                                │
│   - Rate limiting at edge                                     │
│   - DDoS protection                                           │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

### Boundary 2: Channel Authentication

```
┌───────────────────────────────────────────────────────────────┐
│                   Channel Authentication                       │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   Incoming Message                                              │
│        │                                                        │
│        ▼                                                        │
│   ┌─────────────────────────────────────┐                      │
│   │ AuthManager.authenticate()          │                      │
│   │                                     │                      │
│   │  Telegram:  Check user ID whitelist │                      │
│   │  Discord:   Check user/role         │                      │
│   │  Slack:     Check workspace + user  │                      │
│   └─────────────────────────────────────┘                      │
│        │                                                        │
│        ├── Unauthorized ──▶ Log & Reject                       │
│        │                                                        │
│        └── Authorized ────▶ Process Message                    │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

### Boundary 3: File System

```
┌───────────────────────────────────────────────────────────────┐
│                    File System Boundary                        │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   Tool Request                                                  │
│        │                                                        │
│        ▼                                                        │
│   ┌─────────────────────────────────────┐                      │
│   │ PathGuard.validatePath()            │                      │
│   │                                     │                      │
│   │  1. Resolve symlinks (realpath)     │                      │
│   │  2. Check project root containment  │                      │
│   │  3. Validate against blocklist      │                      │
│   │  4. Check read-only mode            │                      │
│   └─────────────────────────────────────┘                      │
│        │                                                        │
│        ├── Invalid ───────▶ Reject with error                  │
│        │                                                        │
│        └── Valid ─────────▶ Execute operation                  │
│                                                                │
│   Blocked Patterns:                                            │
│   - .env files                                                 │
│   - .git/config                                                │
│   - SSH keys (*.pem, id_rsa)                                   │
│   - Credentials files                                          │
│   - node_modules                                               │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

## Data Flow Diagrams

### DFD Level 0: Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌──────────┐      ┌──────────────┐      ┌──────────┐                  │
│  │ Telegram │      │              │      │ Discord  │                  │
│  │  User    │◄────►│              │◄────►│  User    │                  │
│  └──────────┘      │              │      └──────────┘                  │
│                    │   Strata     │                                    │
│  ┌──────────┐      │    Brain     │      ┌──────────┐                  │
│  │  Slack   │      │   System     │      │WhatsApp  │                  │
│  │  User    │◄────►│              │◄────►│  User    │                  │
│  └──────────┘      │              │      └──────────┘                  │
│                    │              │                                    │
│  ┌──────────┐      │              │      ┌──────────┐                  │
│  │ Unity    │◄────►│              │◄────►│  AI      │                  │
│  │ Project  │      │              │      │Provider  │                  │
│  └──────────┘      └──────────────┘      └──────────┘                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### DFD Level 1: System Decomposition

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DFD Level 1                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────┐                                                            │
│  │ Channel │                                                            │
│  │  Input  │────────┐                                                   │
│  └─────────┘        │                                                   │
│                     ▼                                                   │
│           ┌─────────────────┐                                           │
│           │  1.0 Authenticate│                                          │
│           │   (AuthManager)  │                                          │
│           └────────┬────────┘                                           │
│                    │                                                    │
│              Auth  │ OK                                                 │
│                    ▼                                                    │
│           ┌─────────────────┐        ┌──────────────┐                  │
│           │  2.0 Rate Limit │───────►│ Rate Limit   │                  │
│           │   Check         │        │ Database     │                  │
│           └────────┬────────┘        └──────────────┘                  │
│                    │                                                    │
│               Pass │ Check                                             │
│                    ▼                                                    │
│           ┌─────────────────┐                                           │
│           │  3.0 Parse &    │                                           │
│           │   Route Message │                                           │
│           └────────┬────────┘                                           │
│                    │                                                    │
│         ┌─────────┼─────────┐                                           │
│         │         │         │                                           │
│         ▼         ▼         ▼                                           │
│    ┌────────┐ ┌────────┐ ┌────────┐                                    │
│    │4.0 Tool│ │4.1 AI  │ │4.2 Mem │                                    │
│    │Process │ │Process │ │ Process│                                    │
│    └────┬───┘ └────┬───┘ └───┬────┘                                    │
│         │          │         │                                          │
│         └──────────┼─────────┘                                          │
│                    ▼                                                    │
│           ┌─────────────────┐                                           │
│           │  5.0 Format &   │                                           │
│           │   Send Response │                                           │
│           └─────────────────┘                                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Security Layers

### Layer 1: Authentication (Who are you?)

```typescript
// src/security/auth.ts
class AuthManager {
  // Telegram: Whitelist user IDs
  isTelegramUserAllowed(userId: number): boolean
  
  // Discord: Whitelist users or roles
  isDiscordUserAllowed(userId: string, roles?: string[]): boolean
  
  // Slack: Whitelist workspaces and users
  isSlackAllowed(userId: string, workspaceId?: string): boolean
}
```

**Responsibilities:**
- Validate user identity
- Check channel-specific permissions
- Log unauthorized access attempts

### Layer 2: Authorization (What can you do?)

```typescript
// src/security/read-only-guard.ts
class ReadOnlyGuard {
  canExecute(toolName: string): boolean
  filterTools<T>(tools: T[]): T[]
}

// src/security/dm-policy.ts
class DMPolicy {
  requestApproval(diff: FileDiff): Promise<ApprovalResult>
  isDestructiveOperation(tool: string): boolean
}
```

**Responsibilities:**
- Enforce read-only mode
- Require confirmation for destructive ops
- Manage operation approvals

### Layer 3: Input Validation (Is input safe?)

```typescript
// src/security/path-guard.ts
async function validatePath(
  projectRoot: string, 
  relativePath: string
): Promise<PathValidationResult>

// src/agents/tools/shell-exec.ts
function checkCommandSafety(command: string): SafetyResult

// src/security/secret-sanitizer.ts
function sanitizeSecrets(content: string): string
```

**Responsibilities:**
- Prevent path traversal
- Block dangerous commands
- Sanitize secrets in output

### Layer 4: Resource Protection (Are limits respected?)

```typescript
// src/security/rate-limiter.ts
class RateLimiter {
  checkMessageRate(userId: string): RateLimitResult
  recordTokenUsage(inputTokens: number, outputTokens: number, provider: string)
  getSnapshot(): QuotaSnapshot
}

// src/security/browser-security.ts
class BrowserSessionManager {
  acquireSession(sessionId: string): boolean
  releaseSession(sessionId: string): void
}

function validateUrlWithConfig(
  url: string,
  config?: Partial<BrowserSecurityConfig>
): UrlValidationResult
```

**Responsibilities:**
- Rate limit requests
- Enforce budget limits
- Manage concurrent sessions

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Trust Boundaries                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Untrusted Zone          Semi-Trusted         Trusted Zone              │
│  (Internet)                 Zone              (Internal)                │
│                                                                         │
│  ┌─────────┐            ┌─────────┐          ┌─────────┐               │
│  │External │            │ Channel │          │  Core   │               │
│  │  Users  │───────────►│Adapters │─────────►│ Engine  │               │
│  └─────────┘            └─────────┘          └────┬────┘               │
│        │                                           │                    │
│        │                                           │                    │
│        ▼                                           ▼                    │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │                     Security Controls                         │      │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐  │      │
│  │  │   Auth     │ │   Rate     │ │   Input    │ │  Output  │  │      │
│  │  │  Manager   │ │   Limiter  │ │ Validation │ │ Sanitizer│  │      │
│  │  └────────────┘ └────────────┘ └────────────┘ └──────────┘  │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                                                                         │
│  Trust Level:  0 ───────────────────────────────────► 10               │
│               (None)                                (Full)             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Attack Surface Analysis

### Entry Points

| Entry Point | Risk Level | Controls |
|-------------|------------|----------|
| Telegram Webhook | Medium | Token auth, user whitelist |
| Discord Gateway | Medium | Bot token, user/role checks |
| Slack Events API | Medium | Signing secret, workspace whitelist |
| HTTP API | High | API keys, rate limiting |
| File System | High | Path validation, read-only mode |
| Shell Execution | Critical | Command whitelist, timeout |
| Browser Automation | Medium | URL validation, sandbox |

### Data Stores

| Store | Sensitivity | Controls |
|-------|-------------|----------|
| Environment Variables | Critical | File permissions, no logging |
| Memory Database | Medium | Path validation, encryption |
| Unity Project | High | Path restrictions, backups |
| Log Files | Medium | Secret sanitization, rotation |

---

## References

- [OWASP Threat Modeling](https://owasp.org/www-community/Application_Threat_Modeling)
- [STRIDE Model](https://docs.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)
- [CWE Top 25](https://cwe.mitre.org/top25/)
