---
id: system-prompt-is-byte-stable
kind: decision
tier: 1
status: active
topics: ["agent-loop", "providers"]
paths: ["src/agents/turn-context.ts", "src/agents/recall-ledger.ts", "src/agent-core/engine/prepare-iteration.ts", "src/agent-core/engine/tool-turn.ts", "src/agent-core/engine/port.ts", "src/agents/orchestrator-loop-shared.ts", "src/agents/orchestrator.ts", "src/agents/orchestrator-session-manager.ts"]
purpose: "Stop a per-step section from going back into the worker's system prompt, where every change makes the provider's prefix cache miss the whole history."
summary: "The worker's system prompt is the run's prompt, byte for byte; per-step sections ride after the history as an unstored turn context, and mid-run memory recall is appended to the history once"
decided_on: 2026-11-06
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
The offline replay (`compaction-must-respect-the-prefix-cache`) found the worker's system prompt changing length on 93–95% of consecutive calls in a session. The prompt comes before the history, so each change made the provider miss the whole history. The changes came from `prepareIteration`, which appended per step the phase section ("Current iteration: N", the plan, the last reflection, the execution journal), the worker-role section (its routing reasons count runtime outcomes) and the provider-health note, and from the memory refresh, which rewrote sections of the prompt every few iterations.

## Decision
- **System prompt:** the prompt setup builds, the same bytes on every call of a run. Only a compaction summary changes it, a rare event that rewrites the history anyway.
- **Turn context** (`src/agents/turn-context.ts`): everything `prepareIteration` rebuilds goes under one header. `silentStream` appends it to the last user turn of the request it sends, on every path (RunClock stream, v1 stream, chat(), the retry after a stream error). When the history ends on an assistant turn (a decomposed task stores its visible plan as one), the context is a user turn of its own, so the request still ends on a user turn. It is never stored, so the history stays append-only and the next call's prefix covers the previous call up to the context.
- **Memory refresh:** what a refresh recalls is appended once to the turn the loop is about to send, capped at 12k characters per recall. The run's `RecallLedger` (`src/agents/recall-ledger.ts`) marks it and keeps it: after every step's trim and compaction the port appends each kept recall the history no longer holds to the turn about to be sent. The ledger keeps up to 24k characters, the two 12k prompt sections it replaces, and drops the oldest past that. The compaction before the retry after a hard timeout runs inside `silentStream`, where the ledger is not at hand; it carries the recalls it dropped from the history itself (`keepRecalls`).
- **Not the user's words:** the session manager's last-user-message reads leave the marked recalls out (`extractLastUserContent`). The recall rides on a tool-result turn, and the read returned it as what the user last said: the shell reviewer's "Task:", the consensus prompt and the end-turn handlers' `ctx.prompt` were handed the recall instead of the task. A user turn the ledger opened for a recall alone (after an assistant turn) is passed over for the user turn before it; read as "" it hid what the user had asked.
- **Memory persistence:** `persistSessionToMemory` takes the marked recalls out of what it stores (`withoutRecalledMemory`). A recall is what memory already held; stored again as conversation it came back on later runs under a new content hash.
- **Log:** the "Provider call" line carries `turnContextChars`. The replay counts it as neither head nor history: it is sent on every call and never cached.

## Rejected alternatives
- **Storing the per-step sections in the history** (as the reflection prompt is). The plan alone is up to a few thousand characters, so every turn would add a copy and compaction would come sooner.
- **Keeping the role section in the prompt.** It differs between phases (planner, executor, reviewer), and its routing reasons ("phase score … from N outcomes") change from call to call when more than one provider is routed.
- **Sending recalled memory in the turn context.** Up to 24k characters of accumulated recall would be re-sent uncached on every call.
- **Leaving the memory refresh in the prompt.** With the defaults (every 5 iterations, up to 10 per run) that is a full miss each time something new is recalled.
- **Letting the history alone keep a recall.** The first version did, and QA found the recall lost: every step trims the history to the provider's message cap (40 messages at 128k, hard cap 80; long runs reach it routinely), and the refresher never recalls the same content twice. The trim also handed the recall to memory as conversation.
- **Putting the turn context on the user turn before a trailing assistant turn**, so that the request ends on the assistant's plan as it did before. It would have kept the release smoke's mock green with no change to it, but a request that ends on an assistant turn is a prefill on an Anthropic-style API. The mock was what misread the request: it took the context-only turn for the user's words.
- **Passing the ledger into `silentStream`** for the hard-timeout retry. It is a positional signature the gateway mirrors; the markers already in the history say what to carry.
- **Making the refresher forget a dropped recall** so that a later refresh could bring it back. A refresh fires only when the query drifts, at most 10 times a run, so the recall would not reliably come back.

## Consequences
- **Projection.** This is the replay's `current` arm at 128k, under its lower bound ("head as logged"), on the two logs `compaction-must-respect-the-prefix-cache` names. Each session's smallest prompt is taken as its stable prompt, and the rest of each call's prompt as its turn context.
  - October log: prompt churn 0%; cached share 4% → 48%; relative cost −44%.
  - September log: prompt churn 0%; cached share 7% → 56%; relative cost −52%.
  - Not measured: a live run. `cache-hit-report.mjs` on a run made after this change is the measurement.
- **The next lever is the tool list.** It still changes on 35–46% of transitions, because the reflecting and planning phases hide the write tools. Under the replay's stable-head bound the same logs cost a fifth (October) to two fifths (September) of the projection above. Changing the offer per phase is behaviour, so it was left out. Done on 2026-11-11: `tool-list-is-byte-stable`.
- **Who no longer sees recalled memory.** The review calls built from `runCtx.systemPrompt` no longer see it. The worker's calls still do: a trim or compaction that drops a recall turn is followed by a restore, at a call whose prefix the trim has already broken, so it costs no extra cache miss. A recall past the ledger's 24k is not restored once trimmed, as the old 12k sections truncated their middle.
- **The release smoke reads requests too.** Its mock provider (`scripts/release/mock-kimi-hook.mjs`) answers by the user's last words and keys PAOR on the phase headings, so it reads past the turn context and takes the phase from the system prompt and the turn context together; a test pins its copy of the header. `gates.mjs` does not run that smoke, and CI went red on it once (the change was reverted and reapplied): a change to what a request carries runs `npm run smoke:cli:release` before it is pushed.
- **Tests.** The golden run pins one system prompt per node worker (plan, act, report) and one tool list within EXECUTING. `prepare-iteration.test.ts` pins the split. `orchestrator-integration.test.ts` runs 64 tool steps at the 40-message cap and pins that every later worker call carries the recall and that memory never stores it. `orchestrator-hard-timeout-retry-prompt.test.ts` pins the recall on the retry after a hard timeout, and `tool-turn.recall-not-user-message.test.ts` pins the task, not the recall, as the reviewer's task and the end-turn prompt after a refresh.
