---
id: wall-clock-assertions
status: active
scope: "Test files under vitest's include (src/ and tests/) that put an ordering assertion (toBeLessThan, toBeGreaterThan and their OrEqual and .not forms) on a value from a real clock read, and the tests of the gates' contract detectors (scripts/ci/gates.mjs DETECTORS) that walk the repository inside a test body."
read_trigger: "Before you write expect(Date.now() - t).toBeLessThan(…), expect(elapsed).toBeLessThan(…), expect(until - Date.now()).toBeGreaterThan(…) or any assertion on how long something took or how long is left; before you add a detector to DETECTORS in scripts/ci/gates.mjs or a test that walks the repository; when src/tests/wall-clock-assertions.test.ts names a file; when a test fails with 'Test timed out' on a loaded machine."
keywords: ["wall clock", "Date.now", "performance.now", "hrtime", "clock taint", "elapsed", "time left", "cooldown", "toBeLessThan", "timeout", "testTimeout", "false red", "flaky", "load average", "fake timers", "REPO_SCAN_TIMEOUT_MS", "DETECTORS", "gates.mjs", "duvar saati", "sahte kırmızı", "süre sınırı"]
related: ["test-integrity", "dist-readers", "clean-checkout"]
single_producer: {"file": "scripts/ci/gates.mjs", "exports": ["DETECTORS"]}
rules:
  [{"id": "no-new-wall-clock-bound", "severity": "error", "text": "No test file gains an ordering assertion whose target or bound is clock-tainted (expect(Date.now() - t).toBeLessThan(N), expect(until - Date.now()).toBeGreaterThan(K) and every other arrangement), outside an order of two bare clock values and an assertion whose every clock is proven frozen by a fake clock; the count per file is pinned in WALL_CLOCK_BASELINE and only goes down.", "detector": {"kind": "vitest", "file": "src/tests/wall-clock-assertions.test.ts"}},
   {"id": "repo-scan-carries-its-limit", "severity": "error", "text": "A test of a contract detector listed in scripts/ci/gates.mjs DETECTORS that walks the repository inside its body carries its own time limit instead of vitest's 30 s default.", "detector": {"kind": "vitest", "file": "src/tests/wall-clock-assertions.test.ts"}}]
---
# Wall-clock assertions: a busy machine is not a failing test

Several agents run on this machine at once, and its load average passes 100.
Two kinds of test then turn red on a change that has nothing to do with them:

- **A short bound on elapsed time,** in any arrangement.
  `expect(Date.now() - started).toBeLessThan(500)` measures the machine as
  much as the code. On an idle machine it passes; at a load of 100 the same
  code takes three times as long. `expect(until - Date.now()).toBeGreaterThan(K)`
  with `until = start + C` says the same thing, `Date.now() - start < C - K`,
  and fails the same way.
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
- **What counts:** `wallClockBounds` in
  `src/tests/wall-clock-assertions-taint.ts`, the clock-taint analysis.
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

- Add an ordering assertion on a clock-tainted value (an upper bound on time taken, a lower bound on time left, or the same inequality rearranged), or raise a line of WALL_CLOCK_BASELINE without a Test-Weakened line. {#no-new-wall-clock-bound}
- Walk the repository inside a test of a gates detector without a limit of its own. {#repo-scan-carries-its-limit}
- Move a bound into a helper module, a parameter or the code under test to
  get it past the detector.
- Change a bound's number to make it pass on a loaded machine. Raising
  `toBeLessThan(500)` to `toBeLessThan(5_000)` keeps a bound and weakens a
  test; replace it instead.

## What it sees

### The algebra

Every load-sensitive assertion in this class says that a later clock read
minus an earlier one, or a stamp the code under test made in between, stays
below some K. Load makes that difference larger. The same inequality can be
written with the difference on either side, with either side as `expect`'s
target, with an upper or a lower matcher, with `.not`, and with the slack
moved into a stamp (`until = start + C`):

| Written as | Is |
| --- | --- |
| `expect(Date.now() - t).toBeLessThan(K)` | `late - early < K` |
| `expect(stamp - before).toBeLessThanOrEqual(K)` | `stamp - early <= K` |
| `expect(stamp).toBeLessThanOrEqual(before + K)` | the same, rearranged |
| `expect(before + K).toBeGreaterThanOrEqual(stamp)` | the same, sides swapped |
| `expect(until - Date.now()).toBeGreaterThan(K)` | `late - early < C - K` |
| `expect(until).toBeGreaterThan(Date.now() + K)` | the same, rearranged |
| `expect(Date.now()).toBeLessThan(deadline)`, `deadline = Date.now() + K` | `late - early < K` |
| `expect(sum / n).toBeLessThan(K)` over pushed `performance.now() - s` | an average of `late - early` |

What every row has in common is that one side of the assertion comes from a
real clock read. So the rule does not list shapes. It counts by taint.

### Clock taint

`wallClockBounds` parses each test file with the TypeScript parser and
resolves names in their own scope; it does not match lines. A value is
clock-tainted when it comes from a real clock read:

- `Date.now()` on the global `Date` (a parameter or variable named `Date` is
  not); `performance.now()`, with `performance` global, imported from
  `node:perf_hooks` under any name, or read from a namespace or default import
  of it; `process.hrtime()` and `process.hrtime.bigint()`, with `process`
  global or imported from `node:process`, and `hrtime()` / `hrtime.bigint()`
  imported by name from `node:process`; `process.uptime()` and `os.uptime()`
  (also `uptime` imported from `node:process` or `node:os`); and an
  argument-less `new Date()`, so `new Date().getTime()` and `+new Date()` too.

The taint follows what the test file itself spells:

- names, in their own scope, also when they are destructured
  (`const { ms } = await timed(…)`, `const [first] = […]`, nested patterns
  through the whole value) or written again after their declaration
  (`let took = 0; took = Date.now() - t`, and then a literal's property is not
  read from the first literal);
- the variable of a `for (const ms of times)` or `for … in` loop, which takes
  the taint of what it walks;
- the parameter of a callback handed to a method of a tainted object, or to a
  call with another tainted argument (`times.forEach((ms) => …)`);
- any expression with a tainted part: arithmetic, `Math.abs(…)`, a template,
  a callback;
- a call whose arguments are tainted (`msSinceFailure(t + 90_000)`,
  `new Tracker(start)`), and a method called on a tainted object
  (`times.reduce(…)`, `laps.get("a")`);
- what a function the file declares returns (`timed(text)`,
  `remainingMs()`), and a property of an object literal it or a name holds
  (`run.ms`, `run["ms"]`), precisely where the key is known and through the
  whole object otherwise;
- what is pushed, unshifted, set or added onto a name (`times.push(…)`,
  `laps.set("a", …)`), and what is written into a property of a name after
  its declaration (`stats.elapsed = Date.now() - t`, `stats.times.push(…)`),
  by key, also through a `const` alias declared from it
  (`const kept = holder.times; kept.push(…)` reaches `holder.times`).

An `expect(x)` or `expect.soft(x)`, with or without a message, ending in
`.toBeLessThan`, `.toBeLessThanOrEqual`, `.toBeGreaterThan` or
`.toBeGreaterThanOrEqual`, with or without `.not`, `.resolves` or `.rejects`
(`await expect(timed()).resolves.toBeLessThan(500)`), counts when `x` or the
bound it is compared with is tainted.

### What is left out, on purpose

- **An order of two bare clock values.** Both sides tainted, and each is a
  clock read, a `const` declared with one and never written again, or
  arithmetic of two such values: `expect(b).toBeGreaterThanOrEqual(a)` with
  `a` and `b` both `Date.now()`, or two elapsed times compared
  (`expect(fast).toBeLessThan(slow)`). It checks that the clock moved on, or
  which run was faster. A side with a constant, a stamp, a call or a property
  in it has slack, and the assertion counts.
- **An assertion whose every clock is proven frozen when it runs.** A fake
  clock is left out only when the file proves it holds still for the clock
  the assertion reads, at the moment it runs. Seeing a fake call is not
  enough. The taint carries which clocks a side reads (Date, performance,
  hrtime, uptime), and every one of them must be frozen. A freeze is one of:
  - `vi.useFakeTimers()` with no options, which in vitest 4 fakes Date,
    performance and hrtime (`vitest.config.ts` sets no `fakeTimers`), or with
    an options literal that has no `shouldAdvanceTime` other than `false`;
    a `toFake` list freezes only the clocks it names. Options the analysis
    cannot read (a variable, a spread) prove nothing;
  - `vi.setSystemTime()` with no fake timers installed, which mocks `Date`
    only; on installed fake timers it changes no clock's state;
  - `vi.spyOn(Date | performance, "now")` chained, or through the name it was
    stored in, to `.mockReturnValue(…)` or to `.mockImplementation(fn)` whose
    `fn` makes no call. A bare spy passes through to the real clock, a
    `…Once` answers once, and an implementation that calls something may
    read the real clock: none of these proves a freeze.

  A freeze counts only from a statement that runs for sure: a top-level
  statement of the test body or of a block around the assertion, of a hook,
  or of a scope. The order is vitest's: collection (the plain statements of
  the file and of each enclosing `describe`), the top-level `beforeAll` hooks
  of the enclosing scopes, then their `beforeEach` hooks, outer first, then
  the test body up to the assertion (all of it when the assertion sits in a
  loop or a callback, whose order is not known). On the way, a freeze is
  undone by `vi.useRealTimers()` (everything), `vi.setTimerTickMode(…)` with a
  mode other than `"manual"` (the fake timers move by themselves),
  `vi.restoreAllMocks()`, `vi.resetAllMocks()`, `.mockRestore()` or
  `.mockReset()` (the spies), in any scope. So is any other clock call it
  cannot place for sure (a fake behind an `if`, options it cannot read), and
  a call of a function the file declares that makes a clock call. A freeze
  made at collection or in a `beforeAll` holds across tests, so any clock call
  anywhere else in the file (another test, an `afterEach`, a hook that is not
  a top-level statement of an enclosing scope, an `afterAll` of an inner
  `describe`) voids it. An assertion outside an `it`/`test` is under no
  proven freeze.

Both are fixtures. "leaves out …" holds the orders and every proven freeze:
a `beforeEach`, an arrow-bodied `beforeEach`, `toFake: ["Date"]`,
`shouldAdvanceTime: false`, `setSystemTime` with and without fake timers, a
spy with `mockReturnValue` or a call-free `mockImplementation`, a stored spy,
`setTimerTickMode("manual")`, a freeze at collection and in a `beforeAll`
with an `afterAll`. "counts an assertion whose clock is not proven frozen"
holds each way a fake clock still lets the real time through: fake timers
undone in the body under a `beforeEach` freeze, a bare spy, `shouldAdvanceTime:
true`, `restoreAllMocks`, `mockRestore`, `toFake: ["performance"]` read through
`Date.now()`, `toFake: ["setTimeout"]`, `setSystemTime` read through
`performance.now()`, `mockReturnValueOnce`, an implementation that calls
through, `setTimerTickMode("interval")`, a file function that calls
`useRealTimers`, a fake behind an `if`, a loop and a callback with
`useRealTimers` after the assertion, unread options, `setSystemTime` on
advancing timers, `process.uptime()` under fake timers, an assertion in a hook,
and a `beforeAll` freeze undone by another test, by an `afterEach`, or by an
inner `describe`'s `afterAll`.

### Where it counts too much

In doubt it counts: this is a ratchet, so counting too much only makes the
baseline larger, while counting too little lets a new bound through. These
are counted although load may not break them, each a fixture ("counts too
much …"):

- an upper bound on a time left, `expect(deadline - Date.now()).toBeLessThan(K)`;
- a stamp under a clock read taken after it, `expect(stamp).toBeLessThanOrEqual(after)`;
- a fake clock installed by a helper the test calls (`freeze()`), which the
  analysis does not follow;
- a freeze made at collection, voided by a clock call in another `describe`
  that runs only for that `describe`'s own tests;
- a clock read that only decides a count
  (`expect(items.filter((i) => i.at < Date.now()).length).toBeLessThan(3)`);
- a callback parameter whose taint comes from an argument only loosely tied
  to it: `vi.spyOn(tasks, "getStatus").mockImplementation((id) => …)` with
  `tasks` built from `Date.now()` taints every `id` the spy records.

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

Each item is a fixture in the detector ("cannot see …") that the analysis
leaves uncounted, so a change that starts to see one shows up there.

- **A clock read in another module:** a timing helper imported from a module
  other than the test file (`import { timed } from "./timing.js"`).
- **A clock value the code under test keeps and hands back later:**
  `logCall(Date.now() - 160_000)` and then `expect(medianMs()).toBeLessThan(…)`,
  where the second call takes no tainted argument. A duration the code under
  test measures with its own clock read is the same case. On main the known
  examples are `provider-call-log.test.ts:93` (`medianTurnMs()`),
  `memory-refresher.test.ts:698` (`result.durationMs`), `metrics.test.ts:95`
  (`uptime`) and `v2-agent-runner.test.ts:1304` (`accumulatedSilentMs()`).
  When the test hands the clock value to the call it asserts on, or to the
  constructor of the object it asserts on, the taint follows it.
- **A parameter of a function the file declares:**
  `function fast(ms: number) { expect(ms).toBeLessThan(100); }` called with
  an elapsed time. Such a parameter is not followed to its callers (a
  callback's parameter is, above). An object filled through such a parameter
  is the same case: `function fill(into) { into.ms = Date.now() - 5 }` and then
  `expect(box.ms)` after `fill(box)`.
- **A fake clock undone by a helper from another module:** an imported
  `unfreeze()` that calls `vi.useRealTimers()` is not read, so a freeze before
  it still counts as held (`golden-run-harness.ts` calls `vi.restoreAllMocks()`
  this way; no test that imports it puts a bound under a spy freeze today).
- **A class field or method:** `this.start = Date.now()` read back through
  `c.took()`.
- **An alias of the clock function or a clock reached another way:**
  `const now = Date.now; now()`, `Date.now.bind(Date)`, `globalThis.Date.now()`.
- **Other assertion shapes:** `expect(Date.now() - t < 500).toBe(true)`,
  `assert.ok(…)`, `expect(x).toSatisfy(…)`, a matcher reached by a computed
  name (`expect(x)["toBeLessThan"](…)`), and chai's `.below()`.
- **Files the parse skips.** A file that spells neither `now`, `hrtime` nor
  `new Date()`, or no ordering matcher, is not parsed; such a file holds no
  clock read the analysis could follow (an imported helper is the first item
  above). `web-portal/` has its own runner and is not read.
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

Measured on 2026-11-16 on main at 1d0d374a, with the clock-taint detector:
1,140 test files in vitest's include; 246 spell a clock read and an ordering
matcher and are parsed. They hold 316 ordering assertions with a tainted side.
17 run with every clock they read proven frozen, all under a top-level
`beforeEach(() => { vi.useFakeTimers(); })` (13 in `orchestrator.test.ts`,
`message-queue.test.ts:212` and `:405`, `auto-tiering.test.ts:585` and
`:586`), and none is an order of two bare clock values, so 299 count, in 103
files, all pinned in `WALL_CLOCK_BASELINE`:

- by the tainted side: 220 the target, 30 the bound, 49 both (with slack);
- by matcher: 97 `toBeLessThan`, 32 `toBeLessThanOrEqual`, 111
  `toBeGreaterThan`, 59 `toBeGreaterThanOrEqual`; none is written with `.not`,
  `.resolves` or `.rejects`.

How it got here. The first detector (2026-11-11, main at 78500e4b) counted
upper bounds on elapsed-time shapes and found 60 in 41 files. QA then found,
one per round, three arrangements it missed: an average of pushed timings
(`hnsw-performance` `searchTimeMs`), a stamp under a start plus slack
(`command-handler.test.ts:446`), and a lower bound on a time left, used 12
times (`credential-rejected.test.ts:212`, `fallback-chain.test.ts:532`,
`:696`, `:1261`, `:1269`, `:1277`, `:1418`, `quota-reset-from-message.test.ts:27`,
`:33`, `:43`, `campaign-manager.test.ts:8699`,
`dead-provider-stops-getting-work.test.ts:121`). Adding shapes one at a time
would have gone on, so the rule now counts by taint, and the algebra above
is why that covers every arrangement. All 64 bounds of the shape detector
are still counted, and so are the 12. Taint through the arguments of a call
also reaches five durations the code under test measures from a clock value
the test hands it (`progress-assessment.test.ts:174`,
`iteration-health-tracker.test.ts:159`, `crash-recovery.test.ts:22`,
`provider-outage.test.ts:91` and `:93`); the ones it cannot reach are the
second item under "What it cannot see".

The fourth QA round (2026-11-16) found two openings, neither a miscount on
main but each a way for a new bound through. The fake-clock exclusion only
looked for a fake call, so real time still passed under `beforeEach`
fake timers undone in the body, a bare spy, `shouldAdvanceTime: true`, a
restored spy, or `toFake: ["performance"]` read through `Date.now()`; it now
needs a proven freeze for each clock read, as above. And five spellings of a
named duration were not followed: a `for … of` variable, a property written
after the declaration, a callback's parameter, `.resolves`, and `hrtime`
imported by name or `uptime`. Following them adds 13 counts on main, all on
values that come from a clock but are not durations (`chain-detector.test.ts`
`for (const chain of results)`, `agentdb-retrieval.test.ts` scores of rows
stamped with `Date.now()`, `campaign-manager.test.ts:7163` and `:7164` through
a spy's callback parameter, among others): over-counting, which the ratchet
accepts, so the baseline rose from 286 to 299. No proven freeze on main was
lost: the 4 assertions excluded before are still excluded.

Between the measurements, `src/common/project-write-lock.test.ts` replaced
its bound with a counted wait (5cfabf99) and `src/security/prompt-injection.test.ts`
gained one (fef425fd) before this rule was in force; it is pinned, and
replacing it is separate work (board task #82 turns the `hnsw-performance`
and `prompt-injection` bounds into behaviour tests; their lines drop when it
lands).

The repository measurement takes 1.3–2.9 s at load averages of 19–35, and
took 20–31 s at 41–47 on 2026-11-11: past the 30 s default. That is why its
two tests carry `REPO_SCAN_TIMEOUT_MS`.

The limit rule found two tests in DETECTORS that walked the repository with
no limit: `src/no-require-in-esm.test.ts:30` (walks `src/`) and
`src/tests/integration/entry-guard-symlink.test.ts:79` (walks `scripts/` and
`src/`). This change gives each `120_000`; no assertion changed. The two
dist-readers tests that read its repository scan and the two of this
detector already carry `REPO_SCAN_TIMEOUT_MS`. The dist-readers tests that
scan a fixture made by `tempRoot()` (`mkdtempSync`) are not counted.

Mutations, each made in the tree, run, and undone:

- The QA probe, `const entry = { cooldownUntil: Date.now() + 60_000 };
  expect(entry.cooldownUntil - Date.now()).toBeGreaterThan(60_000 - 500);
  expect(entry.cooldownUntil).toBeGreaterThan(Date.now() + 60_000 - 500);`
  added to `src/common/path-containment.test.ts`: "no test file gained a
  wall-clock bound" red, naming both lines; removed, green. (The shape
  detector passed it.)
- The bound side ignored (`inBound = false`): the fixture tests and "the
  baseline is lowered" red.
- Only the upper matchers counted: the fixture test and "the baseline is
  lowered" red.
- The order exclusion taken out: "leaves out …" red.
- The fake-clock exclusion taken out: "leaves out …" and "no test file
  gained a wall-clock bound" red (the frozen assertions above).
- Breakers ignored (`clockCall` answering nothing for `useRealTimers` and the
  mock resets): "counts an assertion whose clock is not proven frozen" red.
- Clock bits ignored (every freeze treated as freezing all clocks): the same
  test red, on `toFake: ["performance"]` and `setSystemTime` read through
  `performance.now()`.
- `shouldAdvanceTime` not read: the same test red.
- The for-of variable, the property writes, and the callback parameter each
  not followed: the fixture test red, and "the baseline is lowered" red.
- `.resolves` not accepted, and `hrtime` imported by name not read: the
  fixture test red.
- Writes after a declaration not followed: the fixture test and "the
  baseline is lowered" red.
- One bound removed from `src/rag/file-pattern.test.ts` (attempt 1): "the
  baseline is lowered" red; restored, green.
- The limit taken off one of this detector's own repository tests, and the
  `120_000` taken off `no-require-in-esm.test.ts`: the limit rule red, naming
  the test; restored, green.
- This detector taken out of `DETECTORS`: "gates.mjs runs this detector" red.
- `pinLoosening` of `scripts/ci/check-test-integrity.mjs` on a
  `WALL_CLOCK_BASELINE` with one line raised (2 → 3) and one file added
  names both; with a line lowered (2 → 1) it names nothing.

Each was restored and the detector's 11 tests passed again.
