---
id: a-clock-is-not-an-order
kind: decision
tier: 1
status: active
topics: ["ops", "process"]
paths: ["src/budget/**", "src/common/**"]
purpose: "Stop wall-clock times, bare pids, or rename-then-compare from being used to decide order, identity or exclusion."
summary: "Order comes from a sequence, identity from (host, pid), and another process's lock file is never removed"
decided_on: 2026-09-18
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": ["f4249104", "98af3b87"]}
---
## Context
Three defects in one week answered a question about order or identity with something that is neither. All three passed their tests, because the tests faked "an earlier process" with an earlier timestamp, which was the same wrong model the code had.
1. A registration time against a claim time decided whether a process had been superseded. A reboot or an NTP step moves the clock backwards, so a predecessor looked newer than its live successor.
2. Owners were keyed by pid alone, so two machines sharing a wallet overwrote each other's liveness.
3. A stale-lock breaker renamed the lock, compared its bytes and linked it back. A walk-through showed that without an OS-held lock, no ordering of read, unlink and create closes the race.

## Decision
- Order comes from an AUTOINCREMENT high-water mark (`budget_claim_seq`). Timestamps are used only as a fallback for rows written before that column existed.
- Identity is `(owner_host, owner_pid)`. A row with no host still answers for the local host.
- Never remove another process's lock file. Refuse deterministically, and name the file so a person can act on it.

## Rejected alternatives
- **Monotonic clocks.** They do not survive a reboot, and different hosts do not share one.
- **Rename-then-compare as a mutex.** The interleaving above breaks it, and Node has no portable flock.

## Consequences
Tests for ordering fake the sequence, not the clock.
