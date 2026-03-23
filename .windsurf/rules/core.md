---
trigger: glob
globs: src/core/**,src/agents/**,src/agent-core/**
---

# Core & Agent Rules

- Orchestrator uses PAOR loop (Plan → Act → Observe → Reflect)
- Large files delegate to focused helper modules — extract, don't grow
- Bootstrap pipeline: providers → memory → channels → wiring
- Event communication via TypedEventBus — don't bypass with direct calls
- Agent sessions isolated per-channel — never share state across channels
- DelegationManager max depth: 2
- Orchestrator/bootstrap changes require careful review
