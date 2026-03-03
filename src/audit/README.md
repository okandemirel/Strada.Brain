# src/audit/

Security event logging, alerting, and anomaly detection in a single module.

## Security Audit Logger (`security-audit.ts` — `SecurityAuditLogger`)

In-memory security event store with query and reporting capabilities.

- `SecurityEvent[]` array capped at `maxEvents` (default 100,000); oldest events evicted via `shift()`
- 28 distinct `SecurityEventType` values covering auth, session, attack detection (XSS, CSRF, SQLi, path traversal), infrastructure events (DDoS, firewall, certificate), and data operations (backup, user CRUD, role changes)
- Five severity levels: `info`, `low`, `medium`, `high`, `critical`
- Convenience methods: `logAuthSuccess()`, `logAuthFailure()`, `logAuthzFailure()`, `logSuspicious()`
- `query()` filters by type, severity, userId, IP, time range, and limit
- `getStats()` aggregates counts by type/severity; returns top 10 source IPs sorted by frequency
- `generateComplianceReport()` produces a `ComplianceReport` with auth attempt ratios, authorization denials, suspicious activity counts, and alert totals for a given time period
- `export()` outputs JSON or CSV (6-column: id, timestamp, type, severity, source.ip, source.userId)
- Event IDs use format `sec-{timestamp}-{random9}`

## Alert Manager (`security-audit.ts` — `AlertManager`)

Rule-based alert engine that evaluates security events against configurable conditions.

- `AlertRule[]` with per-rule cooldown (`cooldownMs`) to suppress duplicate alerts
- `AlertCondition` supports 8 operators: `equals`, `contains`, `gt`, `lt`, `gte`, `lte`, `in`, `matches` (regex)
- Condition matching uses dot-notation field access on `SecurityEvent` (e.g., `source.ip`, `severity`)
- Alert channels: `email`, `slack`, `webhook`, `sms`, `pagerduty`, `console`
- Critical-severity events auto-set `escalated: true` on the generated alert
- `acknowledgeAlert()` records userId and timestamp
- `getPendingAlerts()` filters unacknowledged alerts, optionally by severity
- SIEM integration via `configureSiem()` with configurable endpoint, apiKey, index, batch size, and flush interval (sending is stubbed)

## Anomaly Detector (`security-audit.ts` — `AnomalyDetector`)

Statistical anomaly detection using z-score analysis with online baseline computation.

- Uses Welford's online algorithm to incrementally compute mean and standard deviation per metric
- `detect()` returns `{ isAnomaly, zScore, confidence }` — flags anomaly when `zScore > sensitivity`
- Default sensitivity threshold: 2 standard deviations
- Requires minimum 30 samples (`minSamples`) before producing anomaly verdicts
- Confidence calculated as `min(1, zScore / (sensitivity * 2))`
- Zero-stddev edge case: any deviation from mean is flagged as anomaly with infinite z-score

## Module Singletons

Three pre-instantiated singletons exported: `securityAudit`, `alertManager`, `anomalyDetector`.

## Key Files

| File | Purpose |
|------|---------|
| `security-audit.ts` | Security event logging, rule-based alerting, SIEM integration, compliance reporting, and z-score anomaly detection |
