---
id: fix-needs-a-red-test
status: active
scope: "Commits whose subject is a conventional fix (fix:, fix(scope):, fix!:) and that change source code of the root package (src/, scripts/, tests/ code outside test files): each such commit touches a test file vitest runs, and every source file it changes, put back alone as the parent had it, turns those tests red."
read_trigger: "Before you commit a fix(...); when the 'fix guarded' gate of scripts/ci/gates.mjs or scripts/ci/check-fix-guarded.mjs names a file or a commit; before you write a Fix-Unguarded: line; when a QA review says a test stays green with the fix reverted."
keywords: ["fix", "regression test", "mutation", "revert the fix", "red test", "missing-regression-test", "Fix-Unguarded", "check-fix-guarded", "fix guarded", "mutation check", "düzeltme", "geri alınınca kırmızı", "regresyon testi"]
related: ["test-integrity", "governance", "wall-clock-assertions"]
single_producer: {"file": "scripts/ci/check-fix-guarded.mjs", "exports": ["planFixCommit", "judgeFixCommit", "classifyPath"]}
rules:
  [{"id": "fix-has-a-red-test", "severity": "error", "text": "A fix(...) commit that changes source code touches a test file vitest runs, those tests pass as the commit leaves them, and putting back any one of its source files as the parent had it turns them red; a fix that cannot be tested says why in a Fix-Unguarded: line of that commit.", "detector": {"kind": "vitest", "file": "src/tests/fix-guarded.test.ts"}}]
---
# A fix needs a test that turns red when the fix is undone

A test that comes with a fix is meant to say "this broke, and it is fixed".
When the same test passes on the old code, it says nothing: the fix can be
reverted tomorrow and every check stays green. QA rejected two board tasks
for exactly this (`missing-regression-test`):

- **#38:** the worker's test "guarding the fix" stayed green with the fix
  reverted. The test checked something the fix did not change.
- **#56:** a fix in two files came with a test of one of them. Reverting the
  other left everything green.

Both were found only because a reviewer reverted the fix by hand. Each
rejection cost a full review and an attempt. This contract makes that revert
a gate that runs before the push.

## Single producer

`scripts/ci/check-fix-guarded.mjs` judges the fix commits in a range.
`scripts/ci/gates.mjs` runs it as the "fix guarded" gate over
`<base>..HEAD` (`--base`, default `origin/main`). For each commit:

1. **Is it a fix?** `FIX_SUBJECT`: the subject starts with `fix`, an optional
   `(scope)`, an optional `!`, and a colon, in any case and with spaces
   around the tokens. `fixup!`, `Fix the …` (no colon), `hotfix:`, `feat(fix):`
   and merge commits are not fixes. Measured on main on 2026-11-16, 2,392 of
   4,982 commits are fixes, all spelled `fix:` or `fix(scope):`.
2. **What did it change?** `classifyPath` sorts every path: test files
   (`isTestPath` of `check-test-integrity.mjs`); docs (`docs/`, `.md`,
   `.mdx`, `.txt`); config (`.json`, `.yaml`, `.toml`, `.ini`, `.lock`,
   `*.config.ts|js|mjs|cjs`, dotfiles, `.github/`); the web portal
   (`web-portal/`, its own package and runner); source (`.ts`, `.tsx`, `.js`,
   `.mjs`, `.cjs`, `.jsx`, `.sh` everywhere else); and the rest (images,
   styles).
3. **Does a source file change code?** Each source change is compiled with
   TypeScript's `transpileModule`, comments removed, before and after. When
   both emit the same JavaScript, the change is types, comments or a rename
   only, and no test at run time can tell the two apart (the typecheck gate
   judges types). It is named in the log and not reverted.
4. **The exemptions,** each a stated rule:
   - **No source code changed:** docs only, config only, tests only, or
     types and comments only. Nothing can be reverted.
   - **`Fix-Unguarded: <a sentence>`** in the commit's message (ten or more
     characters after the colon, like `Test-Weakened:`). The sentence is the
     review: there is no other.
5. **A test to run.** The commit must touch (add, change or rename) a test
   file vitest runs: `src/**/*.test.ts` or `tests/**/*.test.ts`. Without one
   it is a finding.
6. **The revert.** In a temporary `git worktree` at the commit, with this
   checkout's `node_modules` linked in, the touched test files run once as
   the commit left them; they must pass. Then, one source file at a time,
   that file is put back as the parent had it (an added file is removed, a
   renamed one goes back to its old path), the same test files run, and the
   tree is restored. A file whose revert leaves them green is named. The
   worktree is removed afterwards.

Only the test files the commit touched run: one vitest run, plus one per
source file whose code changed, per fix commit. A branch without fix
commits costs nothing.

## Caller rules

- **Write the test first, on the old code.** It should fail there for the
  reason the fix exists. Then fix, and watch it pass. The gate repeats the
  revert for you.
- **One test per fixed file, or one test that depends on all of them.** When
  the gate names a file, either the test does not reach it, or the change to
  it is not part of the fix. Move an unrelated change into a commit of its
  own (`refactor:`, `chore:`), or add the case that reaches it.
- **When a fix truly cannot be tested** (a platform the machine does not
  have, a timing fix that only load shows), put
  `Fix-Unguarded: <why no test can tell the fixed code from the old>` in that
  commit's message. A pushed commit is never amended: add the test in a new
  commit, or revert and recommit with the line.
- **Do not call a non-fix a fix.** A refactor, a doc change or a feature is
  not judged; name it for what it is.

## Don't

- Commit a `fix(...)` that changes source code with no test file, or with a test that stays green when any of its source files is put back as it was, without a `Fix-Unguarded:` line in that commit. {#fix-has-a-red-test}
- Satisfy `Fix-Unguarded:` with a word. It needs a sentence a reviewer can
  check.
- Rename a fix to `chore:` or `refactor:` to get past the gate.
- Push with `--no-verify` or skip the gate: `node scripts/ci/gates.mjs` runs
  it, and its summary is the evidence QA reads.

## What it cannot see

- **A red for the wrong reason.** Reverting a file that the test imports a
  new export from makes the test fail to load, which counts as red. An added
  file is removed on revert, so any test that imports it turns red. The gate
  proves the test depends on the file, not that it checks the fixed
  behaviour.
- **A fix whose files only fail together.** Each file is reverted alone. If
  two files each mask the other's revert, both are named: a false red. Say so
  with `Fix-Unguarded:` or test each.
- **Tests the commit did not touch.** An existing test that already guards
  the fix is not run; the commit must touch a test.
- **Code the root vitest does not run:** the web portal (`web-portal/`, its
  own runner), styles, HTML, JSON and YAML read at run time.
- **Types, comments and pure renames,** by design (step 3).
- **Tests that need a build of `dist/`.** The temporary worktree has none, so
  such a test fails with the fix in place, which is reported as "fail with
  the fix in place": a false red.
- **Subjects outside the convention** (`Fix the setup wizard`): not judged.
- **Commits before the base.** Only the range is judged, so the findings
  measured on main below stay where they are; the gate holds every new
  commit.

## Calibration

Measured on 2026-11-16 on main at 9f55a416, over the 50 most recent fix
commits (0ec53c8e back to e0bded80, 2026-11-06 to 2026-11-16), each judged
alone with `--commits`:

- 3 exempt by rule: docs and tests only.
- 33 guarded: every reverted file turned the commit's tests red.
- Across all 50, 17 source changes emitted the parent's code (types or
  comments only) and were not reverted, and one deleted file was not put
  back.
- **14 findings** in 14 commits:
  - 12 commits with a file whose revert left the commit's tests green, 16
    files in all. Examples: `7ee94099` adds `metrics` to a call in
    `src/core/bootstrap.ts` that no touched test reaches; `1667006f` moves
    the resume message into a helper, its test calls the helper and not the
    call site, and the next fix (`56129a1b`) is the one that pins the call
    site; `45402424` changes four orchestrator files, and reverting any one
    of them leaves its tests green.
  - 2 commits (`89c33d76`, `841f5080`) whose own tests fail at the commit,
    in a clean worktree and on a quiet machine; the same test file passes at
    main in the same kind of worktree. Whatever made them pass when they
    were written was not in the commit.

14 is in the 1–20 band, so the rule is a ratchet. Its baseline is the base
commit itself: the gate judges only `<base>..HEAD`, so the 14 stay in the
history where they are and none can be added. There is no number to pin:
past commits do not change, and every new fix commit is held to zero.

The first calibration run counted 18. Two false reds were removed before this
measurement, each a rule above and a fixture in the detector: a type-only edit
(`0ec53c8e`, `src/agent-core/engine/review.ts`) and a deleted helper
(`56129a1b`, `src/supervisor/resume-rejection-detail.ts`).

**Cost.** The 47 judged commits took 1,658 s of test runs in all, at load
averages between 6 and 128: a median of 15 s per guarded commit and 207 s
for the largest (`7ee94099`, 36 files, 19 reverts). A branch without fix
commits adds nothing to the "fix guarded" gate. The detector's own test runs
eight child vitests on a fixture repository and adds 16–20 s to the "contract
detectors" gate.

**Mutations**, each made in the script, run against the detector, and undone:

- the revert skipped (the tests run on the fixed tree): "passes a fix whose
  test turns red" and the #56 case red;
- the "touches no test file" check removed: four cases red;
- the tree not restored between reverts (reverts pile up): the #56 case red;
- the `Fix-Unguarded:` line ignored: the trailer case and the command case red;
- type-only changes not recognised: the exemption case and the command case red;
- the first run with the fix in place skipped: "names a fix whose own test
  fails with the fix in place" red;
- deleted files reverted: the deleted-file case red.
