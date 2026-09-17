# Benchmarks

Performance measurement for the parts of Strada.Brain that carry its value:
retrieval, chunking, and the SQLite index.

## Why this exists

Before this, the repo had no benchmark baseline at all — `docs/eval/README.md`
says so plainly, and the one benchmark-shaped test
(`src/rag/hnsw/hnsw-performance.test.ts`) was opt-in, never ran in CI, printed
to stdout, and stored nothing. There was no number to defend, so a performance
regression could only be noticed by someone complaining.

## Running

```bash
npm run bench:corpus   # generate the pinned corpus (once, or after a bump)
npm run bench          # measure, write benchmarks/.report.json
npm run bench:check    # measure + fail if slower than the baseline
npm run bench:record   # measure + (re)record the baseline for THIS machine
```

## The corpus

`scripts/bench/make-corpus.mjs` synthesizes a Unity-shaped C# corpus from a
fixed seed. No network, no repository checkout, no dependency on what happens
to be on disk — the same input every time, on every machine.

`--check` regenerates into a temp directory and compares the content hash
against `benchmarks/corpus/manifest.json`. CI runs this **before** timing
anything: a benchmark against a drifted corpus measures nothing, and would
silently produce a "regression" that is really just different input.

The generated corpus is gitignored (it is reproducible); `manifest.json` and
the baselines are committed, because the gate compares against them.

## Baselines and the gate

Absolute timings are machine-specific, so baselines are keyed
`<platform>-node<major>` (e.g. `linux-node22.json`) and committed next to the
code that produced them — a refactor moves its own baseline in the same PR.

The gate lives in `scripts/bench/gate.mjs` because `vitest bench --compare`
prints a comparison but cannot fail a build.

- **Threshold: 25%.** Deliberately loose. A per-PR gate that trips on normal
  CI-runner jitter gets muted within a week, and a muted gate protects nothing.
  25% still catches the regressions worth catching: an accidental N+1, a
  dropped index, a synchronous read on a hot path.
- **Noisy metrics do not gate.** Anything with `rme > 10%` is reported and
  skipped — there is no conclusion to draw from a measurement that unstable.
- **A missing baseline does not fail the build by default.** It warns and exits
  0, so a new runner or Node version never blocks a PR. Pass
  `--require-baseline` to turn that skip into a hard failure — a gate that is
  silent about its own absence reports success without measuring anything.
- **A metric the run no longer reports** used to print a `?` line and stop
  being gated. `--fail-on-missing-metric` (CI passes it) makes that fatal, so
  a renamed or deleted benchmark has to be re-recorded deliberately.

### First run on a new runner

CI runs `ubuntu-latest` + Node 22, so it needs `linux-node22.json`, which is
NOT committed yet: that job has never compared a timing against anything
(audited 2026-09-17). A timing baseline is only meaningful on the machine it was
measured on, so it cannot be recorded here — the bench job therefore records one
on the runner and prints it under "Print a recordable baseline for this runner".
Copy that JSON into `benchmarks/baselines/linux-node22.json`, commit it, and add
`--require-baseline` to the gate step so the skip can never come back.

## Retrieval quality: the pinned query set

`npm run bench:retrieval` measures whether search finds the right thing. Its
ground truth is derived from the corpus, not hand-labelled — and derived through
the **chunker**, whose chunk ids are `sha256(path, offset, body)`. So a change
to chunking rewrites every judgment, and the metrics would then answer a
different question than the baseline they are compared against.

`benchmarks/retrieval-queries.json` pins the query set and a hash of those
judgments. `--check` fails with "the measurement changed, not just the result"
when the hash moves; `--record` rewrites both files as the deliberate
acknowledgement.

Two recalls are reported, because one of them is flattering:

- `recall10` — the true fraction of relevant chunks returned in the top 10.
- `recallCapped10` — divided by `min(relevant, 10)`. This reads **1.0** on the
  exact-identifier family while the true recall is **0.53**: there are ~20
  relevant chunks and only 10 slots. It was the only recall reported until
  2026-09-17, under the name `recall10`.

## What is measured, and what is not

The benches exercise the **lexical** retrieval path explicitly and say so in
their names. That is deliberate: the semantic half sits behind availability
switches, so a "fused retrieval" benchmark could silently fall back to
BM25-only and report fast, green numbers while measuring something else.

Not covered yet: context-assembly latency, cold-boot time, and steady-state RSS.
Retrieval quality IS covered — see the pinned query set above.
