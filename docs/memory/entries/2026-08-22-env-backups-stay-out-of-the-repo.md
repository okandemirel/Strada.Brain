---
id: env-backups-stay-out-of-the-repo
kind: gotcha
tier: 1
status: active
topics: ["ops", "process"]
paths: [".env*", ".gitignore"]
purpose: "Stop a config backup beside .env from carrying a live key into a commit."
summary: "Back up .env to scratch space, never beside the original"
decided_on: 2026-08-22
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Two backups taken before editing configuration, `.env.bak.<n>` and `.env.backup-<reason>`, carried a live API key into two commits and onto the remote. `.gitignore` excluded `.env`, one exact file name, and a backup never has that name. Removing the files from HEAD does not unpublish what was pushed, so the key had to be revoked.

## Decision
Back up configuration to the session's scratch directory, never next to the original. Stage explicit paths only; never use `git add -A`. The pre-commit hook and the suite refuse env files and key-shaped strings, but they catch the mistake after it is made, they do not excuse it.

## Rejected alternatives
- **Widen the ignore to `.env*`.** It helps and is in place, but it does not cover a backup named differently, such as `config.old`.
- **Rely on secret scanning after the push.** The key is public the moment the push lands.

## Consequences
This is a rule with detectors, which makes it a contract candidate (`docs/contracts/`). Until that contract exists, this entry carries it.
