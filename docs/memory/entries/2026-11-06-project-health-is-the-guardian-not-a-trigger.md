---
id: project-health-is-the-guardian-not-a-trigger
kind: decision
tier: 1
status: active
topics: ["ops", "providers"]
paths: ["HEARTBEAT.md", "src/daemon/**", "src/core/bootstrap-stages/stage-daemon.ts"]
purpose: "Stop a periodic project check from being written as a HEARTBEAT.md trigger, where every fire is a model run even on a healthy project."
summary: "Project health is measured model-free by the real-tree guardian; HEARTBEAT.md ships no trigger, and a test fails if one opens a task on a healthy project"
decided_on: 2026-11-06
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
HEARTBEAT.md shipped a 5-minute cron trigger whose action was the sentence "Run periodic health check on the project". The heartbeat loop submits every trigger fire as an agent task, so every five minutes a model was asked to look at the project. In a live run these tasks filled the task list and each one waited on provider quota, though nothing was wrong. The real-tree guardian (`src/daemon/real-tree-guardian.ts`) already measured the same thing without a model: it compiles the real project every 15 minutes and after each write-back, plays it after a change, and opens one fix task only on a proven error.

## Decision
The health-check trigger is removed, and the guardian is the project's health check. `src/daemon/heartbeat-loop.shipped-triggers.test.ts` loads the shipped HEARTBEAT.md through the real loader and runs two hours of heartbeat: any task or `daemon:trigger_fired` fails it. A control case in the same file proves that the harness does see a cron trigger's tasks.

## Rejected alternatives
- **A cron trigger gated by a deterministic probe** (fire only when the probe finds something). The only probe worth having is the guardian's compile and play verdict, and the guardian already turns a red verdict into its single fix task. A second task on the same finding brings back two repairers on one tree, which `build-state-observer.ts` documents as oscillating.
- **A second model-free compile inside the trigger.** That duplicates the guardian's verifier and its convergence guards, and puts more headless Unity compiles every 5 minutes on top of the guardian's own.

## Consequences
A trigger in HEARTBEAT.md is for work that needs a model on every fire. A new periodic project check belongs in the guardian. If a check of another kind is ever needed, give it its own model-free measurement first, and let only a finding become a task.
