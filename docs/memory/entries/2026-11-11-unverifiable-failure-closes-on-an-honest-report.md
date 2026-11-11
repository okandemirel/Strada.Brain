---
id: unverifiable-failure-closes-on-an-honest-report
kind: decision
tier: 1
status: active
topics: ["agent-loop", "evidence"]
paths: ["src/agents/autonomy/verifier-pipeline-unverifiable.ts", "src/agents/autonomy/verifier-pipeline.ts", "src/agents/autonomy/completion-review.ts"]
purpose: "Stop a failure that nothing in the run can verify from costing six asks, a block and a re-run that ends unverified anyway, without letting a run that could verify skip the check."
summary: "A failed step re-run successfully stops gating when the turn's tool offer holds no check tool, no check ran, no log issue is open and the draft says the result is not verified; otherwise the targeted-repro gate stands"
decided_on: 2026-11-11
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Golden run 4 (2026-11-06): a write failed at run time (the filesystem refused it), the next write succeeded, and the project had no build and no tests. The targeted-repro and unverified-failure checks kept the failure open until a verification ran. Nothing could run one: the worker was asked six times, loop detection blocked the node, the goal ran again from the start, and the re-run, with an empty failure history, completed with no verification at all. The gate added cost and protected nothing.

## Decision
`unverifiableFailureOutcome` (`src/agents/autonomy/verifier-pipeline-unverifiable.ts`) applies only when all of these hold:
- the tool names offered to this turn were passed in, and none of them `runsVerificationCheck`. The record says where the answer came from (`evidence.verificationTooling.source`);
- the offer was not narrowed: an offer of writers only (restrictToProgressTools) or a plan node whose text names a tool (selectNodeTools) counts as not measured, because both hide tools that still run;
- no verification step ran in the run;
- every open failure has a later successful call of the same tool (`recentFailuresRetriedOk`);
- no warn/error log entry is open.

Then the gate asks once, under `[NO VERIFICATION TOOL]`, for a report that says the result is not verified, and closes when the draft says so. The check stays in the record with status `issues`, saying "Not verified" and naming the registry. Golden run 4 pins the one-ask path. Golden run 5 registers a check tool and pins that the old block-and-resume path still holds, with a draft that says "not verified".

## Rejected alternatives
- **Decide "no verification tool" from the draft** ("this project has no build and no tests"). That judges the run by its prose. The draft is read here only for whether the user is told the result is unverified.
- **Count shell_exec as a check tool.** It is on every run's offer, so the exit would never apply. constants.ts already classifies it as reading. A shell in the offer instead makes the exit read the project's manifests (`shell-runs-what-the-project-declares`).
- **Close without asking, and append "not verified" to the visible text deterministically.** The approve result reaches the user through four handler paths, and none of them carries a notice from the pipeline. One ask costs one call and keeps the change in the pipeline.
- **Close any failure once the registry has no check tool.** A step that failed and was never re-run has not been repaired. It still waits.

## Consequences
The measurement reads the turn's offer, not the full registry. The orchestrator gives the pipeline no other list, and `orchestrator.ts` may not grow. A turn narrowed in a way not listed above would hide a check tool and wrongly open this exit. Add the narrowing to `measureVerificationTooling` when one appears.
