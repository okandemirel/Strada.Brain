# Plan 001: Clear all npm audit advisories (react-router in web-portal, qs at root)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- web-portal/package.json web-portal/package-lock.json package.json package-lock.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`npm audit` in `web-portal/` reports 2 high-severity advisories rooted in
react-router 7.0.0–7.14.2 (6 CVEs total: GHSA-49rj-9fvp-4h2h unauth RCE via
vendored turbo-stream, GHSA-8646-j5j9-6r62 XSS in RSC redirects,
GHSA-f22v-gfqf-p8f3 stored XSS in prerendered redirects, GHSA-2j2x-hqr9-3h42
open redirect, and 2 DoS advisories). Honest exposure assessment: the
web-portal is a client-side Vite SPA using only `BrowserRouter`, `Routes`,
`Route`, `NavLink`, `Outlet`, `useNavigate`, `useLocation`, and `MemoryRouter`
(tests) — it does not use framework mode, SSR, RSC, single-fetch, or
prerendering, which is where most of these CVEs live (including the RCE).
Practical exploitability here is low, but the advisories are real, fail
`npm run security:audit` style gates, and the fix is a semver-compatible
lockfile bump. The root repo additionally reports a moderate qs DoS
(GHSA-q8mj-m7cp-5q26), transitive via `@slack/bolt@4.6.0 → express@5.2.1 →
body-parser → qs@6.15.0`. Both fixes are "available via npm audit fix".

## Current state

- `web-portal/package.json` — declares `"react-router-dom": "^7.13.1"` in
  `dependencies`. The caret range already allows the patched 7.14.3+; only the
  lockfile pins the vulnerable version.
- `web-portal/package-lock.json` — pins `react-router` / `react-router-dom`
  inside the vulnerable 7.0.0–7.14.2 range.
- `package-lock.json` (root) — pins `qs@6.15.0` (vulnerable range
  6.11.1–6.15.1), transitive only; `qs` is not a direct dependency.

Verified audit output as of `aea95ad`:

```
$ cd web-portal && npm audit
react-router  7.0.0 - 7.14.2   Severity: high   (6 advisories)
fix available via `npm audit fix`
2 high severity vulnerabilities

$ npm audit            # repo root
qs  6.11.1 - 6.15.1    Severity: moderate  (GHSA-q8mj-m7cp-5q26)
fix available via `npm audit fix`
1 moderate severity vulnerability
```

react-router usage in the portal (verified — all plain SPA APIs):

- `web-portal/src/main.tsx` — `BrowserRouter`
- `web-portal/src/App.tsx` — `Routes`, `Route`
- `web-portal/src/components/layout/AppLayout.tsx` — `Outlet`
- `web-portal/src/components/layout/Sidebar.tsx`, `AdminNav.tsx`,
  `BottomTabBar.tsx` — `NavLink`, `useNavigate`, `useLocation`
- `*.test.tsx` files — `MemoryRouter`

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Audit fix (portal) | `cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npm audit fix` | exit 0 |
| Audit check (portal) | `cd web-portal && npm audit --audit-level=high` | exit 0, "found 0 vulnerabilities" or no high/critical |
| Audit fix (root) | `npm audit fix` (repo root) | exit 0 |
| Audit check (root) | `npm audit --audit-level=high` | exit 0 |
| Portal typecheck | `npm --prefix web-portal run typecheck` | exit 0 |
| Portal lint | `npm --prefix web-portal run lint` | exit 0 |
| Portal tests | `npm --prefix web-portal run test` | all pass |
| Portal build | `npm --prefix web-portal run build` | exit 0 |
| Root typecheck | `npm run typecheck:src` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `web-portal/package-lock.json`
- `web-portal/package.json` (only if `npm audit fix` updates the range itself)
- `package-lock.json` (root)
- `package.json` (root — only if `npm audit fix` updates a range; not expected)

**Out of scope** (do NOT touch, even though they look related):
- Any source file in `web-portal/src/` or `src/` — no code changes are needed
  for a semver-compatible bump.
- `npm audit fix --force` — never use it; it can apply major-version jumps.
- Upgrading any other dependency (React 19, Vite, etc.).

## Git workflow

- Branch: `advisor/001-fix-react-router-and-qs-vulns`
- One commit, conventional style, e.g.:
  `fix(deps): bump react-router and qs past audit advisories`
  (matches repo style: "fix(setup): restore a placeholder index.html so the SPA fallback works unbuilt")
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the web-portal react-router advisories

Run, from the repo root:

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npm audit fix
```

Then confirm only lockfile (and at most `package.json`) changed:

```bash
git status --porcelain
```

Expected: only `web-portal/package-lock.json` (and possibly
`web-portal/package.json`) listed. If any other file changed, STOP.

**Verify**: `cd web-portal && npm audit --audit-level=high` → exit 0, no high or critical advisories. Also `npm ls react-router-dom --prefix .` shows a version ≥ 7.14.3 (outside 7.0.0–7.14.2).

### Step 2: Confirm the portal still builds and tests pass

```bash
npm --prefix web-portal run typecheck
npm --prefix web-portal run lint
npm --prefix web-portal run test
npm --prefix web-portal run build
```

**Verify**: all four commands exit 0; test run reports all tests passing.

### Step 3: Fix the root qs advisory

From the repo root:

```bash
npm audit fix
git status --porcelain
```

Expected: only `package-lock.json` (and possibly `package.json`) added to the
changed-file list.

**Verify**: `npm audit` (root) → "found 0 vulnerabilities" (or at minimum the
qs advisory is gone and nothing new appeared at moderate+).

### Step 4: Confirm the root project is unaffected

```bash
npm run typecheck:src
```

**Verify**: exit 0. (qs is transitive runtime-only for @slack/bolt; a
typecheck pass plus exit 0 from audit is sufficient — do not run the full
~5900-test suite for a lockfile bump.)

## Test plan

No new tests — this is a dependency bump with no code change. The gate is the
existing portal test suite (`npm --prefix web-portal run test`) passing
unchanged, plus clean audit output at both roots.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd web-portal && npm audit --audit-level=high` exits 0
- [ ] `npm audit --audit-level=moderate` at repo root exits 0 (qs advisory gone)
- [ ] `npm --prefix web-portal run typecheck && npm --prefix web-portal run lint && npm --prefix web-portal run test && npm --prefix web-portal run build` all exit 0
- [ ] `npm run typecheck:src` exits 0
- [ ] `git status --porcelain` shows only `package-lock.json` / `package.json` files (both roots) modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm audit fix` reports it cannot fix without `--force` (would mean the fix
  requires a major-version jump — do not force it).
- `npm audit fix` modifies any file other than `package.json` /
  `package-lock.json` at either root.
- Portal tests or build fail after the bump (would mean react-router 7.14.3+
  introduced a behavior change in `NavLink`/`useNavigate`/`Routes`).
- New advisories appear after the fix that weren't present before.

## Maintenance notes

- The repo has `npm run security:audit` (`npm audit --audit-level=high`) at
  the root but nothing that audits `web-portal/`. A follow-up (deliberately
  out of scope here) could add a `security:audit:portal` script and wire both
  into CI so this class of drift is caught automatically.
- Reviewer should scrutinize: the lockfile diff should touch only
  `react-router`, `react-router-dom`, and `qs` entries (plus their integrity
  hashes). Any other package movement is a red flag.
