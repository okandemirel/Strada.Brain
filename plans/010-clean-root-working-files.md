# Plan 010: Remove committed working artifacts from the repo root

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat aea95ad..HEAD -- action-items.md action-items-phase2.md analysis-report.md analysis-report-phase2.md unified-action-items.md .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" facts against the live repo before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

Five stale audit work logs from a May 2026 analysis session are committed in the repository root of a public open-source project (github.com/okandemirel/Strada.Brain). They reference line numbers that have long since drifted, clutter the root next to README/SECURITY/CONTRIBUTING, and (analysis reports especially) advertise internal security findings. Removing them keeps the published root clean; any still-open items get archived first so nothing actionable is lost.

## Current state

Verified via `git ls-files` at commit `aea95ad` — all five files exist, are tracked, and were last committed in `f24f3d7` (2026-05-06):

- `action-items.md` (~16 KB) — Turkish prioritized action list (P0-P3 tables) from the 2026-05-05 static analysis.
- `action-items-phase2.md` (~24 KB) — English Phase 2 (runtime analysis) action items, incl. security findings with file:line locations.
- `analysis-report.md` (~28 KB) — Turkish "Derinlemesine Agent Swarm Sistem Analizi" report, 2026-05-05.
- `analysis-report-phase2.md` (~23 KB) — English Phase 2 deep system analysis report.
- `unified-action-items.md` (~12 KB) — merged Phase 1+2 prioritized list (~462 findings). Contains 1 unchecked checkbox-style item per `grep -c "TODO\|\[ \]"`.

Related context:
- MEMORY/project records indicate the 2026-04-06 → 2026-04-08 and later sessions already fixed the bug backlog from these audits ("All bugs fixed" per project_known_bugs_testing), so most items are expected to be done — but the executor must verify by skimming, not assume.
- `docs/` structure: `docs/README.md`, `docs/deployment/`, `docs/specs/` (dated design/spec documents like `2026-03-22-orchestrator-stage5-maximal-extraction.md`), `docs/superpowers/`, plus `vault.*.md` translations. There is NO existing open-items tracking doc — `docs/specs/` with a dated filename is the conventional home for a dated archive document.
- `.gitignore` ALREADY contains `*.log` (line 5), `*.tsbuildinfo` (line 6), and `*.tgz` (line 19) — the untracked root litter (`firebase-debug.log`, `test.log`, `strada-brain*.log`, `strada-brain-0.1.0.tgz`, `tsconfig.tsbuildinfo`) is already ignored. **No .gitignore changes are needed**; Step 1 just confirms this.
- `HEARTBEAT.md` and `soul.md` in the root are FUNCTIONAL files (agent heartbeat/personality) — not litter.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|--------------------------|---------------------|
| Confirm tracked | `git ls-files \| grep -E "^(action-items\|analysis-report\|unified-action-items)"` | lists exactly 5 files |
| Confirm ignore coverage | `git check-ignore firebase-debug.log test.log strada-brain.log strada-brain-0.1.0.tgz tsconfig.tsbuildinfo` | prints all 5 names, exit 0 |
| Remove | `git rm action-items.md action-items-phase2.md analysis-report.md analysis-report-phase2.md unified-action-items.md` | 5 `rm` lines |
| Typecheck (sanity) | `npm run typecheck:src` | exit 0 |

## Scope

**In scope**:
- Delete (git rm): `action-items.md`, `action-items-phase2.md`, `analysis-report.md`, `analysis-report-phase2.md`, `unified-action-items.md`
- Create (only if surviving open items exist): `docs/specs/2026-06-11-root-audit-archive.md`

**Out of scope** (do NOT touch):
- The untracked root files themselves (`firebase-debug.log`, `test.log`, `strada-brain*.log`, `*.tgz`, `tsconfig.tsbuildinfo`, `skills-lock.json`) — deleting local files is the operator's call.
- `.gitignore` — verified already covering `*.log` / `*.tgz` / `*.tsbuildinfo`; only edit it if Step 1's verification FAILS (then add exactly the missing pattern, nothing more).
- `HEARTBEAT.md`, `soul.md`, `AGENTS.md`, `GEMINI.md`, `CHANGELOG.md`, all `README*.md`, `SECURITY.md`, `CONTRIBUTING.md` — functional/published root files.
- `.plans/` directory — separate tracked work logs, not this plan's concern.
- `package.json` `files` array — none of the 5 files are listed there (verified), so no packaging change.

## Git workflow

- Branch: `advisor/010-clean-root-working-files`
- Conventional commits, e.g. `chore: remove stale audit work logs from repo root`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm .gitignore coverage (no edit expected)

Run: `git check-ignore firebase-debug.log test.log strada-brain.log strada-brain-error.log strada-brain-sync.log strada-brain-0.1.0.tgz tsconfig.tsbuildinfo`

**Verify**: command prints all 7 paths and exits 0. If any path is missing from the output, add ONLY the corresponding pattern to `.gitignore` and re-run; if it still fails, STOP.

### Step 2: Skim each file and extract surviving open items

For each of the 5 files, read it and list items that are (a) explicitly marked open/unchecked, or (b) P0/P1 findings with no evidence of completion. Cross-check candidates against the current code before declaring them "surviving" — e.g. `action-items.md` item 1 cites `src/core/bootstrap-channels.ts:29` (Slack bootstrap); check whether Slack is now wired in `src/core/bootstrap-channels.ts` before carrying the item forward. Spot-check at most the P0/P1 rows this way; P2/P3 rows may be carried forward on the file's say-so with a "(unverified)" marker.

Expected outcome: few or zero survivors (later sessions report the backlog as fixed: see memory note "project_known_bugs_testing — All bugs fixed (2026-04-06 audit + 2026-04-08 portal fixes)").

**Verify**: you have a written list (possibly empty) of surviving items, each with source file + original location reference.

### Step 3: Archive survivors (conditional)

- If the survivors list is NON-empty: create `docs/specs/2026-06-11-root-audit-archive.md` containing: a 3-line preamble (what the 5 deleted files were, commit `f24f3d7` as the historical reference — note the full reports remain retrievable via `git show f24f3d7:analysis-report.md` etc.), then the surviving items grouped by priority with their original file/line citations and a "(unverified)" marker where applicable.
- If the list is empty: skip this step entirely; do NOT create the file.

**Verify**: if created — file exists and `git status` shows it as new; if skipped — note "no survivors" for the final report.

### Step 4: Remove the 5 files

`git rm action-items.md action-items-phase2.md analysis-report.md analysis-report-phase2.md unified-action-items.md`

Then check nothing references them: `grep -rn "action-items.md\|analysis-report.md\|unified-action-items" --include="*.md" --include="*.ts" --include="*.json" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=plans 2>/dev/null` — expect no matches outside `docs/specs/2026-06-11-root-audit-archive.md` (if created) and historical `.planning`/`.plans` notes (acceptable, they are logs).

**Verify**: `git ls-files | grep -E "^(action-items|analysis-report|unified-action-items)"` → no output. `git status` shows exactly 5 deletions (+1 optional new archive file).

### Step 5: Commit

One commit; include the archive file (if any) in the same commit so history is self-explanatory.

**Verify**: `git show --stat HEAD` lists exactly the expected files. `npm run typecheck:src` → exit 0 (sanity that nothing else was disturbed).

## Test plan

No code changes — no new tests. Sanity gate only: `npm run typecheck:src` exits 0 and `git status` is clean after commit.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git ls-files | grep -E "^(action-items|analysis-report|unified-action-items)"` returns nothing
- [ ] `git check-ignore firebase-debug.log strada-brain-0.1.0.tgz tsconfig.tsbuildinfo` exits 0
- [ ] Surviving open items (if any) are listed in `docs/specs/2026-06-11-root-audit-archive.md`; otherwise that file does not exist
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `npm run typecheck:src` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any of the 5 files is referenced by code, CI config, or `package.json` (grep in Step 4 hits a non-log file).
- More than ~10 P0/P1 items appear genuinely unresolved during Step 2 — that means the "backlog already fixed" assumption is false and a human should re-triage rather than have this plan archive a live backlog.
- Step 1's `git check-ignore` fails even after adding the single missing pattern.

## Maintenance notes

- Future audit sessions should write reports under a gitignored directory (`.planning/` is already ignored) instead of the repo root — reviewers should call this out if it recurs.
- The full deleted reports remain accessible via `git show f24f3d7:<filename>`.
- Explicitly deferred: deleting the untracked local log/tgz files and deciding what `skills-lock.json` is (untracked, not ignored) — operator's call.
