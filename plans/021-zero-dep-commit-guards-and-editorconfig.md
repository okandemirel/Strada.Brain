# Plan 021: Zero-dependency commit-time lint guard + `.editorconfig`

> **Executor instructions**: Follow step by step. Run every verification command.
> On any "STOP condition", stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- package.json eslint.config.js .prettierrc`
> If changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

There is no commit-time feedback loop: lint/typecheck failures are only caught in
CI 5–15 minutes later. There is no `.editorconfig`, so contributors on different
editors (and the project's `.cs`/Unity users) produce whitespace/EOL noise. The
fix must respect a hard repo constraint.

## Hard constraint (do not violate)

`AGENTS.md` → **"Do NOT add new npm dependencies — the project maintains a minimal
dependency policy."** Therefore **do NOT add `husky`, `lint-staged`, `prettier`,
or any package.** This plan uses a **native git hook** (a committed shell script)
and a static `.editorconfig` — zero new dependencies. (Also: `prettier` is *not*
currently an installed dependency even though `.prettierrc` exists, so a
`prettier --write` script would itself require a new dep — out of scope here.)

## Current state

- Hooks: only `.git/hooks/pre-push` exists (a non-versioned auto-updater hook). No `pre-commit`. No `.husky/`.
- `package.json` scripts include: `lint:src` = `eslint src/`, `typecheck:src` = `tsc --noEmit`, `verify` = typecheck:src + lint:src + test:fast. No `format` script.
- `eslint.config.js` is a flat config (blocks `no-eval`/`no-implied-eval`/`no-new-func`, warns `no-console`/`no-explicit-any`); test/CLI files relax rules.
- `.prettierrc` exists: `{ semi:true, singleQuote:false, tabWidth:2, trailingComma:"all", printWidth:100, arrowParens:"always" }` — `.editorconfig` should mirror these for non-JS files and editors without Prettier.
- Convention: conventional commits; branch prefixes `fix/ feat/ refactor/ test/ docs/ chore/`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint (src) | `npm run lint:src` | exit 0 |
| Install (runs `prepare`) | `npm install` | exit 0; hook installed |
| Hook present | `test -x .git/hooks/pre-commit && echo ok` | `ok` |
| Editorconfig present | `test -f .editorconfig && echo ok` | `ok` |

## Scope

**In scope** (create/modify only these):
- `.editorconfig` (new)
- `scripts/git-hooks/pre-commit` (new, committed, executable — the source of truth)
- `scripts/install-git-hooks.mjs` (new — copies the hook into `.git/hooks/` without disturbing the existing `pre-push`)
- `package.json` — add a `"prepare"` script that runs the installer (and a `"hooks:install"` alias)

**Out of scope** (do NOT touch / add):
- `husky`, `lint-staged`, `prettier`, or any npm dependency.
- `core.hooksPath` (it would disable the existing un-versioned `.git/hooks/pre-push`). Install into `.git/hooks/` directly instead.
- The existing `.git/hooks/pre-push` file.
- `eslint.config.js` / `.prettierrc` content.

## Git workflow

- Branch: `chore/021-commit-guards`
- Commit: `chore(dx): add zero-dep pre-commit lint guard and .editorconfig`

## Steps

### Step 1: `.editorconfig`

Create `.editorconfig` mirroring `.prettierrc` and Unity conventions:
```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false

[*.cs]
indent_size = 4

[*.{yml,yaml}]
indent_size = 2
```

**Verify**: `test -f .editorconfig && echo ok` → `ok`.

### Step 2: The committed hook script

Create `scripts/git-hooks/pre-commit` (executable, `chmod +x`):
```sh
#!/bin/sh
# Zero-dep pre-commit guard. Lints staged TS under src/. Bypass with `git commit --no-verify`.
staged=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^src/.*\.ts$' || true)
[ -z "$staged" ] && exit 0
echo "[pre-commit] eslint on staged src/*.ts…"
npx --no-install eslint $staged || {
  echo "[pre-commit] lint failed — fix or commit with --no-verify"; exit 1;
}
```
(Use `npx --no-install eslint` so it uses the local eslint already in `devDependencies`; no download. Lint only staged files to keep it fast.)

### Step 3: The installer + `prepare` wiring

Create `scripts/install-git-hooks.mjs` that, when a `.git/hooks` directory exists,
copies `scripts/git-hooks/pre-commit` to `.git/hooks/pre-commit` and `chmod 0755`s
it. It must be a no-op (exit 0) when `.git` is absent (e.g. installed as a
dependency / CI checkout without hooks) so `npm install` never fails.

In `package.json` scripts add:
```json
"prepare": "node scripts/install-git-hooks.mjs",
"hooks:install": "node scripts/install-git-hooks.mjs"
```
If a `prepare` script already exists (drift), STOP and report — do not overwrite it.

**Verify**: `npm install` → exit 0; `test -x .git/hooks/pre-commit && echo ok` → `ok`; the existing `.git/hooks/pre-push` still present (`test -f .git/hooks/pre-push && echo kept`).

### Step 4: Smoke-test the guard

Introduce a deliberate lint error in a scratch staged `src/**.ts`, attempt a
commit, confirm it is blocked; remove the error; confirm commit proceeds. (Do not
leave the scratch change committed.)

**Verify**: blocked commit on lint error; clean commit passes; `npm run lint:src` → 0.

## Test plan

- No unit tests (tooling). Verification is the smoke test in Step 4 + the install no-op behavior.
- Confirm `node scripts/install-git-hooks.mjs` exits 0 in a directory without `.git` (simulate by running from `/tmp`), proving CI/dependency installs won't break.

## Done criteria

ALL must hold:

- [ ] `.editorconfig` exists with the rules above
- [ ] `scripts/git-hooks/pre-commit` exists, executable, lints staged `src/*.ts`
- [ ] `scripts/install-git-hooks.mjs` installs into `.git/hooks/pre-commit`, no-ops without `.git`
- [ ] `package.json` has `prepare` + `hooks:install`; existing `.git/hooks/pre-push` preserved
- [ ] No new npm dependency added (`git diff package.json` shows no `dependencies`/`devDependencies` change)
- [ ] `plans/README.md` row updated

## STOP conditions

- A `prepare` script already exists in `package.json` (would be overwritten) — STOP, report, propose merging.
- The local `eslint` binary is not resolvable via `npx --no-install` (devDep missing) — STOP; do not add it here.
- The team prefers `husky` despite the minimal-dep policy — that is a policy decision for the maintainer; STOP and surface it rather than adding the dep.

## Maintenance notes

- The hook is intentionally lint-only (fast). Typecheck/test stay in CI and the existing pre-push. If commits get slow, keep the staged-only scope.
- `--no-verify` remains an escape hatch; CI is the real gate (this is defense-in-depth, not the wall).
- Considered & rejected: `husky`+`lint-staged` — violates the minimal-dependency policy in `AGENTS.md`; native hook achieves the same with zero deps.
