# 2026-06-11 — Root Audit Archive (surviving open items)

Five working files from the 2026-05-05/06 audit session (`action-items.md`,
`action-items-phase2.md`, `analysis-report.md`, `analysis-report-phase2.md`,
`unified-action-items.md`, ~462 findings / 267 action items) were removed from
the repository root; the full reports remain retrievable from history at commit
`f24f3d7`, e.g. `git show f24f3d7:analysis-report.md`.

The backlog was substantially fixed in the commit series `0dacbdb`…`810f756`
("resolve … P0/P1 issues from Phase 2 analysis") and later sessions. Every
P0 row and the highest-stakes P1 rows were re-checked against the code at
commit `aea95ad` on 2026-06-11; the items below are the only ones found still
open. No explicitly unchecked checkbox items existed in the deleted files (the
single `grep "TODO\|\[ \]"` hit was row text mentioning TODO comments, not an
open checkbox).

## Surviving P0 items

1. **No sandboxing for skills/plugins** — original: `unified-action-items.md`
   P0 #7 / `action-items-phase2.md` P0-4 / `analysis-report.md` #17 ("Plugin
   Sandbox Yok — PluginPermissions Dekoratif"). Verified 2026-06-11:
   `src/plugins/registry.ts` declares a `PluginPermissions` manifest and
   documents worker_threads sandboxing in comments, but no worker_threads/vm
   isolation is implemented under `src/plugins/` or `src/skills/`. Partially
   mitigated by skill gating (`src/skills/skill-gating.ts`) and read-only-mode
   blocking of shell-strategy dynamic tools.
2. **Zero alerting** — original: `unified-action-items.md` P0 #27 /
   `action-items-phase2.md` P0-16. Verified 2026-06-11:
   `monitoring/prometheus.yml` still has `alertmanagers` and `rule_files`
   commented out (lines 14–20); no alert rules exist anywhere in the repo.
3. **Zero tracing / no correlation IDs** — original: `unified-action-items.md`
   P0 #28 / `action-items-phase2.md` P0-17. Verified 2026-06-11:
   `correlationId` appears only as an optional field on
   `src/audit/security-audit.ts:73`; the logger has no correlationId/spanId
   propagation across subsystems.

## Surviving P1 items

4. **Shell-strategy dynamic tools inherit the full `process.env`** — original:
   `unified-action-items.md` P1 Security ("Dynamic tool factory leaks full
   process.env to shell tools"). Verified 2026-06-11:
   `src/agents/tools/dynamic/dynamic-tool-factory.ts:271` passes
   `env: process.env` to `execAsync`, exposing provider API keys and other
   secrets to generated shell commands.
5. **`create_tool` not classified destructive under DM Policy** — original:
   `unified-action-items.md` P1 Security ("`create_tool` tool itself not under
   DM Policy"). Verified 2026-06-11: `DESTRUCTIVE_TOOLS` in
   `src/security/dm-policy.ts:20-27` lists only file/shell/git tools; minting a
   new dynamic tool (including shell-strategy ones) requires no DM
   confirmation.

## Notes

- The web channel's hard-coded `127.0.0.1` bind
  (`src/channels/web/channel.ts:281`), flagged by the audit as a Docker
  blocker, is a documented deliberate security decision and is not carried
  forward as an open item.
- P2/P3 rows were not individually re-verified; consult
  `git show f24f3d7:unified-action-items.md` if a future triage wants the full
  list.
