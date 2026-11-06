---
id: dist-readers
status: active
scope: "Test files that read, run or import anything under this repository's own compiled dist/ (a path built from process.cwd(), the repository root or the test's import.meta.url): each fails, when dist/ is missing, with the message the gates' build step selects readers by."
read_trigger: "Before a test reads, runs or imports a file under the repository's dist/; before you change how scripts/ci/dist-build.mjs recognises a reader (READS_BUILD); when src/tests/dist-readers.test.ts names a file."
keywords: ["dist", "dist/", "npm run build", "compiled output", "build gate", "fresh worktree", "READS_BUILD", "gates.mjs", "false red", "derlenmiş çıktı", "temiz worktree"]
related: ["test-integrity", "clean-checkout"]
single_producer: {"file": "scripts/ci/dist-build.mjs", "exports": ["READS_BUILD", "testsThatReadBuild"]}
rules:
  [{"id": "dist-reader-says-so", "severity": "error", "text": "A test file that builds a path into the repository's dist/ fails, when dist/ is missing, with a message asking for `npm run build` before the test, the phrase scripts/ci/dist-build.mjs selects readers by.", "detector": {"kind": "vitest", "file": "src/tests/dist-readers.test.ts"}}]
---
# Dist readers: a test that reads the build says so

A few tests run what `npm run build` writes to dist/:
`restore-script.test.ts` runs `scripts/backup.sh`, which shells out to
`dist/core/database-backup.js`, and the live-verify tests load their
provider and runner from dist/. Without dist/ they fail rather than skip, on
purpose: CI builds before it tests, and a skip would hide a reordered
workflow. A fresh worktree has no dist/.

It cost a turn twice on one change (board task #1, the opencode change). The
worker and then the reviewer saw "dist/… is missing", and each spent the
turn on the environment instead of the change. Since f46589b1 the gates
build dist/ first, but only for a test that says it reads the build: its
failure message asks for `npm run build` before the test. Until this
contract that was a habit with nothing behind it. A new reader with any other
message is never selected, and the same false red comes back for it.

## Single producer

- **What a reader says, and who says it:** `READS_BUILD` and
  `testsThatReadBuild` in `scripts/ci/dist-build.mjs`. `distBuildGate` builds
  dist/ only when a test on that list is among the tests the gates will run,
  and dist/ is missing or stale.
- **The check:** `src/tests/dist-readers.test.ts` parses every test file in
  vitest's include (`testFiles`, from the same module). It works out each
  path expression from its parts:
  - `process.cwd()` is the repository root, as vitest runs here;
  - `import.meta.url`, `import.meta.dirname` and `__dirname` are the test
    file's own place;
  - `path.join`, `path.resolve`, `path.dirname`, `fileURLToPath`, `new URL`,
    `.pathname`, template strings and `+` are followed, also when the
    function is imported under another name (`import { join as joinPath }`):
    a call is judged by the name it has in its module, not by the local one;
  - a name is followed to the `const` it was declared with, in its own scope;
  - an `import` or `import()` of a relative specifier counts too.

  A file with a path that lands in `<repo>/dist` and no `READS_BUILD` match
  fails the detector, which names the line and the path.

## Caller rules

- **Check the path before you read it, and fail with the phrase.** The three
  readers show the shape: `expect(fs.existsSync(entry), …)` with a message
  that names the path and contains ``run `npm run build` before this test``
  (`READS_BUILD` also accepts the backticks escaped, as a template literal
  holds them). `src/tests/unit/restore-script.test.ts` is the fullest example.
- **Fail, do not skip, when dist/ is missing.** A skip turns a reordered CI
  workflow green. Skipping is also a weakening under the test-integrity
  contract.
- **A test that needs a dist/ but not this repository's build makes its own**
  in a temp folder, as `backup-script.test.ts` and `source-launcher.test.ts`
  do. Its paths point there, so it is not a reader and needs no message.
- **A test that only names a path under dist/**, for example as an expected
  value, builds it from a fixture root. Otherwise it counts as a reader, and
  the gate builds dist/ for it whenever it is selected.
- **When the detector names a file, add the check with the message.** Do not
  reshape the path until the detector cannot follow it. That moves the file
  into the blind spots below; it does not make it stop reading dist/.

## Don't

- Read, run or import anything under the repository's dist/ from a test file that does not fail asking for `npm run build` before the test. {#dist-reader-says-so}
- Skip a reader when dist/ is missing.
- Write the phrase in a test that reads no dist/. The gate then builds for
  it for nothing. `gates-dist-build.test.ts` and the detector assemble it
  from two parts for this reason.

## What it cannot see

- **A path built in another file:** a constant or helper imported from a
  module. Each file is parsed alone.
- **A path from a function parameter, a `let`, or a value known only at run
  time,** such as an environment variable or a loop over names.
- **A relative `"dist/…"` handed to `fs` or to a child process** whose working
  directory is the root, and a reader that reaches dist/ only through a
  script it runs. `scripts/backup.sh` reads `dist/core/database-backup.js`;
  `restore-script.test.ts` is seen because it checks that path itself.
- **Joins other than the ones listed,** such as `[root, "dist"].join("/")`.
- **A path function reached other than by `import`:** taken from
  `require("node:path")`, or destructured (`const { join } = path`).
- **`require.resolve("../../dist/…")`** on a `require` made with
  `createRequire(import.meta.url)`.
- **A `process.cwd()` the test moved with `process.chdir`:** it is still taken
  as the root, which can count a temp folder's dist/ as the repository's.
- **Tests outside vitest's include.** `web-portal/` has its own dist/ and
  its own runner.

## Calibration

Measured on 2026-11-06 on main at 801fcdae, before this change. There are
1,119 test files under `src/` and `tests/`; 30 of them contain the word
`dist`, and 3 build a path into the repository's dist/: `live-verify-providers`, `live-verify-weights`
and `restore-script`. All three carry the message, so there are 0 findings
and the rule gates with no baseline. The tests that set up a dist/ in a temp
folder, such as `backup-script`, `source-launcher`, `setup-doctor` and
`auto-updater-health-check`, are not counted. A test added for the check, one
that read `dist/core/database-backup.js` from `process.cwd()` under another
message, failed the detector at its line. So did one that imported
`join as joinPath` from `node:path` and read the same file through it. The
detector adds one test file of its own, which contains `dist` and builds no
path into it.
