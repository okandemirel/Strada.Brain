---
id: speed-and-regression-safety-first
kind: decision
tier: 0
tier_reason: "Sets the order of all work and where every gate must live."
status: active
topics: ["process"]
paths: ["**"]
purpose: "Stop new features from jumping ahead of speed and regression safety, and stop gates from depending on a person running them."
summary: "Speed and regression safety rank above new features, and every gate lives in hooks or CI"
decided_on: 2026-11-04
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": ["docs/contracts/file-size.md", "docs/contracts/test-integrity.md"], "commits": []}
---
## Context
The owner's interview (2026-11-04) named these pains:
- **The run loop that never carried work forward.** The PAOR loop, supervision and goal decomposition were made worse by every AI that touched them, until v1 was deleted (83270634).
- **Classes thousands of lines long** that no reader can hold.
- **No way to know that existing behaviour still works** after a change.
- **Slowness,** the current top priority.

The owner runs no commands at all: the repository is developed by agents only.

## Decision
Work in this order:
1. Speed: measure first, then reduce what each call re-sends.
2. Regression safety: an end-to-end run of the loop with a scripted provider, plus ratchets.
3. Splitting the largest files, under that safety net.
4. Then new features.

Every gate is enforced by a git hook or CI, never by a person's routine. `docs/skills/ship/SKILL.md` is the routine agents follow.

## Rejected alternatives
- **Another rewrite of the loop.** That was tried, and without a behaviour test for the loop the same failure can return unseen.
- **A pre-push routine for the owner to run.** It does not apply: nobody runs commands here.

## Consequences
Changes that add features to the largest files wait for, or come with, an extraction. Hooks are installed by `npm install` (`scripts/install-git-hooks.mjs`), and CI repeats them.
