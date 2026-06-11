# Plan 005: Add a fast `verify` script (`typecheck + lint + test:fast`) for inner-loop development

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- package.json CONTRIBUTING.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

The only way to "run the tests" today is `npm test`, which executes the full
~5,900-test suite via `scripts/run-vitest-batches.mjs` — far too slow for an
edit-verify loop. Contributors (and AI agents working in this repo) need a
single fast command that gives high-signal confidence: typecheck + lint + a
curated quick test subset. This plan adds `test:fast` and `verify` scripts
and documents them, with a measured time budget (< ~90s for `test:fast`).

## Current state

- `package.json` (root, `strada-brain` v4.2.152) — relevant existing scripts,
  verbatim:

  ```json
  "lint:src": "eslint src/",
  "typecheck:src": "tsc --noEmit",
  "test": "node scripts/run-vitest-batches.mjs",
  "test:watch": "vitest",
  "test:file-build-flow": "LOCAL_DOTNET_TESTS=1 NODE_OPTIONS=--max-old-space-size=8192 vitest run src/tests/integration/file-build-flow.test.ts",
  ```

  There is no `test:fast` and no `verify` script. Existing `test:*` scripts
  show the repo convention: `NODE_OPTIONS=--max-old-space-size=8192 vitest run <paths>`.
- Candidate fast directories (test-file counts verified at `aea95ad`):
  - `src/config` — 3 test files
  - `src/utils` — 4 test files
  - `src/common` — 7 test files
  - `src/security` — 11 test files
  These are leads, NOT facts about runtime — you MUST measure (Step 1).
  Other plausible additions if budget allows: `src/types`, `src/budget`.
- `CONTRIBUTING.md` — has a `## Running Tests` section at line 107:

  ```
  ## Running Tests

  # Full suite (4,413+ tests)
  ...
  # Specific module
  ...
  # Watch mode
  ```

  and a separate `## Testing` conventions section at line 131. The new
  command belongs in `## Running Tests` (line 107 block).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Measure a candidate subset | `time NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/config src/security src/utils src/common` | all pass; note wall time |
| Run new script | `npm run test:fast` | all pass, < ~90s wall time |
| Run new verify | `npm run verify` | exit 0 |
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| JSON sanity | `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"` | `ok` |

## Scope

**In scope** (the only files you should modify):
- `package.json` (root — two new script entries only)
- `CONTRIBUTING.md` (the `## Running Tests` section only)

**Out of scope** (do NOT touch, even though they look related):
- `scripts/run-vitest-batches.mjs` and the `test` script — the full suite
  stays the authoritative gate.
- `web-portal/package.json` — the portal already has fast `test`/`typecheck`.
- Root `CLAUDE.md` / `AGENTS.md` — explicitly excluded by the operator.
- Any vitest config file — directory filters on the CLI are sufficient.
- Adding/changing any test file.

## Git workflow

- Branch: `advisor/005-add-fast-verify-command`
- One commit, conventional style, e.g.:
  `feat(dx): add test:fast and verify scripts for the inner dev loop`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Measure candidate subsets and pick one under ~90 seconds

Run, from the repo root:

```bash
time NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/config src/security src/utils src/common
```

Decision rule:
- If wall time < 90s and all tests pass → use these four dirs.
- If < 60s → optionally also measure with `src/budget` and/or `src/types`
  appended; keep additions only while staying < 90s.
- If ≥ 90s → measure each dir individually
  (`time ... npx vitest run src/security`, etc.) and drop the slowest
  dir(s) until the combined run is < 90s, preferring to keep `src/security`
  and `src/config` (highest signal: validation + security invariants).
- If any test in the chosen subset FAILS at baseline (unmodified repo),
  that's a STOP condition — a fast-verify script that starts red is useless.

Record the final dir list and measured time for the commit message.

**Verify**: the chosen subset command exits 0 and `time` reports total wall
time under 90 seconds.

### Step 2: Add the scripts to package.json

In root `package.json` `"scripts"`, add (adjusting the dir list to Step 1's
result; keep the order: `test:fast` next to the other `test:*` entries,
`verify` after it):

```json
"test:fast": "NODE_OPTIONS=--max-old-space-size=8192 vitest run src/config src/security src/utils src/common",
"verify": "npm run typecheck:src && npm run lint:src && npm run test:fast",
```

Note: `verify` deliberately uses the `:src`-scoped typecheck/lint (the
portal has its own loop via `npm --prefix web-portal run ...`).

**Verify**:
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"` → `ok`
- `npm run test:fast` → all pass, wall time < 90s
- `npm run verify` → exit 0

### Step 3: Document in CONTRIBUTING.md

Read the `## Running Tests` section (starts line 107) and add the fast path
as the FIRST example in its code block, so it reads in this spirit:

```bash
# Fast inner-loop check: typecheck + lint + quick high-signal test subset (<90s)
npm run verify

# Quick test subset only
npm run test:fast

# Full suite (...)
npm test
...
```

Keep the existing entries (full suite, specific module, watch mode,
unity-fixture note) intact — only add, don't rewrite.

**Verify**: `grep -n "npm run verify" CONTRIBUTING.md` → 1 match inside the
`## Running Tests` section; `git diff --stat CONTRIBUTING.md` → 1 file
changed, additions only (no deletions besides possible whitespace).

## Test plan

No new test files — the deliverable IS a test command. The gates:

- `npm run test:fast` → all tests in the chosen subset pass.
- `npm run verify` → exit 0 end-to-end.
- `npm run typecheck:src` and `npm run lint:src` individually exit 0
  (proves `verify`'s chain components are healthy in isolation).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node -e "const s=JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts; console.log(s['test:fast']&&s['verify']?'ok':'missing')"` → `ok`
- [ ] `npm run verify` exits 0
- [ ] `time npm run test:fast` wall time < 90 seconds (state the measured time in your final report)
- [ ] `grep -c "npm run verify" CONTRIBUTING.md` → ≥ 1
- [ ] `git status --porcelain` shows only `package.json` and `CONTRIBUTING.md` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any baseline test in the candidate dirs fails on the unmodified repo
  (report which file — do not fix or skip tests, that's out of scope).
- No combination of ≥ 3 of the candidate dirs fits under 90s on this machine
  (report the per-dir timings instead of shipping a misleadingly tiny subset).
- `NODE_OPTIONS` inline env assignment fails on the target shell (the repo's
  existing `test:file-build-flow` script uses the same pattern, so this
  would indicate environment drift — report it).

## Maintenance notes

- The subset is curated, so it will drift: when new fast, high-signal test
  dirs appear (or a chosen dir grows slow), update `test:fast`. A quarterly
  re-measure is enough.
- `verify` is intentionally NOT wired into CI or git hooks here — CI runs the
  full suite. If someone later adds a pre-push hook, `verify` is the right
  command for it.
- Reviewer should scrutinize: that `test:fast` was actually measured (the
  commit message should state the time) and that CONTRIBUTING.md presents
  `verify` as the inner loop, not a replacement for `npm test` before a PR.
