<!-- DERIVED from docs/memory/entries by `node scripts/memory-index.mjs`. Do not edit or hand-merge: regenerate. -->
# Team memory — index

Scan the topic you are about to work in, and open only the entries that match. Policy: `POLICY.md`.

## agent-loop

- [guideline] (core) Every verdict names what it measured, what it left out, and why — `entries/2026-08-21-evidence-names-what-it-measured.md` · src/**
- [gotcha] Unit tests that build their own subject cannot see an argument nobody passes; check the construction site — `entries/2026-09-18-tested-but-never-wired.md` · src/core/bootstrap.ts, src/agents/multi/agent-manager.ts, src/agents/multi/delegation-manager.ts
- [spike] Mask old tool output deterministically, but as a rare cliff with byte-stable stubs, and only after the cache hit rate is measured — `entries/2026-11-04-compaction-must-respect-the-prefix-cache.md` · src/agents/session-compaction.ts, src/agents/providers/provider-call-log.ts, src/agents/compaction-replay/**, scripts/eval/compaction-replay.mjs
- [decision] A path-guard target refusal leaves the verifier's open failures once a later call of the same tool succeeds; a tool that ran and failed still waits for a verification — `entries/2026-11-06-a-refused-target-closes-on-the-next-success.md` · src/agents/autonomy/completion-review.ts, src/agents/autonomy/verifier-pipeline.ts, src/security/path-guard.ts
- [decision] The worker's system prompt is the run's prompt, byte for byte; per-step sections ride after the history as an unstored turn context, and mid-run memory recall is appended to the history once — `entries/2026-11-06-system-prompt-is-byte-stable.md` · src/agents/turn-context.ts, src/agents/recall-ledger.ts, src/agent-core/engine/prepare-iteration.ts, src/agent-core/engine/tool-turn.ts, src/agent-core/engine/port.ts, src/agents/orchestrator-loop-shared.ts, src/agents/orchestrator.ts, src/agents/orchestrator-session-manager.ts
- [decision] The worker's tool list is the run's list in every phase and role; a write called while planning, replanning or reflecting is refused where it runs, and the turn context says so — `entries/2026-11-11-tool-list-is-byte-stable.md` · src/agent-core/engine/phase-write-access.ts, src/agent-core/engine/prepare-iteration.ts, src/agent-core/runner/v2-agent-runner.ts, src/agents/orchestrator.ts

## campaign

- [decision] (core) Fix the system that failed, never the game it is building — `entries/2026-08-21-never-patch-the-measured-game.md` · src/campaign/**, src/agents/**
- [guideline] Test both directions when tightening a gate: the false green it stops and the real failure it must still report — `entries/2026-09-12-tightening-a-gate-cuts-both-ways.md` · src/campaign/**, src/agents/autonomy/**

## unity-mcp

- [gotcha] A run loads Strada.MCP from the game's vendored submodule, not from the standalone repository — `entries/2026-08-22-mcp-fixes-reach-runs-via-the-submodule.md` · src/config/strada-deps.ts, src/core/strada-mcp-tool-loader.ts
- [gotcha] A vendored Strada.MCP needs npm install inside it, or every Unity tool silently vanishes — `entries/2026-08-23-vendored-mcp-needs-its-dependencies.md` · src/config/strada-deps.ts, src/core/terminal-wizard.ts

## providers

- [gotcha] Provider cooldowns persist across restarts in provider-health.json; read it first when every call is refused — `entries/2026-09-10-key-rotation-inherits-cooldown.md` · src/agents/providers/**
- [spike] Mask old tool output deterministically, but as a rare cliff with byte-stable stubs, and only after the cache hit rate is measured — `entries/2026-11-04-compaction-must-respect-the-prefix-cache.md` · src/agents/session-compaction.ts, src/agents/providers/provider-call-log.ts, src/agents/compaction-replay/**, scripts/eval/compaction-replay.mjs
- [decision] Project health is measured model-free by the real-tree guardian; HEARTBEAT.md ships no trigger, and a test fails if one opens a task on a healthy project — `entries/2026-11-06-project-health-is-the-guardian-not-a-trigger.md` · HEARTBEAT.md, src/daemon/**, src/core/bootstrap-stages/stage-daemon.ts
- [decision] The worker's system prompt is the run's prompt, byte for byte; per-step sections ride after the history as an unstored turn context, and mid-run memory recall is appended to the history once — `entries/2026-11-06-system-prompt-is-byte-stable.md` · src/agents/turn-context.ts, src/agents/recall-ledger.ts, src/agent-core/engine/prepare-iteration.ts, src/agent-core/engine/tool-turn.ts, src/agent-core/engine/port.ts, src/agents/orchestrator-loop-shared.ts, src/agents/orchestrator.ts, src/agents/orchestrator-session-manager.ts
- [decision] The worker's tool list is the run's list in every phase and role; a write called while planning, replanning or reflecting is refused where it runs, and the turn context says so — `entries/2026-11-11-tool-list-is-byte-stable.md` · src/agent-core/engine/phase-write-access.ts, src/agent-core/engine/prepare-iteration.ts, src/agent-core/runner/v2-agent-runner.ts, src/agents/orchestrator.ts

## learning-memory

- [gotcha] Unit tests that build their own subject cannot see an argument nobody passes; check the construction site — `entries/2026-09-18-tested-but-never-wired.md` · src/core/bootstrap.ts, src/agents/multi/agent-manager.ts, src/agents/multi/delegation-manager.ts

## evidence

- [guideline] (core) Every verdict names what it measured, what it left out, and why — `entries/2026-08-21-evidence-names-what-it-measured.md` · src/**
- [guideline] (core) A fix is finished only when its test is shown to fail without it — `entries/2026-08-21-mutation-check-every-fix.md` · src/**, scripts/**
- [guideline] Test both directions when tightening a gate: the false green it stops and the real failure it must still report — `entries/2026-09-12-tightening-a-gate-cuts-both-ways.md` · src/campaign/**, src/agents/autonomy/**
- [decision] A path-guard target refusal leaves the verifier's open failures once a later call of the same tool succeeds; a tool that ran and failed still waits for a verification — `entries/2026-11-06-a-refused-target-closes-on-the-next-success.md` · src/agents/autonomy/completion-review.ts, src/agents/autonomy/verifier-pipeline.ts, src/security/path-guard.ts

## process

- [guideline] (core) A fix is finished only when its test is shown to fail without it — `entries/2026-08-21-mutation-check-every-fix.md` · src/**, scripts/**
- [decision] (core) Fix the system that failed, never the game it is building — `entries/2026-08-21-never-patch-the-measured-game.md` · src/campaign/**, src/agents/**
- [gotcha] Back up .env to scratch space, never beside the original — `entries/2026-08-22-env-backups-stay-out-of-the-repo.md` · .env*, .gitignore
- [decision] Order comes from a sequence, identity from (host, pid), and another process's lock file is never removed — `entries/2026-09-18-a-clock-is-not-an-order.md` · src/budget/**, src/common/**
- [decision] (core) Speed and regression safety rank above new features, and every gate lives in hooks or CI — `entries/2026-11-04-speed-and-regression-safety-first.md` · **

## ops

- [gotcha] Back up .env to scratch space, never beside the original — `entries/2026-08-22-env-backups-stay-out-of-the-repo.md` · .env*, .gitignore
- [gotcha] A vendored Strada.MCP needs npm install inside it, or every Unity tool silently vanishes — `entries/2026-08-23-vendored-mcp-needs-its-dependencies.md` · src/config/strada-deps.ts, src/core/terminal-wizard.ts
- [gotcha] Provider cooldowns persist across restarts in provider-health.json; read it first when every call is refused — `entries/2026-09-10-key-rotation-inherits-cooldown.md` · src/agents/providers/**
- [decision] Order comes from a sequence, identity from (host, pid), and another process's lock file is never removed — `entries/2026-09-18-a-clock-is-not-an-order.md` · src/budget/**, src/common/**
- [decision] Project health is measured model-free by the real-tree guardian; HEARTBEAT.md ships no trigger, and a test fails if one opens a task on a healthy project — `entries/2026-11-06-project-health-is-the-guardian-not-a-trigger.md` · HEARTBEAT.md, src/daemon/**, src/core/bootstrap-stages/stage-daemon.ts
