---
id: mutation-check-every-fix
kind: guideline
tier: 0
tier_reason: "Applies to every fix in every area, and its absence produced tests that proved nothing."
status: active
topics: ["process", "evidence"]
paths: ["src/**", "scripts/**"]
purpose: "Stop a fix from shipping with a test that would pass without it."
summary: "A fix is finished only when its test is shown to fail without it"
decided_on: 2026-08-21
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": ["docs/contracts/test-integrity.md"], "commits": []}
---
## Context
On 2026-08-21 several tests passed while proving nothing:
- a payload wiring that nothing covered;
- a rule whose test data satisfied two conditions at once, so removing either one left the test green;
- a mutation harness whose `grep` was defeated by vitest's ANSI colour codes, so it reported "no failures" for three live mutations.

A later slip (4fc47d7d) pushed a change after its mutation run still showed green, because that line scrolled past in the full-suite output.

## Decision
After writing the test, mutate the exact line the fix touched and run the test. If nothing goes red, the test data does not discriminate. Build the case that does before shipping. The mutation step prints PASS or FAIL on its own line, and the push depends on it. Strip ANSI codes before grepping vitest output.

## Rejected alternatives
- **Trust a green run of the new test.** This is exactly what produced the three false proofs above.
- **Rely on coverage numbers.** Coverage shows that a line ran, not that a wrong line would be caught.

## Consequences
Every fix commit says how it was mutation-checked. The test-integrity contract covers the opposite direction: no test is weakened to make a check pass.
