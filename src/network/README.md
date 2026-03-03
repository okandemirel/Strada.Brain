# src/network/

Network security layer providing firewall rules, token-bucket rate limiting, and DDoS protection.

## IP Utilities (`IpUtils` in `firewall.ts`)

Static helper class for IPv4 address operations.

- `ipToLong()` converts dotted-quad to 32-bit unsigned integer via bit-shifting
- `isInCidr(ip, cidr)` applies a bitmask to check CIDR membership
- `isInRange(ip, start, end)` checks numeric range inclusion
- `isPrivate()` matches against `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `127.*`
- `isLoopback()` matches `127.0.0.1`, `::1`, and `127.*`
- `isValidIp()` validates IPv4 (full octet regex) and IPv6 (basic hex-colon regex)

## Firewall (`Firewall` in `firewall.ts`)

Rule-based connection filter with whitelist/blacklist and priority-ordered rule evaluation.

- Rules are `FirewallRule` objects with `action` (`allow` | `deny` | `rate_limit`), `direction`, `protocol`, `sourceIps`, `destinationIps`, `ports`, and `priority`
- IP ranges support three types: `single` (exact match), `cidr`, and `range` (start-end)
- `checkConnection(sourceIp, destIp, destPort, protocol)` evaluates in order: whitelist set, blacklist set, then rules sorted by descending priority
- Default policy is deny (returns `{ allowed: false, action: "default_deny" }` if no rule matches)
- `Set<string>` whitelist/blacklist for fast exact-IP lookups; range-based lookups fall through to rule evaluation
- Rules auto-sort on insert by `priority` (highest first)

## Rate Limiter (`RateLimiter` in `firewall.ts`)

Token-bucket rate limiter keyed by arbitrary string (typically IP address).

- `Map<string, RateLimitBucket>` stores per-key state: token count, last refill time, request count, window start
- Defaults: `10` tokens/second refill rate, `20` burst capacity
- `checkLimit(key, customRate?, customBurst?)` refills tokens based on elapsed time, then deducts 1; returns `{ allowed, remaining, resetTime, retryAfter? }`
- `cleanup(maxAgeMs)` evicts buckets older than `maxAgeMs` (default 1 hour)

## DDoS Protection (`DdosProtection` in `firewall.ts`)

Connection-level and request-rate DDoS mitigation with automatic IP blocking.

- Configurable via `DdosProtectionConfig`: `connectionLimit` (default 1000), `requestsPerSecondThreshold` (default 100), `burstThreshold` (default 200), `blockDuration` (default 1 hour)
- `checkIp(ip)` evaluates in order: whitelist bypass, active block check, request rate check, connection count check, suspicious flag
- `recordRequest(ip)` increments a per-IP counter in 1-second sliding windows; marks IP as suspicious if count exceeds `burstThreshold`
- `blockIp(ip, duration?)` adds IP to `blockedIps` map with an expiry timestamp and closes all tracked connections from that IP
- `challengeMode` supports `"none"`, `"captcha"`, and `"proof_of_work"` (challenge flag returned but not enforced in this module)
- Tracks `ConnectionInfo` per IP with byte/packet counters

## Module Singletons

The file exports three pre-instantiated singletons with default configs:

- `firewall` — `new Firewall()`
- `rateLimiter` — `new RateLimiter()` (10 req/s, burst 20)
- `ddosProtection` — `new DdosProtection()`

## Key Files

| File | Purpose |
|------|---------|
| `firewall.ts` | Firewall rules engine, token-bucket rate limiter, DDoS protection, and IP utilities |
