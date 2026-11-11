---
id: wall-clock-assertions
status: active
scope: "Test files under vitest's include (src/ and tests/) that assert an upper bound on wall-clock time the test measured itself, and the tests of the gates' contract detectors (scripts/ci/gates.mjs DETECTORS) that walk the repository inside a test body."
read_trigger: "Before you write expect(Date.now() - t).toBeLessThan(…), expect(elapsed).toBeLessThan(…) or any assertion on how long something took; before you add a detector to DETECTORS in scripts/ci/gates.mjs or a test that walks the repository; when src/tests/wall-clock-assertions.test.ts names a file; when a test fails with 'Test timed out' on a loaded machine."
keywords: ["wall clock", "Date.now", "performance.now", "elapsed", "toBeLessThan", "timeout", "testTimeout", "false red", "flaky", "load average", "fake timers", "REPO_SCAN_TIMEOUT_MS", "DETECTORS", "gates.mjs", "duvar saati", "sahte kırmızı", "süre sınırı"]
related: ["test-integrity", "dist-readers", "clean-checkout"]
single_producer: {"file": "scripts/ci/gates.mjs", "exports": ["DETECTORS"]}
rules:
  [{"id": "no-new-wall-clock-bound", "severity": "error", "text": "No test file gains an upper bound on wall-clock time it measured itself (expect(Date.now() - t).toBeLessThan(N) and the forms listed in this contract); the count per file is pinned in WALL_CLOCK_BASELINE and only goes down.", "detector": {"kind": "vitest", "file": "src/tests/wall-clock-assertions.test.ts"}},
   {"id": "repo-scan-carries-its-limit", "severity": "error", "text": "A test of a contract detector listed in scripts/ci/gates.mjs DETECTORS that walks the repository inside its body carries its own time limit instead of vitest's 30 s default.", "detector": {"kind": "vitest", "file": "src/tests/wall-clock-assertions.test.ts"}}]
---
# Wall-clock assertions: a busy machine is not a failing test

Several agents run on this machine at once, and its load average passes 100.
Two kinds of test then turn red on a change that has nothing to do with them:

- **A short bound on elapsed time.** `expect(Date.now() - started).toBeLessThan(500)`
  measures the machine as much as the code. On an idle machine it passes; at a
  load of 100 the same code takes three times as long.
- **A detector that scans the repository under vitest's 30 s default.**
  Vitest fails a test that outlasts its limit even after its assertions pass.
  A walk over every test file takes 2–6 s on a quiet day and much longer when
  ten agents run the gates at once.

The false-red class came back from QA on two separate board tasks within 30
days (#4, #21), and three more (#32, #47, #49) repair the same kind of red.
Each time an agent spent its turn on the machine instead of its change.

## Single producer

- **Which tests are the gates' detectors:** `DETECTORS` in
  `scripts/ci/gates.mjs`. The detector reads it from the file's syntax tree
  (it does not import the script, which would run the gates), so keep it an
  array of string literals.
- **Which test files there are:** `testFiles` in `scripts/ci/dist-build.mjs`,
  vitest's include as the gates read it.
- **The pinned count:** `WALL_CLOCK_BASELINE` in
  `src/tests/wall-clock-assertions.test.ts`, one line per file.
  `scripts/ci/check-test-integrity.mjs` lists it in `PINS`, so a commit that
  raises a line or adds one is a loosened pin and needs a `Test-Weakened:`
  line.
- **The limit a repository scan carries:** 120 s, `REPO_SCAN_TIMEOUT_MS` in
  `dist-readers.test.ts` and in the detector, and `120_000` in
  `clean-checkout.test.ts`, `no-require-in-esm.test.ts` and
  `entry-guard-symlink.test.ts`.

## Caller rules

- **Assert the behaviour, not the machine's speed.** Use fake timers
  (`vi.useFakeTimers()`, `vi.advanceTimersByTime()`), an injected clock, a
  counted call or attempt, or the order of events. "It returned before the
  2 s backoff" is a check that no backoff timer was armed, not a stopwatch.
- **When you replace a bound, lower its line** in `WALL_CLOCK_BASELINE`
  (delete it at zero) in the same change. The detector fails until you do, so
  the bound cannot come back unseen.
- **A new detector in DETECTORS that walks the repository in a test body
  gives that test a limit:** `it(name, fn, 120_000)`, `it(name, { timeout }, fn)`
  or a `describe` that carries one. A walk done while vitest collects the file
  (at module or `describe` level) is under no test's limit and is not judged.
- **When the detector names a file, do not move the bound out of its sight.**
  A bound in an imported helper, behind a parameter or in a production
  measurement is still a bound; it is just one the detector cannot count
  (below).

## Don't

- Add an upper bound on wall-clock time the test measured, in any form listed under "What it sees", or raise a line of WALL_CLOCK_BASELINE without a Test-Weakened line. {#no-new-wall-clock-bound}
- Walk the repository inside a test of a gates detector without a limit of its own. {#repo-scan-carries-its-limit}
- Move a bound into a helper module, a parameter or the code under test to
  get it past the detector.
- Change a bound's number to make it pass on a loaded machine. Raising
  `toBeLessThan(500)` to `toBeLessThan(5_000)` keeps a bound and weakens a
  test; replace it instead.

## What it sees

Rule `no-new-wall-clock-bound` parses each test file with the TypeScript
parser and resolves names in their own scope; it does not match lines. It
counts an `expect(x)` or `expect.soft(x)`, with or without a message, ending
in `.toBeLessThan`, `.toBeLessThanOrEqual`, `.not.toBeGreaterThan` or
`.not.toBeGreaterThanOrEqual`, where `x` is an elapsed time:

- **clock minus:** a clock read minus anything: `Date.now() - t`,
  `performance.now() - t`, `end - t` with `const end = Date.now()`, and
  `Date.now() - a - b`;
- **stamp minus start:** anything minus a name that holds an earlier clock
  read, or one minus anything: `entry.cooldownUntil - before` with
  `const before = Date.now()`, `call.since - expectedSince` with
  `const expectedSince = now - 30 * DAY`. Such a difference grows with every
  millisecond the code under test took;
- either one as what `x` stands for: a `const` or `let` declared with it
  (`const elapsed = Date.now() - t`), a property destructured from an object
  (`const { ms } = await timed(…)`), a property of an object literal
  (`run.ms`, `bench().insertMs`, also a shorthand `{ insertMs }`), the
  `return` of a function the file declares (`timed(text)`), through `await`,
  `as`, `!` and parentheses, and inside `Math.abs`, `round`, `floor`, `ceil`
  or `trunc`.

The clock is the global `Date` (a parameter or variable named `Date` is not)
or `performance`: global, imported from `node:perf_hooks` under any name
(`import { performance as perf }`), or a namespace or default import of that
module (`hooks.performance.now()`). A clock read written out on the right,
`deadline - Date.now()`, is the time left, which load only shrinks: it is not
counted. Nor is a lower bound (`toBeGreaterThan`), which load cannot break.

Rule `repo-scan-carries-its-limit` reads the `DETECTORS` array of
`scripts/ci/gates.mjs` and, in each of those files, the test cases (`it`,
`test`, also `.each(…)`) whose body reaches a walk: a call of `readdirSync`,
`readdir`, `opendirSync`, `opendir`, `globSync`, `glob` or `testFiles`, or a
child-process call (`execFileSync`, `spawnSync`, …) with an `ls-files` or
`grep` argument, directly or through functions the file declares, followed
by name. A call whose argument is made by `mkdtempSync`, `mkdtemp` or
`tmpdir`, directly, through a `const`, or through a function the file
declares, walks a temp folder and is not counted. A case carries a limit when
it has an argument after its function, an options object with `timeout`, or
sits in a `describe` that has either.

## What it cannot see

- **A duration the code under test measures.** `tracker.getTaskDurationMs()`,
  `snap.timeSinceLastMutationMs` and `result.downtimeMs` come from production
  code's own clock read. Today three such bounds exist and are not counted:
  `src/agents/iteration-health-tracker.test.ts:159`,
  `src/agents/autonomy/progress-assessment.test.ts:174` and
  `src/identity/crash-recovery.test.ts:22`.
- **A clock read or bound in another module.** Only functions the test file
  declares are followed. A timing helper imported from another module, or an
  `expect` inside a helper that takes the elapsed time as a parameter
  (`function fast(ms: number) { expect(ms).toBeLessThan(100); }`), is not
  seen. No test helper today returns an elapsed time (the clock reads in
  `src/tests/helpers/golden-run-harness.ts` format a log line, and the one in
  `mock-provider.ts` is a wait loop), and no test file asserts a bound on a
  parameter.
- **A name given its value after its declaration.** `let elapsed = 0; …;
  elapsed = Date.now() - t` is judged by its initializer, `0`. No test file
  does this today.
- **Other clock reads:** `new Date().getTime()`, `+new Date()`,
  `process.hrtime`, `globalThis.Date.now()`, and an alias such as
  `const now = Date.now` or `Date.now.bind(Date)`. None is used as an elapsed
  time today (the one `getTime()` difference is a time left, and the one
  `Date.now.bind` builds a mock).
- **Other assertion shapes:** `expect(elapsed < 500).toBe(true)`,
  `assert.ok(…)`, `expect(x).toSatisfy(…)`, a matcher reached by a computed
  name (`expect(x)["toBeLessThan"]`), and chai's `.below()`. None is used
  for a duration today.
- **Other ways to carry a value:** array destructuring, a nested or rest
  pattern, an element access (`run["ms"]`), a spread, a class field, and a
  `Map` or array entry. A function is followed by its name in its own scope,
  so a function passed as a value is not.
- **An order of two clock reads,** `expect(firedAt).toBeLessThan(finishedAt)`
  (`framework-git-fallback.test.ts:132`), bounds no duration and is not
  counted.
- **Fake timers are not told apart.** A bound measured under
  `vi.useFakeTimers()` is counted although load cannot break it. A
  "stamp minus start" whose left side is a constant is counted too. Both err
  toward counting.
- **Files the parse skips.** A file that does not spell the word `now` and
  an upper or lower matcher name is not parsed; such a file has no clock read
  written out, so the parse could find nothing in it. `web-portal/` has its
  own runner and is not read.
- **For the limit rule:** a walk through a helper imported from another
  module other than `testFiles` (for example `runtimeEntriesIn`), a walk
  started by a child process other than `git ls-files`/`git grep` (a child
  vitest, as in `clean-checkout.test.ts`, which carries its limit anyway), a
  limit set by `vi.setConfig({ testTimeout })` (counted as no limit, a false
  red), a temp root that comes through a parameter or an imported helper
  (counted as the repository, also a false red), and two functions of one
  name in one file (the last one is followed). Only the files in `DETECTORS`
  are judged; a repository scan elsewhere is not.

## Calibration

Measured on 2026-11-11 on main at 78500e4b, with this change's detector:
1,129 test files in vitest's include (1,130 with the detector); 60 wall-clock upper bounds in 41 files,
all pinned in `WALL_CLOCK_BASELINE`. By form:

- 26 written out as `expect(Date.now() - t)`, 3 as `expect(performance.now() - t)`;
- 17 through a name declared with the difference
  (`const elapsed = Date.now() - t`; the discord and slack rate limiters,
  `pattern-matcher-bounds`, `learning-queue`, `process-runner`,
  `canvas-generator`, `phase2.acceptance` with `performance` from
  `node:perf_hooks`, and others);
- 4 destructured from a local timing function (`csharp-parser` 2,
  `search-glob-cost` 2), 5 read as a property of the object one returns
  (`search-glob-cost` 2, `hnsw-performance` 3), 2 returned by one
  (`campaign-intake`), 1 inside `Math.abs` (`task-manager`);
- 2 "stamp minus start" (`claude-seat-review.test.ts:581`,
  `chain-detector.test.ts:166`).

The orchestrator's census before this change counted 26 of the first form
with a line search; the parse finds the other 34. Every upper-bound
`expect` in a file with a clock read was listed by a looser name-taint probe
and read by hand: the ones not counted are the production-measured,
time-left, order and non-time bounds named above.

The limit rule found two tests in DETECTORS that walked the repository with
no limit: `src/no-require-in-esm.test.ts:30` (walks `src/`) and
`src/tests/integration/entry-guard-symlink.test.ts:79` (walks `scripts/` and
`src/`). This change gives each `120_000`; no assertion changed. The two
dist-readers tests that read its repository scan and the two of this
detector already carry `REPO_SCAN_TIMEOUT_MS`. The dist-readers tests that
scan a fixture made by `tempRoot()` (`mkdtempSync`) are not counted.

Mutations, each made in the tree, run, and undone:

- `expect(Date.now() - t).toBeLessThan(500)` added to
  `src/common/path-containment.test.ts` turned "no test file gained a
  wall-clock upper bound" red, naming the file, line and text; removed, green.
- `const elapsed = Date.now() - t; expect(elapsed).toBeLessThan(500)` added
  there: red; removed, green.
- One bound removed from `src/rag/file-pattern.test.ts`: "the baseline is
  lowered as soon as a bound goes away" red ("baseline 2, now 1"); restored,
  green.
- The limit taken off one of this detector's own repository tests: "every
  test of a gates detector that walks the tree in its body carries a limit"
  red, naming that test; restored, green.
- This detector taken out of `DETECTORS`: "gates.mjs runs this detector"
  red; restored, green.
- The `120_000` taken off `no-require-in-esm.test.ts`: the limit rule red,
  naming `src/no-require-in-esm.test.ts:30`; restored, green.
- `pinLoosening` of `scripts/ci/check-test-integrity.mjs` on a
  `WALL_CLOCK_BASELINE` with one line raised (2 → 3) and one file added
  names both; with a line lowered (2 → 1) it names nothing.

The repository measurement took 1.3 s at a load average of about 19, and
20–31 s at 41–47 on the same day, in the mutation runs above: past the 30 s
default on the second run. That is why its two tests carry
`REPO_SCAN_TIMEOUT_MS`.
