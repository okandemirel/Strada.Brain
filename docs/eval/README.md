# Strada.Brain learning ablation harness

This directory documents the eval harness for the two things `npm test` cannot
answer:

- **(A) Does learning help?** — with the same store, the same probes and the same
  code, is the system measurably better with learning on than with it off?
- **(B) Is the answer good?** — does a generated answer satisfy an *absolute*
  rubric, and does injecting recalled guidance make it better or worse?

Runner: [`scripts/eval/learning-eval.mjs`](../../scripts/eval/learning-eval.mjs)
(logic in `learning-eval-core.mjs`, arms in `learning-eval-arms.mjs`, pinned
dataset in `scripts/eval/datasets/learning-ablation.json`). The harness's own
tests are `tests/eval/learning-eval.test.ts` and they DO run in `npm test`.

Part (A) **runs** — in process, against throwaway SQLite databases, with no
network and no credentials. Part (B) needs a real chat provider; without one it
is reported as **NOT MEASURED**, which is not a pass (see the exit codes).

---

## The three measures (plan item 6.3)

| Measure | What it is | Denominator |
|---|---|---|
| **repeat-error reduction** | a failure mode the system already solved once comes back | held-out probes that re-present a trained failure mode |
| **harmful recall** | recalled guidance that does not apply to the probe, and probes the control accepted that learning-on did not | probes where anything was recalled |
| **cost per accepted result** | attempts charged per accepted probe (and, in the quality arm, provider tokens per accepted answer) | probes the arm accepted |

Every rate with a zero denominator is reported as **NOT MEASURED**, never as 0%.

## The arms

| Arm | Store | Learning | What it is for |
|---|---|---|---|
| `cold` | empty, created for this run | on | proves the warm arms' recalls come from this run's training and not from a seeded or leftover store (it asserts 0 instincts) |
| `warm-learning-off` | trained | **off** (`ErrorLearningHooks.disable()`) | **the control**: the knowledge exists and is never consulted, so any difference is retrieval, not the dataset |
| `warm-learning-on` | trained | on | the treatment |

Each arm gets its **own** temp database, so a cold arm is genuinely cold and the
control cannot see what the treatment recalled. The probes are **held out**: the
dataset validator refuses a probe that reuses a trained `errorMessage`, so a warm
arm has to generalise rather than remember.

Both production retrieval paths are exercised: `ErrorLearningHooks
.onBeforeErrorAnalysis` (the learned-solutions block injected at the moment of
the error, `minConfidence` 0.5) and `InstinctRetriever.getMatchedInstincts` (the
proactive insight retrieval, lexical similarity ≥ 0.4, deprecated/quarantined
filtered). The proactive path is queried with the failing output itself — the
strongest query a run could give it, deliberately generous to the system.

After the probes settle, `src/learning/ledger.ts` is asked the plan 6.4 question
about every rule that recalled wrongly: is it findable without knowing its id
(`findSuspectGuidance`), is the evidence against it dated, and when the harness
retires it does the effect actually **end** (status out of reach, no generated
artifact still carrying it, zero runs credited afterwards)?

---

## What is real and what is not

**Real:** `LearningStorage`, `LearningPipeline` (error→repair minting, run-scoped
credit settled from each run's terminal verdict), `PatternMatcher`,
`ErrorLearningHooks`, `InstinctRetriever`, `src/learning/ledger.ts`, and the
SQLite databases.

**Not real:** the tool execution. Whether a probe ends accepted, and what it
costs, comes from an oracle **declared in the dataset** — pre-registered, with a
`rationale` string per probe, so the numbers can be argued with instead of taken
on trust. Ablation cost is in **attempts**, never in currency. The harness prints
this on every run.

**Retrieval backend:** no embedder is wired, so recall here is **lexical**.
Semantic recall is *not* measured and no claim is made about it.

**Comparative claims are out of scope and cannot be made from this repo.** A fair
"better than X" claim needs the other systems actually running, a shared
published dataset, a pre-registered judging protocol, and statistical treatment
of variance. None of those exist here. This harness scores ONE system against an
ABSOLUTE rubric.

---

## Exit codes — "SKIPPED" is not "measured"

| Code | Meaning |
|---|---|
| `0` | **measured and good** — every requested measure ran and stayed inside its pre-registered bound |
| `1` | **measured and regressed** — something ran and came out worse than its bound |
| `2` | bad invocation, unreadable dataset, or the harness itself failed |
| `3` | **NOT MEASURED** — a requested arm or measure could not run |

A skipped arm is never folded into a pass. Running the default invocation without
a provider gives `3`, not `0`, because the answer-quality arm was requested and
could not run. `--ablation-only` drops that arm from the requested set — an
explicit operator choice, printed in the report.

```bash
node scripts/eval/learning-eval.mjs --ablation-only    # no provider needed
node scripts/eval/learning-eval.mjs                    # + answer quality (needs a provider)
node scripts/eval/learning-eval.mjs --json             # machine-readable
node scripts/eval/learning-eval.mjs --verify-can-fail  # prove the gate fires (expects exit 1)
```

`--verify-can-fail` runs the real arms with the treatment's learning forced off,
so a working harness MUST report a regression; if it reports anything else it
exits `2` and says the gate is broken.

---

## Dataset format (version 2)

```jsonc
{
  "version": 2,
  "thresholds": {
    "minRepeatErrorReduction": 0.5,   // learning must remove this fraction of the control's repeats
    "maxHarmfulRecallRate": 0.34,     // at most this fraction of recalls may not apply
    "maxCostRatio": 1.1,              // learning-on cost per accepted result, over the control's
    "minQualityAccept": 0.7,
    "maxQualityHarmRate": 0.0
  },
  "train": [{
    "family": "missing-metadata-reference",   // stable id a probe refers to
    "tool": "dotnet_build",
    "target": { "file_path": "/proj/Assembly-CSharp.csproj" },  // the repair must act on the SAME target
    "errorMessage": "error CS0006: Metadata file '…Strada.Core.dll' could not be found",
    "repairs": 4                              // successful runs credited after the fix
  }],
  "heldOut": [{
    "id": "p1-metadata-other-assembly",
    "family": "missing-metadata-reference",   // null when the probe is novel
    "tool": "dotnet_build",
    "errorCode": "CS0006",
    "errorMessage": "error CS0006: Metadata file '…Strada.Modules.dll' could not be found",
    "resolvedBy": ["missing-metadata-reference"],   // [] makes it a TRAP
    "rationale": "why the oracle says what it says",
    "cost": { "withoutGuidance": 3, "withGuidance": 1, "wrongGuidancePenalty": 1 },
    "accepted": { "withoutGuidance": true, "whenMisled": false }
  }],
  "quality": [{ "id": "q1", "prompt": "…", "rubric": [ /* see below */ ] }]
}
```

The thresholds are pre-registered **for that probe set**, not universal claims:
the harmful-recall budget in particular depends on how many traps the set holds
(4 of 7 in the pinned dataset).

`repairs` is not decoration. A freshly minted instinct sits at confidence 0.50
and the error-recovery path asks for 0.5 *after* weighting (0.95 × 0.50 = 0.475),
so an unreinforced rule is never offered to a run — the warm arm has to pay for
its confidence with successful runs, exactly as production does.

---

## Scoring rubric (Part B — absolute, never comparative)

| `kind` | Shape | Needs LLM? |
|---|---|---|
| `must_contain` | `{ id, weight, kind, any: string[] }` — ≥1 substring present (case-insensitive) | No |
| `must_not_contain` | `{ id, weight, kind, all: string[] }` — none present | No |
| `regex` | `{ id, weight, kind, pattern: string }` — matches `/pattern/i` | No |
| `judge` | `{ id, weight, kind, question: string }` — a second LLM answers | **Yes** |

Score = `sum(weight * criterionScore) / sum(weight)` over the criteria that could
be scored. A `judge` criterion with no judge configured is reported as
**unscored** and left out of the denominator — never silently passed.

Each quality case is answered **twice**: once with no learned guidance, once with
the guidance production's proactive retrieval actually returns for that prompt.
A guided answer that scores lower is harmful recall at the answer level, and it
feeds measure 2.
