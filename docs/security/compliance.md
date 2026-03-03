# Compliance

This document outlines Strata Brain's approach to regulatory compliance including GDPR and SOC 2 considerations.

## Table of Contents

- [Overview](#overview)
- [GDPR Compliance](#gdpr-compliance)
- [SOC 2 Requirements](#soc-2-requirements)
- [Data Classification](#data-classification)
- [Audit Logging](#audit-logging)
- [Data Retention](#data-retention)
- [Compliance Checklist](#compliance-checklist)

## Overview

Strata Brain is designed with compliance in mind, implementing controls that help organizations meet their regulatory obligations.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Compliance Framework                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │    Security     │  │    Privacy      │  │   Availability  │ │
│  │                 │  │                 │  │                 │ │
│  │ • Access Control│  │ • Data Minimiz. │  │ • Monitoring    │ │
│  │ • Encryption    │  │ • Consent       │  │ • Backups       │ │
│  │ • Audit Logs    │  │ • Retention     │  │ • Recovery      │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                  │
│  Regulations:                                                   │
│  ├── GDPR (EU Data Protection)                                  │
│  ├── SOC 2 (Security Controls)                                  │
│  └── ISO 27001 (InfoSec Management)                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## GDPR Compliance

### GDPR Principles

Strata Brain supports compliance with GDPR principles:

| Principle | Implementation |
|-----------|---------------|
| **Lawfulness** | User consent via explicit opt-in |
| **Purpose Limitation** | Data used only for stated purposes |
| **Data Minimization** | Only necessary data collected |
| **Accuracy** | Users can request data corrections |
| **Storage Limitation** | Configurable retention periods |
| **Integrity** | Security controls protect data |
| **Accountability** | Audit logs and documentation |

### Data Processing

#### Personal Data Collected

```typescript
// Types of personal data processed
interface PersonalData {
  // User identifiers
  userId: string;        // Platform-specific ID
  username?: string;     // Optional username
  
  // Communication data
  messages: {
    content: string;     // Message content
    timestamp: Date;
  }[];
  
  // Usage data
  interactions: {
    tool: string;
    timestamp: Date;
  }[];
}
```

#### Legal Basis

```typescript
// GDPR legal bases for processing
enum LegalBasis {
  CONSENT = "consent",           // User explicit consent
  CONTRACT = "contract",          // Service provision
  LEGAL_OBLIGATION = "legal",     // Legal requirement
  LEGITIMATE_INTEREST = "interest", // Legitimate business interest
}

// Processing activities
const processingActivities = [
  {
    purpose: "Authentication",
    data: ["userId"],
    basis: LegalBasis.CONTRACT,
    retention: "Duration of service",
  },
  {
    purpose: "Service Improvement",
    data: ["messages", "interactions"],
    basis: LegalBasis.LEGITIMATE_INTEREST,
    retention: "30 days",
  },
  {
    purpose: "Security Monitoring",
    data: ["interactions"],
    basis: LegalBasis.LEGAL_OBLIGATION,
    retention: "1 year",
  },
];
```

### User Rights

#### Right to Access

```typescript
// Export user data
async function exportUserData(userId: string): Promise<UserDataExport> {
  const memory = await loadUserMemory(userId);
  const logs = await loadUserLogs(userId);
  
  return {
    userId,
    exportDate: new Date(),
    data: {
      profile: sanitizeForExport(memory.profile),
      conversations: sanitizeForExport(memory.conversations),
      usage: sanitizeForExport(logs),
    },
    format: "json",
  };
}
```

#### Right to Erasure (Right to be Forgotten)

```typescript
// Delete all user data
async function deleteUserData(userId: string): Promise<void> {
  // Delete from memory
  await memoryStore.deleteUserData(userId);
  
  // Delete from logs
  await logStore.deleteUserLogs(userId);
  
  // Delete from vector store
  await vectorStore.deleteUserEmbeddings(userId);
  
  // Record deletion for audit
  await auditLog.record({
    action: "user_data_deleted",
    userId,
    timestamp: new Date(),
  });
}
```

#### Right to Portability

```typescript
// Export in machine-readable format
async function exportPortableData(userId: string): Promise<Buffer> {
  const data = await exportUserData(userId);
  
  // JSON format for portability
  return Buffer.from(JSON.stringify(data, null, 2));
}
```

### Data Protection Impact Assessment (DPIA)

#### High-Risk Processing Activities

| Activity | Risk Level | Mitigation |
|----------|-----------|------------|
| Message storage | Medium | Encryption at rest, access controls |
| File access | Medium | Path validation, audit logging |
| AI processing | Low | No PII sent to AI, anonymization |

### Privacy Configuration

```bash
# Enable privacy mode (GDPR-compliant defaults)
PRIVACY_MODE=true

# Data retention (days)
MESSAGE_RETENTION_DAYS=30
LOG_RETENTION_DAYS=90

# Anonymize logs
ANONYMIZE_LOGS=true

# Disable telemetry
TELEMETRY_ENABLED=false
```

## SOC 2 Requirements

### Trust Service Criteria

Strata Brain addresses SOC 2 Trust Service Criteria:

```
┌─────────────────────────────────────────────────────────────────┐
│                   SOC 2 Trust Services                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Security (Common Criteria)                                     │
│  ├── CC6.1: Logical access controls                             │
│  │   └── User whitelist, authentication                         │
│  ├── CC6.2: Access removal                                      │
│  │   └── Dynamic user management                                │
│  ├── CC6.3: Access monitoring                                   │
│  │   └── Audit logging, rate limiting                           │
│  └── CC6.6: Security infrastructure                             │
│      └── Path guard, secret sanitizer                           │
│                                                                  │
│  Availability                                                   │
│  ├── A1.2: System monitoring                                    │
│  │   └── Health checks, metrics                                 │
│  └── A1.3: System recovery                                      │
│      └── Backup procedures                                      │
│                                                                  │
│  Processing Integrity                                           │
│  ├── PI1.2: System processing                                   │
│  │   └── Input validation, error handling                       │
│  └── PI1.3: Error handling                                      │
│      └── Diff confirmation, rollback                            │
│                                                                  │
│  Confidentiality                                                │
│  ├── C1.1: Confidential info identification                     │
│  │   └── Secret detection patterns                              │
│  └── C1.2: Confidential info protection                         │
│      └── Secret sanitization                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Control Implementation

#### Access Control (CC6.1)

```typescript
// Logical access controls
class AccessControl {
  // Authentication
  authenticate(userId: string, channel: string): boolean {
    return authManager.isUserAllowed(userId, channel);
  }
  
  // Authorization
  authorize(userId: string, action: string): boolean {
    if (readOnlyMode && isWriteAction(action)) {
      return false;
    }
    return true;
  }
  
  // Least privilege
  getAllowedTools(userId: string): string[] {
    const baseTools = getReadTools();
    if (isPrivilegedUser(userId)) {
      return [...baseTools, ...getWriteTools()];
    }
    return baseTools;
  }
}
```

#### Audit Logging (CC4.1)

```typescript
// Comprehensive audit logging
interface AuditEvent {
  timestamp: Date;
  userId: string;
  action: string;
  resource: string;
  result: "success" | "failure";
  details: Record<string, unknown>;
}

class AuditLogger {
  log(event: AuditEvent): void {
    // Immutable log storage
    logger.info("audit_event", {
      ...event,
      tamperProof: generateHash(event),
    });
  }
  
  // Log all security events
  logAuth(userId: string, success: boolean): void {
    this.log({
      timestamp: new Date(),
      userId,
      action: "authentication",
      resource: "system",
      result: success ? "success" : "failure",
      details: { ip: getClientIP() },
    });
  }
}
```

#### Change Management (CC8.1)

```typescript
// Controlled change management
class ChangeManager {
  async requestChange(
    userId: string,
    change: FileChange
  ): Promise<ChangeRequest> {
    // Create diff
    const diff = await generateDiff(change);
    
    // Request approval
    const approval = await dmPolicy.requestApproval(userId, diff);
    
    if (approval.approved) {
      // Log change
      await auditLog.log({
        action: "change_approved",
        userId,
        details: { diff },
      });
      
      // Apply change
      return this.applyChange(change);
    }
    
    return { status: "rejected" };
  }
}
```

## Data Classification

### Data Classification Levels

| Level | Description | Examples | Handling |
|-------|-------------|----------|----------|
| **Public** | No restrictions | Documentation, public repos | Standard handling |
| **Internal** | Organization use | Project structure | Access logging |
| **Confidential** | Sensitive data | API keys, tokens | Encryption, strict access |
| **Restricted** | Highly sensitive | Private keys, passwords | Vault storage, audit required |

### Data Handling Matrix

```typescript
// Data classification handler
class DataClassifier {
  classify(data: string): ClassificationLevel {
    // Check for secrets
    if (secretSanitizer.containsSecrets(data)) {
      return ClassificationLevel.RESTRICTED;
    }
    
    // Check for credentials
    if (this.containsCredentials(data)) {
      return ClassificationLevel.CONFIDENTIAL;
    }
    
    // Check for internal data
    if (this.containsInternalData(data)) {
      return ClassificationLevel.INTERNAL;
    }
    
    return ClassificationLevel.PUBLIC;
  }
  
  handleAccordingToClassification(
    data: string, 
    level: ClassificationLevel
  ): void {
    switch (level) {
      case ClassificationLevel.RESTRICTED:
        this.encryptAndVault(data);
        break;
      case ClassificationLevel.CONFIDENTIAL:
        this.encryptAtRest(data);
        break;
      case ClassificationLevel.INTERNAL:
        this.logAccess(data);
        break;
      case ClassificationLevel.PUBLIC:
        // Standard handling
        break;
    }
  }
}
```

## Audit Logging

### Log Categories

```typescript
// Comprehensive audit categories
enum AuditCategory {
  AUTHENTICATION = "auth",
  AUTHORIZATION = "authz",
  DATA_ACCESS = "data_access",
  DATA_MODIFICATION = "data_mod",
  SYSTEM_CHANGE = "system",
  SECURITY_EVENT = "security",
}

// Log structure
interface AuditLogEntry {
  timestamp: string;      // ISO 8601
  category: AuditCategory;
  severity: "info" | "warn" | "error";
  userId?: string;
  action: string;
  resource: string;
  result: "success" | "failure";
  details: Record<string, unknown>;
  correlationId: string;  // For tracing
  hash: string;          // Tamper detection
}
```

### Log Retention

```typescript
// Retention policies
const retentionPolicies: Record<AuditCategory, number> = {
  [AuditCategory.AUTHENTICATION]: 365,      // 1 year
  [AuditCategory.AUTHORIZATION]: 365,       // 1 year
  [AuditCategory.DATA_ACCESS]: 90,          // 90 days
  [AuditCategory.DATA_MODIFICATION]: 365,   // 1 year
  [AuditCategory.SYSTEM_CHANGE]: 730,       // 2 years
  [AuditCategory.SECURITY_EVENT]: 2555,     // 7 years
};

// Automated cleanup
async function cleanupOldLogs(): Promise<void> {
  for (const [category, days] of Object.entries(retentionPolicies)) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    await logStore.deleteBefore(category, cutoffDate);
  }
}
```

## Data Retention

### Retention Policy

```typescript
// Data retention configuration
interface RetentionPolicy {
  type: string;
  retentionDays: number;
  anonymizeAfter?: number;
}

const retentionPolicies: RetentionPolicy[] = [
  {
    type: "conversation_history",
    retentionDays: 30,
    anonymizeAfter: 30,
  },
  {
    type: "user_memory",
    retentionDays: 90,
  },
  {
    type: "audit_logs",
    retentionDays: 365,
  },
  {
    type: "error_logs",
    retentionDays: 90,
  },
  {
    type: "security_logs",
    retentionDays: 2555, // 7 years
  },
];
```

### Automated Cleanup

```bash
#!/bin/bash
# retention-cleanup.sh

# Clean old conversation data
find .strata-memory/conversations -type f -mtime +30 -delete

# Archive and compress old logs
find logs/ -name "*.log" -mtime +90 -exec gzip {} \\;

# Delete archived logs after retention period
find logs/ -name "*.gz" -mtime +365 -delete

# Vacuum SQLite databases
sqlite3 .strata-memory/memory.db "VACUUM;"
```

## Compliance Checklist

### GDPR Checklist

- [ ] Privacy policy published
- [ ] Cookie consent implemented (if applicable)
- [ ] Data processing register maintained
- [ ] User rights procedures documented
- [ ] Data retention policies configured
- [ ] Data breach notification procedure
- [ ] DPIA completed for high-risk processing
- [ ] Cross-border transfer mechanisms (if applicable)

### SOC 2 Checklist

- [ ] Access control policies documented
- [ ] User access review procedures
- [ ] Change management process
- [ ] Backup and recovery tested
- [ ] Security monitoring implemented
- [ ] Incident response plan
- [ ] Vendor management process
- [ ] Risk assessment completed

### Security Checklist

- [ ] Encryption at rest enabled
- [ ] Encryption in transit (TLS 1.2+)
- [ ] Secret management implemented
- [ ] Audit logging enabled
- [ ] Rate limiting configured
- [ ] Input validation implemented
- [ ] Error handling (no info leakage)
- [ ] Security headers configured
- [ ] Dependency scanning
- [ ] Vulnerability management

### Operational Checklist

- [ ] Monitoring and alerting
- [ ] Log aggregation
- [ ] Health checks
- [ ] Disaster recovery tested
- [ ] Business continuity plan
- [ ] Change control process
- [ ] Configuration management
- [ ] Capacity planning

## Compliance Reporting

### Automated Compliance Reports

```typescript
// Generate compliance report
async function generateComplianceReport(
  period: DateRange
): Promise<ComplianceReport> {
  return {
    period,
    generatedAt: new Date(),
    sections: {
      accessControl: await reportAccessControl(period),
      auditLogs: await reportAuditLogs(period),
      dataProtection: await reportDataProtection(period),
      incidentResponse: await reportIncidents(period),
    },
    compliance: {
      gdpr: await assessGDPRCompliance(),
      soc2: await assessSOC2Compliance(),
    },
  };
}
```

---

Last updated: 2026-03-02
