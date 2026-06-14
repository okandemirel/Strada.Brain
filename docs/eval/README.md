# Strada.Brain Eval Harness (scaffold)

This directory documents an **honest** evaluation scaffold for the two parts of
Strada.Brain that the normal test suite (`npm test`) cannot prove:

- **(A) Self-learning effectiveness** — do instincts learned from seeded errors
  on a first run measurably improve behaviour on a second run?
- **(B) Response quality** — does a produced answer satisfy an *absolute* rubric?

Runner: [`scripts/eval/learning-eval.mjs`](../../scripts/eval/learning-eval.mjs).

> **This is a scaffold, not a passing eval.** It defines the dataset format, the
> scoring rubric, and a runner skeleton. It does **not** assert success today:
> Part (A) still needs to be wired to the built learning code, and Part (B)
> needs a real LLM. The runner reports those as `SKIPPED`, never as fake passes.

---

## Why this is separate from `npm test`

The vitest suite verifies *mechanics* with mocks and real local SQLite: that an
instinct row is written, that a pattern matcher returns a row, that confidence
maths is correct. It deliberately does **not** answer the subjective questions
above, because:

- "Did learning **help**?" is a behavioural-delta question across two runs, not
  a single-unit assertion.
- "Is the answer **good**?" depends on a real model generating real text and on
  a rubric judging it — neither of which belongs in a fast, offline, hermetic
  unit suite.

So these live here, clearly labelled, and CI does **not** depend on them.

---

## What this harness will and will not claim

| Claim | Status |
|---|---|
| Instinct created from a seeded error on run 1 is recalled on run 2 (local SQLite) | **Verifiable with NO network / NO creds** once Part (A) is wired |
| A generated answer meets an absolute, deterministic rubric (substring / regex) | Verifiable **once a real LLM produces the answer** |
| A generated answer meets a subjective ("judge") rubric criterion | Needs a **second real LLM** as judge — credentials required |
| "Strada.Brain answers **better than** openclaw / hermes / any other assistant" | **OUT OF SCOPE — cannot be asserted.** See below. |

### Comparative claims are out of scope (and why)

A fair "better than X" claim is **not produced by this harness and cannot be**
made from this repo. It would require all of:

1. The other systems (openclaw, hermes, etc.) **actually running** and reachable.
2. A **shared, published benchmark dataset** both systems are scored on.
3. A **pre-registered judging protocol** (fixed judge model, fixed prompts,
   blind to which system produced which answer).
4. **Statistical treatment of variance** (multiple samples, confidence intervals).

None of those exist here. This harness scores **one** system against an
**absolute** rubric — never against a rival. Any marketing-style comparative
statement about Strada.Brain's quality is unsupported by this repo's evidence.

---

## Running it

```bash
node scripts/eval/learning-eval.mjs            # auto-detect; skip what it can't run
node scripts/eval/learning-eval.mjs --dataset path/to/dataset.json
node scripts/eval/learning-eval.mjs --quality  # also attempt Part (B) — needs a real LLM
node scripts/eval/learning-eval.mjs --json      # machine-readable result
```

Exit codes: `0` = everything that actually ran passed (or nothing ran);
`1` = a check that ran failed; `2` = bad invocation / unreadable dataset.
**`SKIPPED` is never a failure** — it means a part needs wiring and/or real
credentials.

Today, with no wiring and no creds, every part reports `SKIPPED` and the run
exits `0`. That is the honest current state, not a green checkmark.

---

## Dataset format

A dataset is a JSON file `{ "version": 1, "tasks": Task[] }`. A small built-in
dataset ships inside the runner so it is self-contained; override it with
`--dataset`.

```jsonc
{
  "version": 1,
  "tasks": [
    {
      "id": "cs0006-metadata-missing",     // stable unique id
      "title": "Recurring build error is recalled on second encounter",

      // --- self-learning (Part A) ---
      "seedError": {                         // taught on RUN 1
        "toolName": "dotnet_build",
        "errorCode": "CS0006",
        "errorMessage": "error CS0006: Metadata file 'Strada.Core.dll' could not be found",
        "input": { "configuration": "Release" }
      },
      "fix": {                               // the resolution that should become an instinct
        "action": "Build Strada.Core / restore references before building dependents",
        "success": true
      },
      "probe": {                             // RUN 2: the same/similar situation re-encountered
        "toolName": "dotnet_build",
        "errorCode": "CS0006",
        "errorMessage": "error CS0006: Metadata file 'Strada.Core.dll' could not be found",
        "input": { "configuration": "Debug" }
      },
      "expectInstinct": {                    // what RUN 2 should recall
        "minConfidence": 0.0,                // default: just "exists & matches"
        "matchKind": "error_fix"             // error_fix | error_pattern | correction
      },

      // --- response quality (Part B) ---
      "prompt": "My Unity build fails with CS0006 ... what do I do?",
      "rubric": [ /* RubricCriterion[] — see below */ ]
    }
  ]
}
```

Fields not relevant to a given part are ignored by that part.

---

## Scoring rubric (Part B — absolute, never comparative)

Each answer is scored against `RubricCriterion[]`. Scores are **absolute**
("does the answer meet this bar?"), never relative to another model.

| `kind` | Shape | Needs LLM? |
|---|---|---|
| `must_contain` | `{ id, weight, kind, any: string[] }` — ≥1 substring present (case-insensitive) | No |
| `must_not_contain` | `{ id, weight, kind, all: string[] }` — none present | No |
| `regex` | `{ id, weight, kind, pattern: string }` — matches `/pattern/i` | No |
| `judge` | `{ id, weight, kind, question: string }` — a second LLM answers yes/no | **Yes** |

Final quality score = `sum(weight * criterionScore) / sum(weight)` in `[0, 1]`.
There is **no pass/fail threshold** baked in — a threshold is a product/policy
decision, not something this scaffold asserts.

The deterministic kinds (`must_contain` / `must_not_contain` / `regex`) are
already implemented (`scoreDeterministicRubric`) and are honest, cheap signals
(e.g. "did it mention the Strada.Core API it was supposed to?", "did it avoid a
banned hallucinated step?"). They still require a **real generated answer** to
score — the harness will not invent one.

---

## What still has to be built (the honest TODO list)

### Part (A) — self-learning (verifiable with NO network / NO creds once wired)

The building blocks already exist in `src/learning` (built to `dist/learning`):
`LearningStorage`, `LearningPipeline` (`observeToolUse`, `runDetectionBatch`),
`PatternMatcher` (`findMatchingErrorPatterns`), and
`storage.getInstincts({ status, type, minConfidence })`.

To make Part (A) real (see the `WIRING NOTES` block in the runner):

1. `npm run build`, then `import` from `dist/learning/index.js`.
2. **RUN 1 (teach):** open a throwaway temp SQLite DB; feed each task's
   `seedError` as a failing observation, then its `fix` as a success; run
   `runDetectionBatch()` so an instinct is created.
3. **RUN 2 (probe):** present each task's `probe` and assert an instinct
   satisfying `expectInstinct` is **retrieved** (optionally from a fresh process
   on the same DB to also exercise cross-session recall).
4. **Metric:** fraction of tasks where RUN 2 recalls a matching instinct that
   RUN 1 lacked. That delta is the "did learning help" signal.

**Embedding caveat (must stay honest).** Semantic instinct recall depends on
embeddings. In this deployment embeddings fall back to a hash vector (no API
key, Ollama off — see [`../STATUS.md`](../STATUS.md)). Hash-fallback recall is
**lexical, not semantic**, so a reworded probe may not recall even when a human
would say it should. The eval must report which embedding backend was active and
treat semantic-recall results as **indicative only** under hash fallback. Do not
claim semantic learning works on the strength of a lexical match.

### Part (B) — response quality (credentials required)

1. Boot the real provider stack (or call the chat endpoint) to generate an
   answer per `task.prompt`. **No fabricated answers — ever.**
2. Score deterministic rubric criteria locally (already implemented).
3. For `judge` criteria, call a **second real LLM** (a different model is
   recommended) as judge.
4. Report per-task scores against the absolute rubric. **Never** compare to
   another assistant.

Without working provider credentials (`OPENAI_API_KEY` / a live subscription
token / `GEMINI_API_KEY` / a running Ollama), Part (B) **must remain SKIPPED**.
This cannot run in CI and must not be faked.
