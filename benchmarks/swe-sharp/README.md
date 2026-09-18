# SWE-Sharp-Bench

Task set and scoring for [microsoft/SWE-Sharp-Bench](https://huggingface.co/datasets/microsoft/SWE-Sharp-Bench)
— SWE-bench for the C#/.NET ecosystem. Each task gives a repository, the commit
to start from, a problem statement, the tests that must go from failing to
passing (`FAIL_TO_PASS`), and the tests that must not break (`PASS_TO_PASS`).

## What is here, and what is not

**Implemented and tested:**

| Piece | Where | Covered by |
|---|---|---|
| Deterministic 50-task subset, content-hashed | `scripts/bench/swe-sharp/fetch-tasks.mjs`, `tasks.json` | `src/bench/swe-sharp.test.ts` |
| Dataset decoding (`FAIL_TO_PASS` etc.) | `src/bench/swe-sharp-dataset.ts` | same |
| Repo-spread subset selection | `src/bench/swe-sharp-dataset.ts` | same |
| `dotnet test` TRX report parsing | `src/bench/trx-report.ts` | `src/bench/trx-report.test.ts` |
| Resolution scoring and run summary | `src/bench/swe-sharp-resolution.ts` | `src/bench/swe-sharp.test.ts` |
| Execution loop: clone → testPatch → candidate → `dotnet test` → score | `scripts/bench/swe-sharp/run-tasks.mjs`, `src/bench/swe-sharp-runner.ts` | `src/bench/swe-sharp-runner.test.ts` |

The execution loop was missing until 2026-09-18 for a stated reason: the machine
had no .NET SDK, and shipping orchestration nobody had ever run would have been
worse than shipping nothing. .NET 10.0.400 is installed now, the loop exists,
and it has been run for real — see **Proof it ran** below.

## Running it

```
node scripts/bench/swe-sharp/fetch-tasks.mjs           # pin the subset
node scripts/bench/swe-sharp/fetch-tasks.mjs --check   # has upstream changed?

# the control run: does the harness score the reference solution as resolved?
npm run bench:swe-sharp:run -- --task autofac__autofac-1362 --candidate gold

# evaluate an agent (any command; see the candidate contract below)
npm run bench:swe-sharp:run -- --candidate 'my-agent --fix' --limit 5
```

`--check` re-fetches and compares content hashes. A changed hash means scores
from before and after are not comparable — re-pin deliberately rather than
absorbing the change into an improvement narrative.

### Exit codes

Same contract as `scripts/eval/learning-eval.mjs`:

| code | meaning |
|---|---|
| 0 | every requested task RAN and the run met its budget |
| 1 | the run happened and came out below its `--min-resolved-rate` floor |
| 2 | bad invocation, unreadable task set, harness error |
| 3 | a requested task did NOT run, or a pass could not be proven |

### The candidate contract

`--candidate <command>` runs with the checkout as its working directory and

```
STRADA_BENCH_INSTANCE_ID  STRADA_BENCH_REPO      STRADA_BENCH_BASE_COMMIT
STRADA_BENCH_WORKDIR      STRADA_BENCH_PATCH_OUT STRADA_BENCH_PROBLEM_FILE
STRADA_BENCH_TIMEOUT_MS
```

Write a unified diff to `$STRADA_BENCH_PATCH_OUT`, or just leave the work in the
checkout. When no patch file appears, the harness diffs the final tree against
the revision recorded **before** the candidate ran, so it does not matter how the
candidate left things: unstaged, `git add`-ed, committed, or committed on a branch
it created are all captured, as are files it added. `git diff` alone would have
meant "unstaged only", and an agent that stages its fix — a very ordinary thing
for an agent to do — would have been reported as producing no patch at all: a
false zero indistinguishable from a real measurement.

`.gitignore`d files are never part of the patch, so build output cannot become
the candidate's answer.

**The tests are not the candidate's to write.** Before scoring, every path the
`testPatch` touches is put back to its base state — present with the base
content, or absent — whatever the candidate did to it, and the restoration is
recorded on the attempt. The postcondition is stated positively on purpose: an
earlier version asked `git diff` which paths had changed and restored those, and
a diff does not mention an untracked file. A candidate whose patch ADDS a file
the test patch also adds (a snapshot expectation file, say) kept it, `git apply
testPatch` then failed with "already exists", and the attempt became `not-run` —
so trying to write the benchmark's expectations was a way to escape measurement
rather than to be scored, and the row read like an environment problem.

If a test path cannot be put back, the task is `not-run` with a harness error:
whatever the suite reports next would not be a measurement of the candidate.

`--json` writes only the JSON document to stdout (the verdict footer goes to
stderr), so `… --json | jq` works on a completed run.

Two candidates are built in. `gold` applies the task's reference patch: a CONTROL
run that measures the harness, labelled as such in every report, never an agent
score. The default candidate is `strada`, and it is an explicit **not-run**: a
real Strada worker run makes paid provider calls and this harness does not spend
credit on its own. Wire Strada in as `--candidate '<your worker command>'`.

## What the loop refuses to do

**A task that did not run is not a failed task and not a pass.** `not-run` is a
third status with a named reason (`no-network`, `clone-failed`,
`test-patch-failed`, `no-solution`, `build-failed-before-candidate`,
`candidate-timeout`, `test-timeout`, `runtime-unavailable`, `no-test-report`,
`fail-to-pass-already-passing`, `not-attempted`, `harness-error`), it stays out of the rate's denominator, and it
exits 3. Folding a failed clone into the unresolved column produces a real number
over an invented denominator, and nothing in the output would say so.

**A candidate that produced no patch is a scored attempt.** "The agent declined"
and "the harness broke" are different columns. Collapsing them shrinks the
denominator every time a model gives up, which flatters the score.

**FAIL_TO_PASS is observed failing first.** Every task runs its tests BEFORE the
candidate, so `resolved` means *fixed* rather than *was already green*. Two cases
matter and are handled separately: a FAIL_TO_PASS test that already passes makes
the task unscoreable (`fail-to-pass-already-passing`, not-run), while a test
patch that does not *compile* before the fix is the expected failing state — a
test that cannot compile cannot pass — and not a broken environment. Telling
those apart needs a build of the checkout before the test patch, which the loop
does. `--no-baseline` skips the pre-run and then every pass is reported UNPROVEN
and exits 3 unless `--allow-unproven` is passed.

**Competitor comparison is NOT MEASURED.** The improvement plan names Hermes
v0.21.2 and Bezi 1.36.0. Neither is installed here and neither publishes a
SWE-Sharp-Bench score, so every report prints them as `NOT MEASURED` with that
reason. The row's type makes a number impossible to add by accident.

## Environment deviations, recorded per task

These tasks were authored against .NET 6/7 and run here on the .NET 10 SDK, so
the loop has to relax what the repos pin and it records each change on the
attempt:

- `global.json` `rollForward` is set to `latestMajor`, then **committed inside the
  throwaway checkout** before the candidate's base revision is recorded — an
  uncommitted harness edit would land in the candidate's diff and be attributed
  to it.
- `DOTNET_ROLL_FORWARD=LatestMajor` lets a `net7.0` test assembly run on the
  installed .NET 10 runtime. Without it every one of these tasks is `not-run`.
- Only the newest .NET-Core-family target framework is tested; `net472` cannot
  run on macOS and `netstandard2.0` is not runnable at all.
- By default only the test projects that root the required test names are built,
  and `--filter` narrows the run to the required tests. Both are what scoring
  reads. `--no-filter` and `--project` override it.

## Proof it ran

All numbers below are from real runs on 2026-09-18, macOS arm64, .NET SDK
10.0.400 (the only SDK installed). TRX counts come from the TRX files the runs
produced.

### Six tasks, six repositories, gold control

`--candidate gold`, 93 s wall for all six. Run three times as the scoring path
changed — every run produced identical verdicts; the wall times here are from the
most recent:

| task | result | wall | TRX |
|---|---|---|---|
| `autofac__autofac-1362` | RESOLVED, proven | 20.1 s | 3 / 3 passed |
| `gui-cs__terminal-gui-3195` | RESOLVED, proven | 21.1 s | 1 / 1 passed |
| `restsharp__restsharp-1676` | RESOLVED, proven | 12.2 s | 1 / 1 passed |
| `spectreconsole__spectre-console-1303` | RESOLVED, proven | 18.5 s | 1 / 1 passed |
| `serilog__serilog-1897` | RESOLVED, proven | 12.5 s | 15 / 15 passed |
| `devlooped__moq-1079` | **NOT RUN** (`runtime-unavailable`) | 8.2 s | — |

`resolved 5/5 (rate 1.0), proven fail→pass 5/5, NOT RUN 1`, **exit 3** — because
a requested task did not run. The Moq task targets `netcoreapp3.1`, whose test
host needs an x64 .NET that does not exist for arm64 macOS (`Could not find
'dotnet' host for the 'X64' architecture`). That is an environment gap, so it is
reported as one.

Both of those rows were wrong in an earlier revision of this harness, and the
failures are worth recording because each produced a *number* rather than an
error: the Moq task was scored `unresolved` (a missing runtime read as a failed
patch), and Terminal.Gui was scored `unresolved` because the loop tested
`Terminal.Gui.csproj` — the library whose name roots `Terminal.Gui.ViewTests.…` —
which runs no tests and so reports every required test absent. `classifyTestRun`
and `looksLikeTestProject` exist because of those two false scores.

### One task, five candidates (`autofac__autofac-1362` @ 0c79d7bc)

| candidate | wall | TRX | status | exit |
|---|---|---|---|---|
| `gold` (control) | 12.8 s | 3 / 3 passed | RESOLVED, proven | 0 |
| `gold`, cold clone cache | 25.0 s | 3 / 3 passed | RESOLVED, proven | 0 |
| `echo "I decline to fix this."` | 12.5 s | — | unresolved, "candidate produced no patch — scored attempt, not a harness error" | 0 |
| a real but wrong edit (appends a comment) | 14.1 s | total 3, passed 2, **failed 1** | unresolved, "1 FAIL_TO_PASS not passing" | 0 |
| default (`strada`) | 11.7 s | — | NOT RUN (`candidate-unavailable`) | 3 |
| `gold --no-baseline` | 12 s | 3 / 3 passed | resolved but **UNPROVEN** | 3 |
| `gold --no-baseline --allow-unproven` | 12 s | 3 / 3 passed | resolved, unproven, accepted on request | 0 |

The pre-patch TRX for that task recorded
`DefaultConstructorFinderTests.SupportsZeroPublicConstructorTypes` as `Failed`
and the two PASS_TO_PASS tests as `Passed`; after the gold patch all three are
`Passed`. That is an observed fail→pass transition, not an inferred one — and the
wrong-edit row is the check that the harness can tell a fix from a non-fix at
all.

### Three more false zeros, found by review and fixed

A candidate that **staged or committed** its fix was scored as producing no
patch, because the capture used `git diff`. The fix diffs against the revision
recorded before the candidate ran. Measured both ways on
`autofac__autofac-1362` with fixture candidates that `git add` and `git commit`:

| fixture candidate | before the fix | after the fix |
|---|---|---|
| applies the reference fix, stages it, commits it | "candidate produced no patch" (false zero) | RESOLVED, proven, 21.0 s, trx 3 / 3 passed |
| appends a comment, stages it, commits it | "candidate produced no patch" | unresolved, "1 FAIL_TO_PASS not passing", 37.0 s, trx 3 total / 2 passed / 1 failed |

A third escape, on `spectreconsole__spectre-console-1303`, whose `testPatch` adds
a snapshot expectation file: a candidate that supplies a patch adding *that same
file* instead of fixing the bug.

| | result |
|---|---|
| before | `NOT RUN (test-patch-failed)`: "…ValueColor.Output.verified.txt: already exists in working directory", 19.6 s — unmeasured |
| after | **unresolved**, "build failed", 19.4 s, and the attempt records `candidate edits to 1 test file(s) were discarded before scoring` |

"build failed" is the honest answer there: the restored test patch calls
`BreakdownChart.WithValueColor`, which only exists after the real fix, so the
test project does not compile (`error CS1061`) — the cheat is scored, not excused.
The gold control on the same task still resolves (22.1 s, trx 1 / 1 passed), so
the restoration did not break the honest path.

The second row matters as much as the first: the harness now tests the staged
work and still says no when the work is not a fix.

`--json` also printed a human verdict footer on stdout, so piping a completed
run into a parser failed. Verified fixed: `… --candidate gold --json | node`
`JSON.parse` → `verdict ran-and-met-budget exit 0 resolved 1/1 trx
{total:3,passed:3,failed:0}`.

### What has NOT been run

The full pinned 50-task subset has not been run end to end, and no agent has been
scored on it: the default candidate is `not-run` by design. Six of fifty tasks
have been executed. Repos with heavy test suites (efcore, Avalonia, jellyfin) and
tasks pinned to frameworks with no arm64 runtime are expected to produce more
`not-run` rows; each will name its reason rather than depress a score.

## Decisions worth knowing

**Test lists are Python repr, not JSON.** The columns arrive as
`"['Ns.Class.Method']"` — single-quoted. `JSON.parse` throws on that, and a
decoder that catches the throw and returns `[]` gives every task zero required
tests, so every task scores as resolved and the benchmark reports a perfect
score while measuring nothing. `parsePythonStringList` throws instead.

**20 upstream tasks have an empty `FAIL_TO_PASS`.** That is real, not a decoding
bug — verified against the raw API. They cannot demonstrate that anything was
fixed, so they are excluded from the subset rather than counted as automatic
failures, which would depress the score for a reason unrelated to the agent.

**The subset is spread across repositories.** Sorting by instance id and taking
the first 50 is deterministic, but the first 50 ids come from only 3 of the
dataset's repositories. The pinned subset round-robins instead: 50 tasks across
17 repos.

**Absent means failed.** A test missing from the TRX report did not pass — it
was not run, the build failed, or the patch renamed it. Treating absent as
passed is the single change that turns a broken run into a perfect score.
Skipped is likewise not passed: a patch that adds `[Skip]` to the failing test
must not score as a fix.

**Both halves of the score matter.** `PASS_TO_PASS` is the half that is easy to
drop, and without it deleting the failing assertion counts as a fix.

**The gold patch is never fed to the agent.** It is kept in `tasks.json` for
scoring context and for a control run — "does the harness score the reference
solution as resolved?" — which is the right first thing to check once the
execution loop exists.
