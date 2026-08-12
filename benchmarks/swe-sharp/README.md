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

**Not implemented:** the execution loop — clone each repo at `baseCommit`, apply
`testPatch`, run the agent, apply its patch, `dotnet test`, feed the TRX to the
scorer. That step needs the .NET SDK, which was not available on the machine
this was built on, so writing it would have meant shipping orchestration code
nobody had ever run. The scoring half above is the part that fails *silently*
when it is wrong, so that is the part that was built and tested; process
orchestration fails loudly and can be written against a working toolchain.

## Running it

```
node scripts/bench/swe-sharp/fetch-tasks.mjs           # pin the subset
node scripts/bench/swe-sharp/fetch-tasks.mjs --check   # has upstream changed?
```

`--check` re-fetches and compares content hashes. A changed hash means scores
from before and after are not comparable — re-pin deliberately rather than
absorbing the change into an improvement narrative.

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
