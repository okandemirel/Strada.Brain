---
id: compaction-must-respect-the-prefix-cache
kind: spike
tier: 1
status: active
topics: ["agent-loop", "providers"]
paths: ["src/agents/session-compaction.ts", "src/agents/providers/provider-call-log.ts", "src/agents/compaction-replay/**", "scripts/eval/compaction-replay.mjs"]
purpose: "Stop a history compaction that cuts tokens from being shipped before the cache hit rate is known, since it can raise cost."
summary: "Mask old tool output deterministically, but as a rare cliff with byte-stable stubs, and only after the cache hit rate is measured"
decided_on: 2026-11-04
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": ["75167cd2", "8eb57995", "9ff649bd"]}
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
The A/B needs paired tasks and confidence intervals. Its measures are cost, latency and re-fetch rate. Solve rate is a guardrail only, because one live run cannot detect a change in it. The OpenCode session id was per provider instance, so every chat went out under one session. It is now derived from the chat id (`chat-scope.ts`), and `scripts/eval/cache-hit-report.mjs` prints the hit rate per call type and provider from the daemon log. Lines written before 75167cd2 carry no cached share and read "not measured".

### Offline replay result (2026-11-06)
`scripts/eval/compaction-replay.mjs` replays the call shapes of a daemon log through three arms: append-only, the current pipeline and the cliff (`src/agents/compaction-replay/`). The sizes are real and the content is placeholder text, so this is a shape replay, not a content replay. Prices are relative: a cached token costs a fiftieth of an uncached one. A cliff is named trigger:floor:minimum reclaim, in conversation tokens. "Stable head" assumes the system prompt and tool schemas never change, an upper bound on caching. "Head as logged" makes a call miss entirely when either one changed length, a lower bound. Two logs were read:
- **proof:** `~/Documents/StradaProof/brain-runtime/strada-brain.log` (October 2026), 28 sessions, 770 calls;
- **September:** `~/.strada/strada-brain.log` and its four rotated archives (August–September 2026), 305 sessions, 8,310 calls.

The live window is 128k (`DEFAULT_CONTEXT_WINDOW`, and the window the OpenCode provider declares). Each number below is at 128k unless it says otherwise. What the replay found:
- **Append-only is not an option at 128k.** It sent 107 of the 770 proof calls over the window (p90 146,608, max 219,951) and 1,087 of the 8,310 September calls (p90 141,024, max 325,054). Its stable-head cost, 6.1% (proof) and 13.3% (September) under current, is a reference, not a choice. The report prints such an arm's "over window" count and "not viable" in place of a comparison.
- **Under a stable head, the cliff as specified did not beat current.** How far it fell short depends on the trigger and the floor:

  | stable head, vs current | 32k:12k:5k | 40k:12k:7k | 48k:16k:8k | 64k:24k:10k |
  | --- | --- | --- | --- | --- |
  | proof | +5.3% | +0.1% | +0.3% | 0.0% |
  | September | +13.9% | +9.1% | +8.2% | +6.3% |

  A lower trigger makes more events, and each event pays one uncached rebuild. On the proof log at a 256k window, the same four cliffs ranged from +10.4% to −0.2%; the September log was not replayed at 256k.
- **Keeping the newest ten results verbatim decides that verdict.** Under a stable head, the same 40k:12k:7k cliff with no result protected cost 2,968,404 on the proof log: 13.6% under current (3,435,138) and under the cliff as specified (3,437,162). On the September log it cost 43,160,474, 24.4% under current (57,128,032), and the live backstop fell from 271 runs to 52. That variant is not the specified design. It was measured by calling `replayArm` with `keepRecentResults: 0`, which the CLI does not expose. The re-fetches it would cause are not measured. Step 3 should tune how many recent results it keeps, not only the trigger.
- **The head is not stable, and it is the bigger lever.** The system prompt changed length on 95.1% (proof) and 92.8% (September) of consecutive calls in a session. Under "head as logged" each compacting arm cost 7–13 times what it cost under a stable head (proof: current 12.8×, cliffs 11.3–12.4×; September: current 8.6×, cliffs 7.1–7.9×). Under that bound cost follows volume, so every cliff cost less than current: 3.4–7.5% less on the proof log, 1.8–6.3% less on September, and 15.2–22.0% less on the proof log at 256k. Those spreads are small next to the 7–13× gap between the two head bounds.
- **On the September log the cliff needs the live backstop.** It never masks reasoning, user turns, results of 500 characters or less, or the newest ten results. When what is left to mask cannot make room under the live trigger, the live pipeline compacts after it. On the September log at 128k that happened 266–282 times, against 348–666 cliff events. On the proof log it did so 2–3 times.

Not measured here: re-fetch rate, solve rate, latency, cache expiry, and the live message-cap trim (leaving it out flatters the cached share of current). Which head bound holds is read from `cache-hit-report.mjs` on a run made after 75167cd2. Several sessions can run under one chat id, so any per-chat reading of the log must separate them (`log-sessions.ts`). To reproduce: `node scripts/eval/compaction-replay.mjs --log <log> --cliff 32000:12000 --cliff 40000:12000 --cliff 48000:16000:8000 --cliff 64000:24000 [--context-window 256000]`.
