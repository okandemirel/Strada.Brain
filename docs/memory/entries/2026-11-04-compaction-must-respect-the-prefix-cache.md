---
id: compaction-must-respect-the-prefix-cache
kind: spike
tier: 1
status: active
topics: ["agent-loop", "providers"]
paths: ["src/agents/session-compaction.ts", "src/agents/providers/provider-call-log.ts"]
purpose: "Stop a history compaction that cuts tokens from being shipped before the cache hit rate is known, since it can raise cost."
summary: "Mask old tool output deterministically, but as a rare cliff with byte-stable stubs, and only after the cache hit rate is measured"
decided_on: 2026-11-04
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": ["75167cd2"]}
---
## Context
The worker loop re-sends its history on every call: a median of about 56k input tokens per turn, with latency growing from about 4.7 s under 40k tokens to 11.2 s at 80–120k. Compaction triggers only at 70% of a 128k window. A proposal to mask old tool output above a fixed 24k budget was checked against the literature and against production agents.

## Decision
The direction is supported, but not the trigger.
- **Support:** Lindenbauer et al. (arXiv 2508.21433) found that observation masking matched LLM summarization at about half the cost of keeping everything. Deterministic drop and truncate matched summarization in other studies too.
- **The trigger's risk:** several measurements found that fewer tokens did not mean lower cost, because every rewrite of history breaks the provider's prefix cache. On the worker's provider a cached token costs about a fiftieth of an uncached one.
- **The order of work:**
  1. Log `cachedInputTokens` on every call (75167cd2).
  2. Replay recorded transcripts offline through each arm.
  3. Then build a cliff: append-only history between rare events, a high trigger, a drop to a floor, and a minimum reclaim per event.
- **What the stubs keep:** stubs are byte-stable and carry the exact call that re-fetches the content. Results of 500 characters or less stay verbatim. The recent tool results, the original task, every failure line and the latest reasoning are always kept.

## Rejected alternatives
- **A rolling mask at a fixed 24k.** It would fire every few turns and rebuild the cache each time; studies measured costs going up by 7–11% with schemes like it.
- **LLM summarization.** It costs the same as masking or more, and it lengthened runs in Lindenbauer et al.
- **A hosted classifier (Jev) to choose what to keep.** Run content derives from confidential design documents, runs use one provider plan only, and the one public compactor that uses it ships no quality evaluation. Random retention matched a hindsight oracle in arXiv 2608.16370.

## Consequences
The A/B needs paired tasks and confidence intervals. Its measures are cost, latency and re-fetch rate. Solve rate is a guardrail only, because one live run cannot detect a change in it. The OpenCode session id is per provider instance, not per conversation (`opencode.ts`). Whether that hurts cache routing is unmeasured.
