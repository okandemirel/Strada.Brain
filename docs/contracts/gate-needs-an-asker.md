---
id: gate-needs-an-asker
status: active
scope: "Every gate that refuses a worker's work with a [STRADA …] message, together with the planner rules, knowledge-prompt rules and tool descriptions that ask for what those gates judge."
read_trigger: "Before adding, renaming or tightening a [STRADA …] gate; before editing a rule sentence in src/goals/goal-decomposer.ts or src/agents/context/strada-knowledge.ts, or a Strada tool's description; when a live run fails the same gate sprint after sprint."
keywords: ["gate", "conformance", "STRADA", "refusal", "planner prompt", "goal decomposer", "knowledge prompt", "nothing asks", "unreachable gate", "ledger"]
related: ["esm-no-require"]
rules:
  [{"id": "every-gate-has-an-asker", "severity": "error", "text": "Every [STRADA …] gate has a ledger row naming the prompt or tool sentence that asks for what it judges, or a pinned repair/review reason.", "detector": {"kind": "vitest", "file": "src/goals/gate-askers.test.ts"}}]
---
# A gate needs an asker

Suppose a gate refuses work for a reason that no prompt ever mentioned. Then it
fails every run for the same reason, and the failure looks like the model's
fault. Unit tests do not catch this, because they test the gate and the gate
works.

This was found three times on 2026-10-14, each time by reading a live run
rather than the test suite:

- **Ready modules.** Strada.Modules was installed, but no game file
  referenced it (cf2ff13e).
- **The play-through driver.** A sprint assembled a scene and passed its
  tests. It was then refused because the game registered no
  `IPlaythroughDriver`, which no goal had ever mentioned (3efef40f).
- **Service registration.** A sprint wrote nine services and registered one
  (63680033).

Each fix was one sentence of planner prompt plus a pinned test. This contract
turns that one-off fix into a rule.

## Single producer

`src/goals/gate-askers.test.ts`: the ledger. It has one row for each
`[STRADA …]` refusal. Each row names either:

- the sentence that asks for what the gate judges, and the file that holds it
  (the goal decomposer's rules, the worker's knowledge prompt, or a Strada
  tool's description); or
- `none`, with one of two reasons: `repair` (the gate names a broken state the
  run itself created, and its own message is the instruction) or `review` (the
  gate asks for a check of finished work).

## Caller rules

- A new gate and its asking sentence land in the same change. Put the
  sentence where it will be read:
  - a deliverable goes in the decomposer's rules;
  - a constraint on how code is written goes in the knowledge prompt;
  - something a tool produces goes in that tool's description.
- The row credits the sentence that asks for **what** the gate judges. The
  gate's own message carries **how** to satisfy it.
- When you change what a gate judges, re-read its asking sentence. A gate that
  has grown stricter than its asker has become unreachable again.
- Not yet covered: delivery-time refusals that do not use a `[STRADA …]` tag
  (the play-through and identity checks). Until they carry one, add their
  asking sentence by hand and pin it in `src/goals/decomposer-game-rules.test.ts`.

## Don't

- Add or rename a `[STRADA …]` gate without a ledger row whose sentence the plan or the worker actually sees. {#every-gate-has-an-asker}
- Satisfy the ledger with a sentence in a comment. The detector drops comment lines, because a comment asks nobody.
- Mark a deliverable `none`. `none` covers only repair and review, and the count of `none` rows is pinned so that a new one shows up in the diff.
