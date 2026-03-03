# Strata.Brain Security Hardening Guide

This document describes the comprehensive security hardening implemented in Strata.Brain.

## Table of Contents

1. [Security Architecture](#security-architecture)
2. [Input Validation](#input-validation)
3. [Authentication](#authentication)
4. [Authorization](#authorization)
5. [Communication Security](#communication-security)
6. [Data Protection](#data-protection)
7. [File System Security](#file-system-security)
8. [Network Security](#network-security)
9. [Audit & Monitoring](#audit--monitoring)
10. [Dependency Security](#dependency-security)
11. [Container Security](#container-security)
12. [Quick Start](#quick-start)

---

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Security Layers                          │
├─────────────────────────────────────────────────────────────────┤
│  1. Network Security (Firewall, DDoS, Rate Limiting)           │
│  2. TLS/SSL (Encryption in Transit)                            │
│  3. Authentication (JWT, MFA, Session Management)              │
│  4. Authorization (RBAC, ABAC, Policies)                       │
│  5. Input Validation (Zod Schemas, Sanitization)              │
│  6. Application Security (Secure Coding)                       │
│  7. Data Protection (Encryption at Rest)                       │
│  8. File System Security (Chroot, Integrity)                  │
│  9. Audit Logging (Security Events, SIEM)                     │
│ 10. Container Security (Docker Hardening)                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Input Validation

### Zod Schema Validation

All inputs are validated using strict Zod schemas:

```typescript
import { validate, fileReadSchema, shellCommandSchema } from "./src/validation/index.js";

// Validate file read operation
const result = validate(fileReadSchema, {
  path: "src/index.ts",
  encoding: "utf-8",
});

if (!result.success) {
  console.error("Validation failed:", result.errors);
}
```

### Sanitization Functions

```typescript
import { sanitizeInput, sanitizeHtml, sanitizePath } from "./src/validation/index.js";

// Remove dangerous characters
const clean = sanitizeInput(userInput);

// Escape HTML entities
const safeHtml = sanitizeHtml(userInput);

// Normalize file paths
const safePath = sanitizePath(userPath);
```

---

## Authentication

### JWT Implementation

```typescript
import { JwtManager, HardenedAuthManager } from "./src/security/index.js";

const jwt = new JwtManager({
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: 900, // 15 minutes
});

// Generate token
const token = jwt.generateToken(user);

// Verify token
const result = jwt.verifyToken(token);
if (result.valid) {
  console.log("Payload:", result.payload);
}
```

### Multi-Factor Authentication (MFA)

```typescript
import { authManager } from "./src/security/index.js";

// Enable MFA for user
const { secret, backupCodes } = authManager.enableMfa(userId);

// Verify MFA code
const mfaResult = authManager.verifyMfaAndAuthenticate(
  mfaToken,
  code,
  ipAddress,
  userAgent
);
```

### Brute Force Protection

```typescript
const auth = new HardenedAuthManager({
  maxLoginAttempts: 5,
  lockoutDuration: 1800000, // 30 minutes
});
```

---

## Authorization

### Role-Based Access Control (RBAC)

```typescript
import { rbacManager, type Resource, type Action } from "./src/security/index.js";

const context = {
  user: currentUser,
  resource: { type: "file", id: "src/index.ts" },
  action: "read" as Action,
};

const result = rbacManager.authorize(context);
if (result.allowed) {
  // Proceed with operation
}
```

### Permission Checking

```typescript
import { hasPermission, hasAnyPermission, hasAllPermissions } from "./src/security/index.js";

// Check single permission
if (hasPermission(user, "files:write")) {
  // Allow file write
}

// Check any of multiple permissions
if (hasAnyPermission(user, ["files:write", "system:full"])) {
  // Allow operation
}
```

---

## Communication Security

### TLS Configuration

```typescript
import { tlsSecurity, TLS13_CIPHERS } from "./src/security/index.js";

// Configure TLS
const tlsConfig = {
  certPath: "/etc/ssl/certs/server.crt",
  keyPath: "/etc/ssl/private/server.key",
  minVersion: "TLSv1.2" as const,
  cipherSuites: TLS13_CIPHERS,
  hstsEnabled: true,
};

const manager = new TlsSecurityManager(tlsConfig);
```

### Certificate Pinning

```typescript
// Pin a certificate
manager.pinCertificate({
  hostname: "api.strata-brain.com",
  fingerprint: "sha256/abcd1234...",
  expiresAt: new Date("2025-12-31"),
});

// Verify connection
const result = manager.verifyCertificate(hostname, cert);
```

### Secure WebSocket

```typescript
import { wsSecurity } from "./src/security/index.js";

// Configure WebSocket security
wsSecurity.validateConnection({
  secure: true,
  origin: "https://app.strata-brain.com",
  headers: {},
}, authToken);
```

---

## Data Protection

### Encryption at Rest

```typescript
import { encryptionService, keyManager } from "./src/encryption/data-protection.js";

// Encrypt data
const encrypted = encryptionService.encryptToString("sensitive data");

// Decrypt data
const decrypted = encryptionService.decryptFromString(encrypted);
```

### Key Management

```typescript
// Generate new encryption key
const newKey = keyManager.generateKey();

// Schedule key rotation
keyManager.scheduleRotation((rotatedKey) => {
  console.log("Key rotated:", rotatedKey.id);
});
```

### Data Masking

```typescript
import { DataMasking } from "./src/encryption/data-protection.js";

// Mask credit card
const masked = DataMasking.mask("4111111111111111", { type: "credit_card" });
// Result: ************1111

// Mask email
const maskedEmail = DataMasking.mask("user@example.com", { type: "email" });
// Result: u**r@example.com
```

---

## File System Security

### Chroot Jail

```typescript
import { ChrootJail } from "./src/security/index.js";

const jail = new ChrootJail({
  rootPath: "/app/data",
  allowedPaths: ["projects", "temp"],
  readOnly: false,
  allowedExtensions: ["cs", "json", "md"],
});

// File operations within jail
await jail.writeFile("projects/test.cs", content);
const data = await jail.readFile("projects/test.cs");
```

### File Integrity Monitoring

```typescript
import { fileIntegrityMonitor } from "./src/security/index.js";

// Add file to monitoring
await fileIntegrityMonitor.addPath("/app/config/production.json");

// Check integrity
const check = await fileIntegrityMonitor.checkIntegrity("/app/config/production.json");
if (!check.valid) {
  console.error("File modified:", check.changes);
}
```

### Audit Logging

```typescript
import { fileAuditLogger } from "./src/security/index.js";

// Log file operation
fileAuditLogger.log({
  operation: "write",
  path: "src/index.ts",
  success: true,
  userId: "user-123",
  ipAddress: "192.168.1.1",
});
```

---

## Network Security

### Firewall

```typescript
import { firewall } from "./src/security/index.js";

// Add firewall rule
firewall.addRule({
  name: "Allow internal API",
  action: "allow",
  direction: "inbound",
  sourceIps: [{ type: "cidr", value: "10.0.0.0/8" }],
  ports: [3000],
  priority: 100,
  enabled: true,
  log: true,
});

// Check connection
const result = firewall.checkConnection(
  "192.168.1.100",
  "10.0.0.1",
  3000,
  "tcp"
);
```

### DDoS Protection

```typescript
import { ddosProtection } from "./src/security/index.js";

// Check IP
const check = ddosProtection.checkIp(clientIp);
if (!check.allowed) {
  // Block connection
}

// Record request
ddosProtection.recordRequest(clientIp);
```

---

## Audit & Monitoring

### Security Event Logging

```typescript
import { securityAudit } from "./src/security/index.js";

// Log security event
const event = securityAudit.log({
  type: "authentication_failure",
  severity: "medium",
  source: { ip: "192.168.1.100" },
  context: { requestId: "req-123" },
  details: { username: "admin", reason: "Invalid password" },
});
```

### Alert Management

```typescript
import { alertManager } from "./src/security/index.js";

// Add alert rule
alertManager.addRule({
  name: "Brute Force Detection",
  conditions: [
    { field: "type", operator: "equals", value: "authentication_failure" },
  ],
  severity: "high",
  channels: ["email", "slack"],
});

// Process event for alerts
alertManager.processEvent(event);
```

### Anomaly Detection

```typescript
import { anomalyDetector } from "./src/security/index.js";

// Update baseline
anomalyDetector.updateBaseline("requests_per_minute", 100);

// Detect anomalies
const detection = anomalyDetector.detect("requests_per_minute", 500);
if (detection.isAnomaly) {
  console.log("Anomaly detected! Confidence:", detection.confidence);
}
```

---

## Dependency Security

### Vulnerability Scanning

```typescript
import { dependencyScanner } from "./src/security/index.js";

// Run security check
const result = await dependencyScanner.runSecurityCheck();

// Generate report
const report = dependencyScanner.generateReport(result);
```

### npm Audit

```bash
# Run npm audit
npm audit

# Fix vulnerabilities
npm audit fix

# Run security scan
npm run security:scan
```

---

## Container Security

### Build Hardened Image

```bash
# Build hardened Docker image
docker build -f docker/Dockerfile.hardened -t strata-brain:hardened .

# Run with security options
docker run -d \
  --read-only \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL \
  --user=1001:1001 \
  -p 3000:3000 \
  strata-brain:hardened
```

### Security Scan

```bash
# Run security scan
cd docker && ./security-scan.sh

# Or with docker-compose
docker-compose -f docker/docker-compose.security.yml up -d
```

---

## Quick Start

### 1. Environment Configuration

```bash
# Copy security configuration
cp .env.security.example .env

# Edit with your values
# Generate encryption key: openssl rand -hex 32
# Generate JWT secret: openssl rand -base64 32
```

### 2. Initialize Security

```typescript
import { initializeSecurity } from "./src/security/index.js";

// Initialize all security modules
initializeSecurity();
```

### 3. Enable Security Middleware

```typescript
import { createSecurityMiddleware } from "./src/security/index.js";

const security = createSecurityMiddleware();

// Apply to your server
app.use((req, res, next) => {
  // Add security headers
  Object.entries(security.securityHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  next();
});
```

---

## Security Checklist

### Pre-Deployment

- [ ] Encryption keys generated and secured
- [ ] JWT secrets configured
- [ ] MFA enabled for admin accounts
- [ ] TLS certificates installed
- [ ] Firewall rules configured
- [ ] Rate limiting enabled
- [ ] Input validation enabled
- [ ] Audit logging configured
- [ ] File integrity monitoring enabled
- [ ] Dependencies audited
- [ ] Container image scanned
- [ ] Security headers configured

### Runtime

- [ ] Security events monitored
- [ ] Alerts configured
- [ ] Backups enabled
- [ ] Log rotation configured
- [ ] Health checks enabled
- [ ] Resource limits set

---

## Security Contacts

For security issues, please contact:

- Security Team: security@strata-brain.com
- Incident Response: incident@strata-brain.com

---

## License

This security module is part of Strata.Brain and follows the same license terms.
