---
id: system-prompt-is-byte-stable
kind: decision
tier: 1
status: active
topics: ["agent-loop", "providers"]
paths: ["src/agents/turn-context.ts", "src/agent-core/engine/prepare-iteration.ts", "src/agent-core/engine/tool-turn.ts", "src/agents/orchestrator-loop-shared.ts", "src/agents/orchestrator.ts"]
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
- **Turn context** (`src/agents/turn-context.ts`): everything `prepareIteration` rebuilds goes under one header. `silentStream` appends it to the last user turn of the request it sends, on every path (RunClock stream, v1 stream, chat(), the retry after a stream error). It is never stored, so the history stays append-only and the next call's prefix covers the previous call up to the context.
- **Memory refresh:** what a refresh recalls is appended once to the turn the loop is about to send (`appendToLastUserTurn`), capped at 12k characters per recall.
- **Log:** the "Provider call" line carries `turnContextChars`. The replay counts it as neither head nor history: it is sent on every call and never cached.

## Rejected alternatives
- **Storing the per-step sections in the history** (as the reflection prompt is). The plan alone is up to a few thousand characters, so every turn would add a copy and compaction would come sooner.
- **Keeping the role section in the prompt.** It differs between phases (planner, executor, reviewer), and its routing reasons ("phase score … from N outcomes") change from call to call when more than one provider is routed.
- **Sending recalled memory in the turn context.** Up to 24k characters of accumulated recall would be re-sent uncached on every call.
- **Leaving the memory refresh in the prompt.** With the defaults (every 5 iterations, up to 10 per run) that is a full miss each time something new is recalled.

## Consequences
- **Projection.** This is the replay's `current` arm at 128k, under its lower bound ("head as logged"), on the two logs `compaction-must-respect-the-prefix-cache` names. Each session's smallest prompt is taken as its stable prompt, and the rest of each call's prompt as its turn context.
  - October log: prompt churn 0%; cached share 4% → 48%; relative cost −44%.
  - September log: prompt churn 0%; cached share 7% → 56%; relative cost −52%.
  - Not measured: a live run. `cache-hit-report.mjs` on a run made after this change is the measurement.
- **The next lever is the tool list.** It still changes on 35–46% of transitions, because the reflecting and planning phases hide the write tools. Under the replay's stable-head bound the same logs cost a fifth (October) to two fifths (September) of the projection above. Changing the offer per phase is behaviour, so it was left out.
- **Who no longer sees recalled memory.** The review calls built from `runCtx.systemPrompt` no longer see it, and compaction can summarize a recall away. The refresher will not recall it again, because it dedups against what it injected.
- **Tests.** The golden run pins one system prompt per node worker (plan, act, report) and one tool list within EXECUTING. `prepare-iteration.test.ts` pins the split.
