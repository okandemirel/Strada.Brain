---
id: a-refused-target-closes-on-the-next-success
kind: decision
tier: 1
status: active
topics: ["agent-loop", "evidence"]
paths: ["src/agents/autonomy/completion-review.ts", "src/agents/autonomy/verifier-pipeline.ts", "src/security/path-guard.ts"]
purpose: "Stop one refused tool call from blocking a node in a project that has nothing to verify with, without letting a real failure close unverified."
summary: "A path-guard target refusal leaves the verifier's open failures once a later call of the same tool succeeds; a tool that ran and failed still waits for a verification"
decided_on: 2026-11-06
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
The verifier pipeline's targeted-repro and unverified-failure checks treat every failed step after the last verification as an open failing path. A worker that wrote outside the project was refused by the path guard, then wrote the right path. The refusal still waited for a verification. The project had no build and no tests, so the worker was asked six times, loop detection blocked the node, and the goal ran again from the start (golden run, 2026-11-06).

## Decision
`collectCompletionReviewEvidence` drops a failure from `recentFailures` when both of these hold:
- its text is the path guard refusing the target the call named (`isPathTargetRefusal` in `src/security/path-guard.ts`, anchored at the start of the text);
- a later call of the same tool succeeded.

Every other failure stays open until a verification runs. `src/agents/autonomy/refused-target-retried.test.ts` pins both directions. Golden run 5 (a write that the filesystem failed, in a run with a check tool) keeps the block-and-resume path pinned.

## Rejected alternatives
- **Any failure closes when the same tool later succeeds.** This lets a failed test run close because a later `shell_exec ls` succeeded. A tool that ran and failed has a path to re-run; a refused call does not.
- **Close the gate when the project has no verification tools and the draft says so.** That judges the run by its prose, and every project without tests would skip the check, including after a real runtime failure. (Narrowed on 2026-11-11: when the tool offer, not the prose, holds no check tool and the failed tool was re-run successfully, see `2026-11-11-unverifiable-failure-closes-on-an-honest-report.md`.)
- **Require a retry on the same path.** A refused target cannot be written by definition, so the correct retry always names a different path.

## Consequences
Other refusals that happen before a tool does anything are not covered yet: git internals, the manifest guard, content size, read-only mode. They still wait for a verification. Add one to the vocabulary only with a test that asks its producer for the refusal text.
