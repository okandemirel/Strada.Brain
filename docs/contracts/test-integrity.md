---
id: test-integrity
status: active
scope: "Changing an existing test: removing a case or an assertion, skipping, focusing or commenting one out, rewriting what it expects, deleting a test file, or moving a ratchet's pinned number."
read_trigger: "Before you edit an existing test because it fails; before adding skip, skipIf, runIf, todo, fails or only; before deleting a test file or rewriting an expect() in a commit that changes no source; before raising a BASELINE or PINNED number; when CI or the pre-push hook prints check-test-integrity."
keywords: ["test", "assertion", "expect", "skip", "skipIf", "only", "todo", "commented-out test", "green", "CI", "windows-test", "flaky", "Test-Weakened", "ratchet", "BASELINE", "PINNED", "test manipulation", "bend a test"]
related: ["path-containment", "gate-needs-an-asker"]
rules:
  [{"id": "no-test-bent-to-green", "severity": "error", "text": "Never make a failing check pass by weakening the test: no removed case or assertion, new skip/only/todo, commented-out test, assertion rewritten without a source change, or loosened ratchet pin — unless that commit says why in a Test-Weakened: line.", "detector": {"kind": "vitest", "file": "src/test-integrity.test.ts"}}]
---
# Test integrity: no test bent to green

A test that is made to pass is different from code that is made to work. The
first deletes the only evidence that a behaviour broke, and every check after
it stays green. The owner named this as a habit of the agents that develop
this repo (2026-11-04).

When the rule was written, the check was run over October 2026. 36 of 444
commits had weakened a test, and none of them said so:

- 21 commits added a skip or `skipIf`. One of them was 099a704c: "run the
  ledger's shebang-script cases on POSIX only, so windows-test stays green".
- 8 commits rewrote existing assertions while changing no source. 375b55d0 is
  one of them. It loosened `"not a git repository"` to "git said anything"
  after Windows CI failed twice.
- Others removed cases or assertions, mostly during fixture purges.

Some of those were right. A shebang does not run on Windows, and an
assertion pinned to one git's English measured the platform. Others were not
right. Only the commit's author knows which is which. This contract makes the
author say so in the commit.

## Single producer

`scripts/ci/check-test-integrity.mjs` judges a commit by comparing it with its
own parent. CI runs it over every push and pull request (the `verify` job). The
pre-push hook (`scripts/git-hooks/pre-push`, installed by `npm install` through
`scripts/install-git-hooks.mjs`) runs it before anything leaves the machine.

`src/test-integrity.test.ts` pins how that script decides, on fixtures. It
also holds the tree itself:

- no test file contains a commented-out test;
- skip markers are a ratchet (`SKIP_BASELINE`).

## Caller rules

- **A failing test means the code is wrong** until a reading of the
  behaviour's contract shows that the test is wrong. Fix the code first.
- **When the test really is wrong:**
  - change it in a commit of its own;
  - in that commit's message, say what the old assertion measured and why
    that was not the contract;
  - add a trailer line `Test-Weakened: <that, in a sentence>`.
- **Prefer adding a case to rewriting one.** A platform difference is a new
  case with a stated condition. Do not loosen an assertion that every
  platform shares.
- **A skip carries its reason in its condition and in the commit.** Use a
  reason such as `skipIf(process.platform === "win32")` or
  `skipIf(!coreCheckout)`. A bare skip is never acceptable.
- **A deleted subsystem takes its tests with it.** That deletion is also a
  weakening, so it says so with a `Test-Weakened:` line too.
- **A pushed commit is never amended.** If a pushed commit weakened a test
  without saying why, follow up in a new commit: restore the test, or add the
  missing case.

## Don't

- Make a failing check pass by weakening its test: removing a case or an assertion, adding skip/only/todo, commenting a test out, rewriting an assertion in a commit that changes no source, or raising a BASELINE/PINNED number, without a `Test-Weakened:` line in that commit. {#no-test-bent-to-green}
- Push with `--no-verify` to get past the hook. CI runs the same check.
- Satisfy the trailer with a word. It needs a sentence that a reviewer can check.

## What the check cannot see

- **Weakening inside an assertion that keeps its line.** For example,
  `toEqual(x)` becoming `toMatchObject(x)` in the same commit as a source
  change. A commit that also changes source is trusted to have changed
  behaviour.
- **Cases built in loops** without `it(` or `test(` on the line.
- **Assertions made through a helper** that is not named `expect` or `assert`.
- **Commits a `[skip ci]` push kept from CI** before this check existed. The
  check walks back over such commits on the next push, except the version
  bump.
