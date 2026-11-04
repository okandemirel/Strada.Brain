---
id: tightening-a-gate-cuts-both-ways
kind: guideline
tier: 1
status: active
topics: ["evidence", "campaign"]
paths: ["src/campaign/**", "src/agents/autonomy/**"]
purpose: "Stop a stricter gate from hiding a real failure as 'not measured'."
summary: "Test both directions when tightening a gate: the false green it stops and the real failure it must still report"
decided_on: 2026-09-12
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Making the compile gate read the tool's error flag first stopped "editor not found" from reporting a zero-error compile. It also turned a completed compile with dozens of errors into `ran: false`. The milestone gate blocks only on `ran && !ok`, so real compile errors advanced the ladder unseen. Two other cases had the same shape: a filter that stopped conflicts started discarding authored models, and a timestamp check that protected the worker's edit published over an untracked file.

## Decision
For each gate change, write the mutant for the defect, and also a test for the opposite input: a genuine failure, an authored file, a person's edit. Ask what reads the gate's output downstream. For the caller, "not measured" and "failed" are not the same.

## Rejected alternatives
- **Test only the false green the change targets.** That is how each of the three regressions above shipped.

## Consequences
A gate change's commit names both directions it was tested in.
