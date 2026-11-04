---
name: ship
description: "How an agent commits and pushes in Strada.Brain: run the gates, stage explicit paths, write a commit that says what it measured, push without bending anything. Use for 'commit this', 'push', 'ship it', 'land this on main'. NOT for: deciding WHAT to change (read the area's contract first: docs/contracts/README.md), releasing a version (the Version Bump workflow does that after CI), or anything in a game project's repository."
triggers:
  slash: ["/ship"]
  phrases: ["commit this", "push", "ship it", "land it", "merge it"]
---

# ship

Strada.Brain is developed by agents only. Nobody runs a command before a
push, so these steps are the whole pre-push routine. Claude Code reaches
this file through `.claude/commands/ship.md`. Codex and others reach it
through the router in `AGENTS.md`.

## Gates (before any push, every time)

Run `node scripts/ci/gates.mjs`. It runs every gate, then prints one summary
and exits non-zero if any gate failed.

| Gate | Command | What it catches |
| --- | --- | --- |
| typecheck | `npm run typecheck:src` | A change that compiles only in the file you were looking at |
| lint (changed) | `eslint <changed src files>` | What the pre-commit hook enforces, so it fails here and not mid-commit |
| contract detectors | `vitest run` on the detectors listed in `docs/contracts/README.md` | Any contract rule broken: path containment, ESM require, gate askers, test integrity, file size, confidentiality |
| related tests | `vitest related --run <changed files>` | Tests that import what you changed |
| test integrity | `scripts/ci/check-test-integrity.mjs` | A commit that weakens a test without a `Test-Weakened:` line |

These gates are not the full suite. CI runs that on every push to main
(about 10 minutes). When your change touches the run loop (orchestrator,
supervisor, goals, tasks, campaign), also run `npm test` before you push.
Most of what agents break in this repo shows up there.

A red gate means the code is wrong until proven otherwise. Do not touch a
test to turn a gate green. See `docs/contracts/test-integrity.md`.

## Procedure

1. Run `git status` and `git diff`. Read what you are about to commit,
   including files another agent may have staged. This checkout is shared:
   one working tree, one index.
2. Run `node scripts/ci/gates.mjs`. Fix every failure in the code.
3. Stage with an explicit path list: `git add -- <path> <path>`. Never use
   `git add -A` or `git add .`. The index may hold another agent's work.
4. Commit with a message that says what changed, what it measured, and how
   you know it works. For a fix, say how you checked that the test fails
   without the fix (mutation check). End with the attribution trailer the
   session gives you.
5. `git pull --rebase origin main`, then rerun the integrity gate if the
   rebase pulled anything.
6. `git push origin HEAD:main`. The pre-push hook reruns the integrity check.
   Then watch CI: `gh run list --branch main --limit 1`. A push with a red
   CI is not done.

## Never

- `--no-verify`, `--force`, or `git push -f` to main.
- `git commit --amend` on a commit that is already pushed. It breaks the
  Version Bump workflow, which looks for the sha you rewrote. Follow up with
  a new commit instead.
- `[skip ci]` in a commit message. Only the Version Bump workflow uses it.
- A commit that mixes an extraction or refactor with a behaviour change.
  Moves get their own commit, with tests unchanged.
- Names, quotes, counts or run ids from a project Brain was run against.
  See the boundary in `AGENTS.md`. `src/universality.test.ts` checks it when
  the local term lists are present.

## Common mistakes

- **A commit that carried someone else's staged files.** Another agent's
  work went out under your message. Check `git diff --cached --stat` before
  you commit.
- **"Tests pass" when only the file's own tests ran.** A change in a shared
  helper broke a caller's test. `vitest related` exists for this.
- **A fix whose test never failed.** Revert the fix and watch the test fail,
  or the test proves nothing.
