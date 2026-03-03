# Incident Response Plan

This document outlines the incident response procedures for security incidents in Strata Brain deployments.

## Table of Contents

- [Overview](#overview)
- [Incident Severity Levels](#incident-severity-levels)
- [Response Team](#response-team)
- [Response Procedures](#response-procedures)
- [Incident Types](#incident-types)
- [Recovery Procedures](#recovery-procedures)
- [Post-Incident Activities](#post-incident-activities)
- [Communication Plan](#communication-plan)

## Overview

This Incident Response Plan (IRP) provides structured procedures for detecting, responding to, and recovering from security incidents affecting Strata Brain.

```
┌─────────────────────────────────────────────────────────────────┐
│                 Incident Response Lifecycle                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐      │
│  │ Prepare │───►│ Detect  │───►│ Respond │───►│ Recover │      │
│  │         │    │         │    │         │    │         │      │
│  └─────────┘    └─────────┘    └────┬────┘    └────┬────┘      │
│       ▲                             │              │            │
│       │                             ▼              ▼            │
│       │                        ┌─────────────────────────┐      │
│       │                        │    Post-Incident        │      │
│       └────────────────────────│    (Learn & Improve)    │      │
│                                └─────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Incident Severity Levels

| Level | Description | Examples | Response Time | Resolution Target |
|-------|-------------|----------|---------------|-------------------|
| **P1 - Critical** | System compromise, data breach | Unauthorized admin access, token leak | 15 minutes | 4 hours |
| **P2 - High** | Significant security impact | Rate limit bypass, unauthorized file access | 1 hour | 24 hours |
| **P3 - Medium** | Limited security impact | Failed auth attempts, configuration issues | 4 hours | 72 hours |
| **P4 - Low** | Minor security concern | Log anomalies, policy violations | 24 hours | 7 days |

## Response Team

### Roles and Responsibilities

| Role | Responsibility | Contact |
|------|---------------|---------|
| **Incident Commander** | Overall coordination, decision making | Primary: admin@company.com |
| **Security Lead** | Technical investigation, containment | Primary: security@company.com |
| **Operations Lead** | System recovery, infrastructure | Primary: ops@company.com |
| **Communications Lead** | Internal/external communication | Primary: comms@company.com |

### Escalation Path

```
Level 1: On-call Engineer (15 min)
    │
    ├── Cannot resolve
    │
    ▼
Level 2: Security Lead (30 min)
    │
    ├── P1/P2 incident
    │
    ▼
Level 3: Incident Commander (1 hour)
    │
    ├── External assistance needed
    │
    ▼
Level 4: External Security Firm
```

## Response Procedures

### Phase 1: Detection

#### Monitoring Alerts

```typescript
// Automated detection triggers
const SECURITY_ALERTS = {
  // Unauthorized access
  unauthorizedAccess: (event) => {
    if (event.count > 5) return "P2";
    return "P3";
  },
  
  // Rate limit exceeded
  rateLimitExceeded: (event) => {
    if (event.bypassAttempt) return "P2";
    return "P3";
  },
  
  // Blocked command execution
  blockedCommand: (event) => {
    if (event.command.includes("rm -rf")) return "P2";
    return "P3";
  },
  
  // Token leak detection
  tokenLeak: () => "P1",
  
  // Path traversal attempt
  pathTraversal: (event) => {
    if (event.success) return "P1";
    return "P2";
  },
};
```

#### Manual Detection

Signs of potential incident:
- Unusual API token usage patterns
- Unexpected file modifications
- Unauthorized user access attempts
- System performance anomalies
- Unusual network traffic

### Phase 2: Assessment

```
┌─────────────────────────────────────────────────────────────────┐
│                    Incident Assessment                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. IDENTIFY                                                     │
│     □ What happened?                                            │
│     □ When did it happen?                                       │
│     □ Who/what is affected?                                     │
│     □ What systems are involved?                                │
│                                                                  │
│  2. CLASSIFY                                                     │
│     □ Assign severity level (P1-P4)                             │
│     □ Determine incident type                                   │
│     □ Identify potential impact                                 │
│                                                                  │
│  3. DOCUMENT                                                     │
│     □ Create incident record                                    │
│     □ Preserve evidence                                         │
│     □ Start incident timeline                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 3: Containment

#### Immediate Actions

```bash
#!/bin/bash
# incident-containment.sh

INCIDENT_TYPE=$1

case $INCIDENT_TYPE in
  "token_leak")
    # Revoke all tokens immediately
    echo "Revoking all API tokens..."
    # Platform-specific token revocation
    
    # Enable read-only mode
    echo "READ_ONLY_MODE=true" >> .env
    
    # Restart service
    docker-compose restart
    ;;
    
  "unauthorized_access")
    # Block specific user
    echo "BLOCKED_USER_ID=$ATTACKER_ID" >> .env
    
    # Enable emergency read-only mode
    echo "EMERGENCY_LOCKDOWN=true" >> .env
    
    # Restart service
    docker-compose restart
    ;;
    
  "data_exfiltration")
    # Isolate instance
    docker-compose stop
    
    # Create forensic snapshot
    tar -czf "forensics_$(date +%s).tar.gz" logs/ .strata-memory/
    
    # Disable network
    docker network disconnect bridge strata-brain
    ;;
esac
```

#### Short-term Containment

1. **Enable read-only mode**: Prevent further modifications
2. **Revoke tokens**: If token compromise suspected
3. **Block IPs/Users**: If specific attackers identified
4. **Increase logging**: Maximum verbosity for investigation

### Phase 4: Investigation

#### Evidence Collection

```bash
# Collect logs
tar -czf evidence_logs_$(date +%s).tar.gz logs/

# Collect memory database
cp -r .strata-memory/ evidence_memory/

# Collect configuration
cp .env evidence.env

# Collect system state
docker ps > evidence_docker.txt
netstat -tuln > evidence_network.txt
ps aux > evidence_processes.txt
```

#### Log Analysis

```typescript
// Incident analysis
interface IncidentAnalyzer {
  timeframe: { start: Date; end: Date };
  userIds: string[];
  ipAddresses: string[];
  actions: string[];
}

async function analyzeIncident(params: IncidentAnalyzer) {
  const logs = await loadLogs(params.timeframe);
  
  return {
    // Timeline of events
    timeline: buildTimeline(logs),
    
    // Affected resources
    affectedResources: identifyAffectedResources(logs),
    
    // Attack pattern
    pattern: identifyAttackPattern(logs),
    
    // Scope
    scope: calculateScope(logs),
  };
}
```

## Incident Types

### Type 1: Token Compromise

**Detection**: Unusual API usage patterns

**Response**:
```bash
# 1. Revoke tokens immediately
# Telegram: Use BotFather to revoke
# Discord: Regenerate in Developer Portal
# Slack: Rotate in App Management

# 2. Enable read-only mode
export READ_ONLY_MODE=true

# 3. Audit recent activity
# Check last 24 hours of logs
grep "$(date -d '24 hours ago' '+%Y-%m-%d')" logs/strata-brain.log

# 4. Generate new tokens
# Follow token rotation procedure
```

### Type 2: Unauthorized Access

**Detection**: Failed auth attempts, unexpected user activity

**Response**:
```typescript
// Emergency user block
async function emergencyBlockUser(userId: string, channel: string) {
  // Add to blocklist
  await blocklist.add({ userId, channel, reason: "security_incident" });
  
  // Revoke any active sessions
  await sessionManager.revokeUserSessions(userId);
  
  // Alert admins
  await sendAlert({
    type: "user_blocked",
    userId,
    channel,
    timestamp: new Date(),
  });
}
```

### Type 3: Path Traversal Success

**Detection**: File access outside project directory

**Response**:
```bash
# 1. Isolate instance
docker stop strata-brain

# 2. Check accessed files
find / -type f -newer /var/log/syslog -ls 2>/dev/null

# 3. Scan for modifications
# Compare against known good state

# 4. Forensic imaging
dd if=/dev/sda of=/forensics/incident_image.img
```

### Type 4: Data Exfiltration

**Detection**: Large data transfers, unusual file reads

**Response**:
```bash
# 1. Immediate network isolation
iptables -A OUTPUT -d 0.0.0.0/0 -j DROP

# 2. Preserve evidence
tar -czf evidence_$(date +%s).tar.gz \
  logs/ \
  .strata-memory/ \
  /var/log/syslog

# 3. Analyze access patterns
# Check what files were accessed
grep "file_read" logs/strata-brain.log | \
  awk '{print $NF}' | sort | uniq -c | sort -rn
```

## Recovery Procedures

### System Recovery

```bash
#!/bin/bash
# recovery.sh

# 1. Identify clean restore point
# Last known good backup

# 2. Restore from backup
tar -xzf backups/memory_20260301_120000.tar.gz

# 3. Rotate all secrets
./scripts/rotate-all-secrets.sh

# 4. Apply security patches
npm audit fix
docker pull node:20-alpine

# 5. Restart with monitoring
docker-compose up -d
./scripts/enable-enhanced-monitoring.sh

# 6. Verify integrity
./scripts/verify-system-integrity.sh
```

### Verification Steps

```typescript
// Post-recovery verification
async function verifyRecovery(): Promise<VerificationResult> {
  const checks = {
    // Service health
    health: await checkServiceHealth(),
    
    // Authentication
    auth: await verifyAuthentication(),
    
    // File permissions
    permissions: await verifyFilePermissions(),
    
    // Network isolation
    network: await verifyNetworkIsolation(),
    
    // Logs functioning
    logging: await verifyLogging(),
  };
  
  return {
    passed: Object.values(checks).every(c => c.passed),
    checks,
    timestamp: new Date(),
  };
}
```

## Post-Incident Activities

### Incident Report Template

```markdown
# Incident Report: INC-YYYY-MM-DD-001

## Summary
- **Date**: 2026-03-02
- **Severity**: P2
- **Type**: Unauthorized Access
- **Status**: Resolved

## Timeline
- 14:30:00 - First detection
- 14:35:00 - Incident declared
- 14:40:00 - Containment initiated
- 15:00:00 - Investigation started
- 16:30:00 - Recovery completed
- 17:00:00 - Service restored

## Root Cause
[Detailed description]

## Impact
- Users affected: 5
- Files accessed: 3
- Data exfiltrated: None
- Downtime: 30 minutes

## Response Actions
1. [Action taken]
2. [Action taken]

## Lessons Learned
- [Lesson 1]
- [Lesson 2]

## Recommendations
- [Recommendation 1]
- [Recommendation 2]
```

### Improvement Actions

```typescript
// Track post-incident actions
interface PostIncidentAction {
  id: string;
  description: string;
  owner: string;
  dueDate: Date;
  status: "open" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

const postIncidentActions: PostIncidentAction[] = [
  {
    id: "ACTION-001",
    description: "Implement additional rate limiting",
    owner: "security-team",
    dueDate: new Date("2026-03-09"),
    status: "open",
    priority: "high",
  },
  // ...
];
```

## Communication Plan

### Internal Communication

| Timeline | Action | Audience |
|----------|--------|----------|
| 0-15 min | Alert on-call | Security team |
| 15-30 min | Incident declaration | All stakeholders |
| Every hour | Status update | Leadership |
| Post-resolution | Final report | All employees |

### External Communication

| Scenario | Action | Timing |
|----------|--------|--------|
| User data exposed | Customer notification | Within 72 hours |
| Regulatory requirement | Authority notification | Per regulation |
| Public impact | Public statement | After assessment |

### Communication Templates

```markdown
## Internal Alert Template

Subject: [SECURITY] Incident Declared - INC-YYYY-MM-DD-NNN

Severity: P{1-4}
Type: {incident_type}
Time Detected: {timestamp}

Summary:
{brief_description}

Actions Taken:
- {action_1}
- {action_2}

Next Update: {time}

Incident Commander: {name}
```

---

## Emergency Contacts

| Role | Name | Phone | Email |
|------|------|-------|-------|
| Incident Commander | TBD | - | - |
| Security Lead | TBD | - | - |
| Operations Lead | TBD | - | - |
| Legal | TBD | - | - |

---

Last updated: 2026-03-02
