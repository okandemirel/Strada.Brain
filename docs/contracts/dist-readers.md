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
- **The check:** `src/tests/dist-readers.test.ts` reads every test file in
  vitest's include (`testFiles`, from the same module) and parses the ones
  that can reach dist/ (below). It works out each path expression from its
  parts:
  - `process.cwd()` is the repository root, as vitest runs here;
  - `import.meta.url`, `import.meta.dirname` and `__dirname` are the test
    file's own place;
  - `path.join`, `path.resolve`, `path.dirname`, `fileURLToPath`, `new URL`,
    `.pathname`, template strings and `+` are followed, also when the
    function is imported under another name (`import { join as joinPath }`):
    a call is judged by the name it has in its module, not by the local one;
  - a name is followed to the `const` it was declared with, in its own scope;
  - a name imported from a relative module (`./` or `../`, `.js` read as
    the `.ts` source) is worked out in that module, from that module's own
    place: `REPO_ROOT` from `src/tests/helpers/local-fixtures.ts` is the root
    its `new URL("../../../", import.meta.url)` climbs to, not a climb from the
    test. An `export const`, `export { a as b }`, a re-export
    (`export { x } from`, `export * from`), a namespace import
    (`fixtures.REPO_ROOT`) and a default export are followed, through as many
    modules as it takes;
  - such a name counts where the test uses it as it is, too: a helper's
    `export const BUILT_CLI = join(REPO_ROOT, "dist", "index.js")` makes
    `existsSync(BUILT_CLI)` and `[paths.BUILT_CLI]` (a namespace import) reads
    of `dist/index.js`. A name in a type, and a function being called or
    constructed, are not worked out: neither is a path;
  - a path whose end comes only at run time counts by its known start:
    `path.join(process.cwd(), "dist", name)` with `name` a loop variable or a
    helper's parameter, `join(root, "dist", ...parts)`, and
    `` `${repoRoot}/dist/${name}` ``, `root + "/dist/" + name`,
    `` new URL(`../../dist/${name}`, import.meta.url) `` and
    `` import(new URL(`…/dist/${name}.js`, import.meta.url).href) `` all land
    in dist/. The start counts up to its last whole segment, so
    `` `${root}/dist${suffix}` ``, `` new URL(`../../dist${suffix}`, import.meta.url) ``
    and `join(root, sub, "dist")`, whose dist/ part is not fixed, do not;
  - an `import`, `import()`, `vi.importActual()` or `vi.importMock()` of a
    relative specifier counts too, and so does `import.meta.resolve()` of a
    relative or absolute one, resolved from the test file as
    `new URL(…, import.meta.url)` is.

  An expression not on this list is not worked out, and a path built from it
  does not count: a conditional (`process.env.ROOT ?? process.cwd()`,
  `ci ? a : b`), a member of an imported object or array other than a
  namespace import (`PATHS.cli`, `for (const entry of ENTRIES)`, `P.cli` on a
  default-exported object), `pathToFileURL`, and the value a function call
  returns (below).

  A test file is parsed when it, or a module it imports from by a relative
  specifier, spells `dist`. Parsing every test file instead takes a scan of
  the repository from about 2 s to 8–16 s. Following the names a test uses
  as they are into their modules parses about 55 modules more and costs the
  scan about 0.8 s of CPU (3.4–4.2 s against 2.6–3.3 s, measured on a loaded
  machine).

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

- **A root or path that comes out of a function call, in this file or
  another:** `function repoRoot() { return process.cwd(); }` and then
  `path.join(repoRoot(), "dist", "index.js")`, or a helper's `cliPath()`. A
  call is followed only into the path and URL functions listed above, not
  into a function a module declares. The path a local function builds in its
  own body is seen there: `function cli() { return join(process.cwd(),
  "dist", "index.js"); }` counts at the line of its `join`. No test builds
  the repository root this way today (the `projectRoot()` in
  `workspace-submodules.test.ts` returns a temp folder), and no test helper
  returns a dist/ path: of the modules tests import, only production modules
  spell `dist`, and the two that build a path into dist/
  (`src/channels/web/channel.ts`, `src/core/setup-wizard.ts`) keep it in an
  unexported list of static-folder fallbacks.
- **A value imported by package name or loaded at run time:** a name from a
  package, a `#` import-map alias (also through `import.meta.resolve`), a
  `require()`, or a module object from `await import("./helper.js")`. Only
  static imports of relative specifiers are followed.
- **An imported name taken apart before use:** destructured from a namespace
  (`const { BUILT_CLI } = paths`), read by key (`paths["BUILT_CLI"]`), or
  handed on in an object shorthand (`run({ BUILT_CLI })`). The name itself,
  a namespace member (`paths.BUILT_CLI`) and a `const` copy of either are
  seen.
- **A dist/ segment spelled two modules away:** a test that never writes
  `dist`, importing from a helper that never writes it either but re-exports
  a third module's dist/ path. The test is not parsed (see above). With every
  test file parsed, today's scan finds the same three readers.
- **A path whose root or dist/ part is known only at run time:** a root taken
  from a function parameter, a `let` or an environment variable, or a dist/
  segment assembled at run time. A path whose root and dist/ are fixed and
  only its end varies is seen (above).
- **A run-time end that leaves dist/ again** (`join(root, "dist", "../src")`,
  or a `resolve()` part that turns out absolute) still counts as a reader.
  This errs toward the gate building dist/ for nothing, not toward a missed
  reader.
- **A relative `"dist/…"` handed to `fs` or to a child process** whose working
  directory is the root, and a reader that reaches dist/ only through a
  script it runs. `scripts/backup.sh` reads `dist/core/database-backup.js`;
  `restore-script.test.ts` is seen because it checks that path itself.
- **Joins other than the ones listed,** such as `[root, "dist"].join("/")`,
  and `dist` spelled in pieces (`"di" + "st"`), which the parse would follow
  but the word check before it does not see.
- **`vi.mock("../dist/…")` and `vi.doMock`** name a module without loading
  it. The import that loads it is what counts.
- **A path function reached other than by `import`:** taken from
  `require("node:path")`, or destructured (`const { join } = path`).
- **`require.resolve("../../dist/…")`** on a `require` made with
  `createRequire(import.meta.url)`.
- **A `process.cwd()` the test moved with `process.chdir`:** it is still taken
  as the root, which can count a temp folder's dist/ as the repository's.
- **Tests outside vitest's include.** `web-portal/` has its own dist/ and
  its own runner.

## Calibration

Measured on 2026-11-06 on main at 5e9c61de, before this change, with the
detector that also counts paths whose end comes at run time. There are 1,120
test files under `src/` and `tests/`; 30 of them contain the word `dist`, and
3 build a path into the repository's dist/: `live-verify-providers`,
`live-verify-weights` and `restore-script`. All three carry the message, so
there are 0 findings and the rule gates with no baseline. The tests that set
up a dist/ in a temp folder, such as `backup-script`, `source-launcher`,
`setup-doctor` and `auto-updater-health-check`, are not counted. Tests added
for the check, each reading dist/ under another message, failed the detector
at their line: one that read `dist/core/database-backup.js` from
`process.cwd()`, one that read it through `join as joinPath` from
`node:path`, three whose file name came at run time (a loop over names,
an `it.each` template `` `${repoRoot}/dist/${name}` ``, a helper
`entry(name)` joining `repoRoot`, `"dist"` and `name`), and two that built
the URL at run time (`` import(new URL(`../../../dist/core/${name}.js`,
import.meta.url).href) `` and `` readFileSync(new URL(`../../../dist/${name}`,
import.meta.url)) ``). One beside them reading `` new URL(`../../../dist${suffix}`,
import.meta.url) `` was not counted. The repository scan with the URL change
still finds exactly the three readers. The detector adds one test file of its
own, which contains `dist` and builds no path into it.

With names followed into the modules they are imported from: 116 of the
1,120 test files spell `dist` or import from a module that does, and the scan
parses those. The repository's shared root, `REPO_ROOT` in
`src/tests/helpers/local-fixtures.ts`, is imported by one test file,
`src/universality.test.ts`, which builds no path into dist/ with it. A scan
that parsed every test file found the same three readers. Two tests added
without the message failed the detector at their line: one that read
`join(REPO_ROOT, "dist", "index.js")` with `REPO_ROOT` imported from
`../helpers/local-fixtures.js`, and one that loaded
`vi.importActual("../../../dist/core/database-backup.js")`.

With imported names followed where a test uses them as they are, and
`import.meta.resolve` read as a URL from the test file: 1,121 test files at
the HEAD of this change, the detector among them; 117 of them are parsed, and
180 modules in all. The scan still finds exactly the three readers, with 0
findings. Three tests added without the message, beside a helper that
exported `BUILT_CLI = join(REPO_ROOT, "dist", "index.js")`, failed the
detector at their line: `expect(existsSync(BUILT_CLI))`,
`execFileSync(process.execPath, [paths.BUILT_CLI, "--help"])` through a
namespace import, and
`await import(import.meta.resolve("../../../dist/core/database-backup.js"))`.

The scan of the repository took 3.0–5.6 s at load averages of 42–84 on
2026-11-06. It runs in the test that makes it first, and vitest fails a test
that outlasts its limit even after it passes: the 30 s default would turn the
detector red for a busy machine, not for a reader. The two tests that read the
scan carry a limit of 120 s (`REPO_SCAN_TIMEOUT_MS`), as the long-running
detector in `clean-checkout.test.ts` does. With the limit set to 1 s, each failed with
"Test timed out in 1000ms" after a 4.3–5.1 s scan. Probed the same day with
tests added without the message and deleted after: a root from `??` or from a
conditional, a member of an imported object, an imported array, a member of
a default-exported object, a `pathToFileURL` base and a root a local function
returns were not counted, as listed above; a local function that builds the
dist/ path in its own body was counted at its line.
