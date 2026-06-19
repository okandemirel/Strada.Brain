# Plan 030: Docs discoverability + skills-lock decision + env-var coverage check

> **Executor instructions**: Follow step by step; run every verification command;
> on any "STOP condition", stop and report. Update `plans/README.md` when done.
> Steps A–C are independent — commit each separately.
>
> **Drift check (run first)**: `git status --short skills-lock.json && git diff --stat cc8f814..HEAD -- README.md CONTRIBUTING.md .gitignore`

## Status

- **Priority**: P4
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / docs
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

Three small, independent friction points: (A) `skills-lock.json` sits untracked
**and** un-ignored, leaving build/skill reproducibility ambiguous; (B) the README
doesn't surface the CHANGELOG or the existing skill-authoring guide, so version
history and community contribution paths are undiscoverable; (C) there's no check
that the ~282 env vars the config reads stay documented in `.env.example`, so
onboarding docs silently drift.

## Current state (verified)

- `git status` shows `?? skills-lock.json` (untracked; not in `.gitignore`). It records the active skill version/hash (`{ version: 1, … hash 431ada… }`).
- `CHANGELOG.md` exists at repo root; `README.md` (≈87 KB) never links to it.
- `CONTRIBUTING.md` has a complete "Creating a Skill" section (≈lines 165–290); `README.md` mentions the skill ecosystem but doesn't link that guide.
- `.env.example` exists (plan 002) documenting ~310 vars; `src/config/config.ts` declares env names in the `EnvVarName` union (lines 37–382). No script cross-checks them.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Run env audit | `node scripts/audit-env-coverage.mjs` | exits 0; prints any gaps |
| Verify skills-lock tracked OR ignored | `git check-ignore skills-lock.json \|\| git ls-files --error-unmatch skills-lock.json` | one of the two succeeds |
| Lint (if script touched) | `npm run lint:src` | exit 0 |

## Scope

**In scope**:
- `skills-lock.json` (commit it) **or** `.gitignore` (ignore it) — one choice, see Step A
- `README.md` (add two links)
- `scripts/audit-env-coverage.mjs` (new) + `package.json` (`"audit:env"` script)
- `CONTRIBUTING.md` (one line documenting the skills-lock decision)

**Out of scope** (do NOT touch):
- The 7 non-English `README.*.md` translations — they are already stale (separate translation-sync effort); editing one language's links without the others worsens drift. English `README.md` only here.
- Skill system internals; the meaning of the lock's hash.
- Making `audit:env` a blocking CI gate — keep it advisory in this plan.

## Git workflow

- Branch: `docs/030-discoverability-env`
- Commits: `chore(skills): track skills-lock.json` · `docs(readme): link changelog + skill guide` · `chore(dx): add env-var coverage audit script`.

## Steps

### Step A: Resolve `skills-lock.json`

Default recommendation: **commit it** (pins skill versions → reproducible skill
state across clones), and add a one-line note to `CONTRIBUTING.md` ("`skills-lock.json`
pins active skill versions; commit changes to it"). If the maintainer's intent is
that skills are local-only tooling, instead add `skills-lock.json` to `.gitignore`
and document that. Pick one; do not leave it untracked-and-unignored.

**Verify**: `git check-ignore skills-lock.json || git ls-files --error-unmatch skills-lock.json` succeeds (exactly one path holds).

### Step B: README links

In `README.md`, add (near the footer / a "More" or "Contributing" section):
- `See [CHANGELOG.md](CHANGELOG.md) for version history and breaking changes.`
- A short "Creating Skills" line linking the existing guide: `[skill authoring guide](CONTRIBUTING.md#creating-a-skill)`.

**Verify**: `grep -n "CHANGELOG.md" README.md` and `grep -n "creating-a-skill" README.md` each return a match.

### Step C: Env-var coverage script

Create `scripts/audit-env-coverage.mjs` that:
- extracts the env-var names from `src/config/config.ts` (the `EnvVarName` string-literal union, lines ~37–382),
- extracts documented var names from `.env.example`,
- prints two lists: **in code but not documented** and **documented but not in code**, then exits 0 (advisory — never fails the process).

Add `"audit:env": "node scripts/audit-env-coverage.mjs"` to `package.json` scripts.

**Verify**: `node scripts/audit-env-coverage.mjs` runs, prints a (possibly empty) gap report, exits 0.

## Test plan

- No unit tests (docs/tooling). Verification is the command outputs above.
- Sanity: the env-audit script must not crash on the real files and must exit 0 even when gaps exist (advisory contract).

## Done criteria

ALL must hold:

- [ ] `skills-lock.json` is either tracked or git-ignored (not both/neither); decision noted in `CONTRIBUTING.md`
- [ ] `README.md` links `CHANGELOG.md` and the skill-authoring guide
- [ ] `scripts/audit-env-coverage.mjs` + `audit:env` script exist; the script runs and exits 0
- [ ] No non-English README or out-of-scope file modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- There is a clear signal `skills-lock.json` must NOT be shared (contains a machine-local path/secret) — then gitignore it and report why; never commit secrets.
- The `EnvVarName` union can't be parsed by a simple extractor (format changed) — fall back to grepping `env["<NAME>"]` usages in `config.ts` and note the method in the script header.

## Maintenance notes

- Follow-up (separate effort, needs a translator): re-sync the 7 `README.*.md` translations to the current English README, and consider a CI check asserting section-header parity across languages.
- Consider promoting `audit:env` to a non-blocking CI step later (out of scope here).
