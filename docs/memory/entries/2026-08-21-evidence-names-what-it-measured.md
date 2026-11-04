---
id: evidence-names-what-it-measured
kind: guideline
tier: 0
tier_reason: "The commonest defect family in the system, and the first suspect whenever a run stalls."
status: active
topics: ["evidence", "agent-loop"]
paths: ["src/**"]
purpose: "Stop a verdict, gate or log line from reporting an outcome without saying what it was about, what it left out, or why."
summary: "Every verdict names what it measured, what it left out, and why"
decided_on: 2026-08-21
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Almost every real failure found on 2026-08-21 had the same shape: a result that reported an outcome without its scope or its cause. Examples:
- a failed compile whose evidence led with "assembly reloaded";
- a play-mode run reporting "2 of 2 passed" after an unbuilt assembly silently dropped most of the suite;
- a lease commit logging "conflicts: 0" while it declined deletions;
- "outside the project" without naming the directory.

Once accurate error text reached the agent, it fixed a compile error in three minutes. Before that, it had spent half an hour blind to the same error.

## Decision
When a run stalls or loops, suspect the evidence handed to the agent before suspecting the model. Read the tool result the agent actually received, not a summary of it. Every verdict, gate and measuring script states its scope, what it left out, and the cause. "Not measured" is never reported as "passed" or as "failed".

## Rejected alternatives
- **Shorter, friendlier result text.** It is exactly what hid the causes above.
- **Blame the model and switch to a stronger one.** The same model acted correctly once the evidence was accurate.

## Consequences
New gates and tools are reviewed for what their message omits. Scorecard rungs report "not measured" with a reason, never a silent pass.
