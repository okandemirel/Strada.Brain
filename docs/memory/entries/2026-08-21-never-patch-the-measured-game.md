---
id: never-patch-the-measured-game
kind: decision
tier: 0
tier_reason: "The product's whole claim is measured by runs; one hand patch silently invalidates a run."
status: active
topics: ["process", "campaign"]
paths: ["src/campaign/**", "src/agents/**"]
purpose: "Stop a developing agent from fixing a game project that Strada.Brain is building, which turns a measurement into an anecdote."
summary: "Fix the system that failed, never the game it is building"
decided_on: 2026-08-21
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
The owner measures one thing: whether Strada.Brain can take a design document and produce a finished game without help. On 2026-08-21 most of the day's game commits carried the developing agent's trailer, and a milestone reported as progress was the agent's work, not the system's. The owner had already said the system itself must diagnose and solve these problems.

## Decision
Work on Strada.Brain, Strada.MCP and Strada.Core, the system. Never work on the game project a run is building. When a run produces broken output, that is the finding: fix whatever in the system failed to catch or correct it, and let the next run try again. When reporting a milestone, say who produced it, and check the commit trailers.

## Rejected alternatives
- **Patch the game to unblock the run and keep measuring.** A state the developer built and a state the system built look identical in the repository and mean opposite things.
- **Patch, then revert before the next run.** The run in between has already learned from, and been judged on, a tree the system did not make.

## Consequences
Setup steps that are not game work, such as installing the framework submodules, are recorded as setup and kept separate from the run. A run whose project was hand-edited is not counted.
