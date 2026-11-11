---
id: log-issues-are-judged-by-millisecond
kind: decision
tier: 1
status: active
topics: ["agent-loop", "evidence", "providers"]
paths: ["src/agents/autonomy/completion-review.ts", "src/utils/logger.ts"]
purpose: "Stop the completion review's log-issue verdict from moving with the clock, and stop a provider drop that the run already recovered from from asking for a targeted repro."
summary: "Ring-buffer entries carry an epoch-millisecond timestampMs that completion review compares with its cutoff; a provider-drop line that a later successful step answered is not an open failing path, while one with no success after it still is"
decided_on: 2026-11-11
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
`collectCompletionReviewEvidence` keeps the warn/error log lines logged after its cutoff, which is the task start or the last verification, in milliseconds. It read each line's time from the ring buffer's string timestamp, which is the file format `YYYY-MM-DD HH:mm:ss` and floors to the second. A line in the cutoff's second therefore fell "before" the cutoff, and the same line one second later fell "after" it.

The golden recovery run drops two provider calls (`Silent stream error`, `Silent stream fallback chat failed`), and the next turn then writes the file. On a fast machine both lines landed in the task's first second and were ignored. With 1.2 s or more per provider call (measured 2026-11-11), they landed a second later and the verifier asked for a targeted repro on every run. The verdict depended on the clock, not on the run.

## Decision
- The logger stamps every call with `Date.now()` on a symbol key, before the timestamp format runs. The ring buffer stores it as `LogEntry.timestampMs`. File and console lines are unchanged.
- Completion review compares `timestampMs` with the cutoff. It reads the string only for an entry that has no stamp.
- A provider-drop line counts as answered once a step succeeded after it: the provider answered again, and the failure ledger has already told the next turn about the drop. Answered lines leave `recentLogIssues`. A drop with no success after it, and any other warn/error line, still counts. This has the same shape as `refusalRetriedOk`.

This keeps the behaviour that the golden run already pinned ("completed on its first attempt, nothing blocked"); it does not choose a new one. Before the fix, that behaviour held only when the drop shared a second with the task start. `completion-review.test.ts` pins the cutoff 1 ms either side and both drop directions, and golden recovery pins the end-to-end path at any speed.

## Rejected alternatives
- **Add the epoch milliseconds to the file line.** `scripts/eval/cache-hit-report.mjs` and compaction-replay parse those lines by their date (`--since 'YYYY-MM-DD HH:mm:ss'`). Changing every reader to fix one in-memory comparison is the wrong trade.
- **Floor the cutoff to its second.** That lets in an old error from the cutoff's own second, logged before the verification that cleared it. Rounding the cutoff up instead loses a real error logged in that second after the cutoff. Both directions are wrong by up to 999 ms.
- **Ignore every provider-drop line.** That hides a drop that nothing recovered from, where the answer under review may rest on a turn that never came back.
- **Treat every drop as an open failing path.** A 503 leaves no failing path in the project to reproduce, and the golden run pins that a recovered drop does not block.

## Consequences
The drop vocabulary is the orchestrator's message text, kept as a set in `completion-review.ts`. If those messages are renamed, the drop lines count again; the change fails safe, and golden recovery goes red. Should the vocabulary grow, a structured field on the log meta would be better than more message names.
