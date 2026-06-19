# Plan 027: Extract shared channel message-queue + streaming-buffer cores

> **Executor instructions**: Follow step by step. This refactor is behavior-
> preserving. Write the characterization tests in Step 1 BEFORE extracting. On any
> "STOP condition", stop and report. Update this plan's row in `plans/README.md`
> when done.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/channels/discord/bot.ts src/channels/slack/app.ts src/channels/teams/channel.ts`
> If changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: characterization tests for the touched channels (this plan writes them in Step 1 if absent; see plan 024 for the pattern)
- **Category**: tech-debt
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

The Discord and Slack adapters each hand-roll a message queue with retry,
exponential backoff, timeout eviction, and rate-limit handling — and they have
**diverged** (a bug fixed in one is not fixed in the other). A streaming-state
accumulator (`accumulatedText` + throttle timer) is independently reimplemented
across **6 channels**. Consolidating into two shared, tested cores removes the
divergence risk and makes the next channel cheap. Because the copies have drifted,
this is a *reconciliation*, not a copy-paste extraction — hence tests first.

## Current state

- **Discord queue** — `src/channels/discord/bot.ts`:
  - constants (lines 72–78): `MAX_RETRIES=3`, `RETRY_BASE_DELAY_MS=1000`, `QUEUE_PROCESS_INTERVAL_MS=100`, `RATE_LIMIT_BACKOFF_MS=5000`, `MESSAGE_TIMEOUT_MS=30000`.
  - `enqueueMessage` (329), `processMessageQueue` (344): **FIFO**, evicts timed-out msgs, batch of 5, retry via `setTimeout` re-push tracked in a `retryTimers` map, rejects on disconnect (lines 390–401).
- **Slack queue** — `src/channels/slack/app.ts`:
  - `enqueueMessage` (300): **priority-ordered insert** (line 322).
  - `processMessageQueue` (331): iterates a snapshot, **skips backed-off heads** (head-of-line-blocking avoidance, lines 348–354), retry via a `retryAfter` timestamp **+ jitter** (lines 376–382).
  - → **Divergence**: Slack has priority + jitter + HOL-avoidance; Discord has FIFO + retryTimers + disconnect-reject. The shared core must support both via options.
- **Streaming state** — duplicated; e.g. Discord `StreamingMessageState` (`bot.ts:44–53`): `accumulatedText`, `lastUpdate`, `updateQueued`, `throttleTimer`, `finalized`. Markers (`accumulatedText`/`throttleTimer`) also appear in `src/channels/{slack,telegram,whatsapp,web,cli}/…` and the shared `src/channels/channel-core.interface.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Channel tests | `npx vitest run src/channels/discord/bot.test.ts src/channels/slack/app.test.ts` | all pass |
| New core tests | `npx vitest run src/channels/message-queue.test.ts src/channels/streaming-buffer.test.ts` | all pass |

## Scope

**In scope**:
- New: `src/channels/message-queue.ts` (+ `.test.ts`), `src/channels/streaming-buffer.ts` (+ `.test.ts`)
- `src/channels/discord/bot.ts`, `src/channels/slack/app.ts` (delegate to the cores)
- Streaming: migrate Discord + one more channel (Teams or WhatsApp) as proof; leave the rest for a follow-up listed in the index.

**Out of scope** (do NOT touch):
- Delivery semantics / rate-limit thresholds — must be byte-for-byte preserved per channel (the shared core takes them as options).
- Channels beyond the two queues + two streaming migrations named above (avoid a big-bang; follow-up plan migrates the rest).
- The `discord.js` / `@slack/bolt` versions.

## Git workflow

- Branch: `refactor/027-channel-cores`
- Commits: `test(channels): characterize discord+slack queues` → `refactor(channels): extract MessageQueue core` → `refactor(channels): extract StreamingBuffer core`.

## Steps

### Step 1: Characterization tests FIRST

If `discord/bot.test.ts` / `slack/app.test.ts` lack queue coverage, add tests
capturing today's behavior: enqueue→process order (FIFO for Discord, priority for
Slack), retry/backoff on a failing send, timeout eviction (Discord), HOL-skip
(Slack), disconnect rejection (Discord). These are the regression guard.

**Verify**: `npx vitest run src/channels/discord/bot.test.ts src/channels/slack/app.test.ts` → pass.

### Step 2: Extract `MessageQueue<T>`

Create a generic `MessageQueue<T>` parameterized by options that cover BOTH
strategies: `{ maxRetries, baseDelayMs, maxDelayMs?, batchSize, timeoutMs?, ordering: 'fifo'|'priority', jitter?: boolean, skipBackedOff?: boolean, onSend: (item)=>Promise<void>, isRateLimitError, extractRetryAfter, onDisconnectReject?: ()=>boolean }`. It owns enqueue, the process loop, retry/backoff, timeout eviction. Channels supply the send callback + their option set.

### Step 3: Delegate Discord + Slack to the core

Replace each channel's bespoke queue with a `MessageQueue` instance configured to
reproduce its exact current behavior (Discord: fifo + timeout + disconnect-reject;
Slack: priority + jitter + skipBackedOff). Keep the channels' public send methods
unchanged.

**Verify**: Step 1 tests still pass unchanged; `npm run typecheck:src` + `npm run lint:src` → 0.

### Step 4: Extract `StreamingBuffer`

Create `StreamingBuffer` owning `accumulatedText`, throttle timer, `updateQueued`,
`finalized`, and cleanup-on-disconnect. Migrate Discord + one more channel to it;
plug channel-specific format/flush callbacks. Add `streaming-buffer.test.ts`
covering: accumulate→throttled flush, finalize cannot be overwritten by a late
throttled update, timer cleared on disconnect.

**Verify**: new core tests pass; migrated channels' tests pass.

## Test plan

- New: `message-queue.test.ts` (fifo + priority + retry/backoff + timeout + HOL-skip + disconnect-reject), `streaming-buffer.test.ts` (accumulate/throttle/finalize/cleanup).
- Existing Discord/Slack tests must pass **unchanged** after delegation — that is the behavior-preservation proof.

## Done criteria

ALL must hold:

- [ ] `message-queue.ts` + `streaming-buffer.ts` exist with passing tests
- [ ] Discord + Slack delegate to `MessageQueue`; their pre-existing tests pass unmodified
- [ ] Discord + one other channel use `StreamingBuffer`
- [ ] `npm run typecheck:src` + `npm run lint:src` exit 0; channel test suites green
- [ ] Net line reduction in `discord/bot.ts` + `slack/app.ts` (`git diff --stat`)
- [ ] `plans/README.md` row updated, with remaining streaming migrations listed as a follow-up

## STOP conditions

- Reproducing a channel's exact behavior through the shared options is not possible without changing delivery semantics — STOP; report the mismatch (the divergence may encode an intentional per-channel decision).
- A characterization test in Step 1 fails to capture current behavior deterministically (real timers/network) — stabilize with fake timers; if impossible, report.
- The extraction forces a change to a channel's public interface — out of scope; STOP.

## Maintenance notes

- After this, fix queue/streaming bugs once in the core; never re-fork per channel.
- Follow-up (separate plan): migrate the remaining streaming channels (telegram/whatsapp/web/cli) to `StreamingBuffer`.
- Reviewer should diff each channel's behavior via the unchanged characterization tests, not by reading the new core in isolation.
