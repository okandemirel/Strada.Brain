# Plan 013: Extract shared text-chunking/formatting helpers from the Discord and Slack formatters

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat aea95ad..HEAD -- src/channels/discord/formatters.ts src/channels/discord/formatters.test.ts src/channels/slack/formatters.ts src/channels/slack/__tests__/formatters.test.ts src/common`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (user-visible message rendering on two channels)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`src/channels/discord/formatters.ts` (271 lines) and `src/channels/slack/formatters.ts` (380 lines) independently implement the same algorithmic core — boundary-aware splitting of long text (paragraph → line → sentence → space → hard cut), code-block fencing, line-prefixed quoting, and `<@id>`/`<#id>` mention building. Bugs fixed in one copy (e.g. a split that cuts inside a code fence) don't reach the other, and a future Teams/Matrix formatter would become a third copy. This plan extracts ONLY the genuinely shared core into `src/common/`; the markdown dialect converters (`formatToDiscordMarkdown` vs `formatToSlackMrkdwn`) are real platform differences and stay channel-local — full unification is explicitly NOT the goal.

## Current state

- `src/channels/discord/formatters.ts` — limits 2000/4096 chars.
  - `splitMessage` (lines 112-162): boundary-aware chunking — paragraph break if `> maxLength*0.5`, else newline if `> *0.7`, else `". "` if `> *0.8`, else space if `> *0.8`, else hard cut; trims chunks.
  - `truncateForDiscord` (83-96): plain substring + `"..."` (NOT boundary-aware).
  - `formatCodeBlock` (168-175): ` ```lang\n<code-trimmed>\n``` `.
  - `formatQuote` (259-264): prefixes each line with `"> "`; `formatMultiLineQuote` (269-271): `">>> "`.
  - `formatUserMention` (198-200): `"<@id>"`; `formatChannelMention` (206-208): `"<#id>"`; plus Discord-only `formatRoleMention`, `formatSpoiler`, `formatTimestamp`, `escapeDiscordMarkdown`, `formatToDiscordMarkdown` (13-77).
  - Tests: `src/channels/discord/formatters.test.ts` (exists).
  - External usage: `src/channels/discord/bot.ts:29` imports only `formatToDiscordMarkdown, truncateForDiscord`. `splitMessage` has no callers outside the formatter/test (verified by grep) — extraction still proceeds (it is exported API used by tests), but do not invent new callers.
- `src/channels/slack/formatters.ts` — limits 40000/3000 chars.
  - `chunkText` (231-258, private): boundary-aware chunking — paragraph/newline/`". "` each gated at `> maxChunkSize*0.5`, else hard cut; trims the REMAINDER only (not the chunk), unlike Discord.
  - `truncateForSlack` (68-89): boundary-aware truncation (paragraph/newline/space gated at `*0.8`) + `"\n\n...(truncated)"` marker.
  - `formatCodeBlock` (124-133): escapes inner ``` and wraps with SURROUNDING newlines — different output shape from Discord's.
  - `formatQuote` (299-304): prefixes `">"` AND HTML-escapes each line (`escapeSlackText`).
  - `formatUserMention` (275-277): `"<@id>"`; `formatChannelMention` (282-284): `"<#id>"` — byte-identical output to Discord's.
  - Slack-only: `formatToSlackMrkdwn` (15-63), `splitIntoBlocks`, `formatDiff` (KnownBlock-typed), `escapeSlackText`, `stripFormatting`, `formatList`, `formatLink`, `formatErrorMessage`, `formatSuccessMessage`, `containsCodeBlock`, `extractCodeBlocks`, `formatFileSize`, `formatDuration`, `formatFilePath` (path-middle-elision — differs from Discord's escape-and-wrap version).
  - Tests: `src/channels/slack/__tests__/formatters.test.ts` (exists).
  - External usage: `src/channels/slack/app.ts:22` imports `formatToSlackMrkdwn, truncateForSlack`; `src/channels/slack/index.ts:25-45` re-exports several formatter symbols (keep those re-exports working).
- Telegram (`src/channels/telegram/bot.ts`) and WhatsApp (`src/channels/whatsapp/client.ts`) were checked: no truncate/split/chunk helpers of this family exist there (diff formatting for those channels lives in `src/utils/diff-formatter.ts` — different subsystem, out of scope).
- `src/common/` conventions: flat modules with colocated tests (`lru-cache.ts`, `fetch-with-retry.ts` + `fetch-with-retry.test.ts`, `web-static-dir.ts` + test); `src/common/index.ts` is a barrel exporting constants/errors. Before wiring, check whether `index.ts` re-exports `lru-cache`/`fetch-with-retry`; mirror whatever it does for the new module (if they are not in the barrel, import the new module by direct path too).
- Rate limiters — assessed and explicitly NOT unified: `src/channels/discord/rate-limiter.ts` (298 lines) is a token-bucket + single FIFO queue with error-driven cooldown; `src/channels/slack/rate-limiter.ts` (435 lines) is a 4-tier sliding-window request-history model with per-tier queues and acquisition timeouts. The shared surface is only `acquire()`/`delay()` plumbing (~20 lines); the models, state, and failure semantics genuinely differ, and both files carry explicit "intentionally separate … should not be consolidated" header notes (w.r.t. `src/security/rate-limiter.ts`). Not worth unifying — scoped out.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Discord tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/discord/formatters.test.ts` | all pass |
| Slack tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/slack/__tests__/formatters.test.ts` | all pass |
| New common tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/common/text-formatting.test.ts` | all pass |
| Both channels' suites | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/discord src/channels/slack` | all pass |
| Lint | `npm run lint:src` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/common/text-formatting.ts` (create) + `src/common/text-formatting.test.ts` (create)
- `src/common/index.ts` (only if the barrel-export check says the convention is to barrel)
- `src/channels/discord/formatters.ts`, `src/channels/discord/formatters.test.ts`
- `src/channels/slack/formatters.ts`, `src/channels/slack/__tests__/formatters.test.ts`

**Out of scope** (do NOT touch):
- `src/channels/discord/rate-limiter.ts`, `src/channels/slack/rate-limiter.ts` — assessed above; not worth unifying.
- `formatToDiscordMarkdown` / `formatToSlackMrkdwn` internals — platform dialects stay channel-local.
- `src/channels/discord/bot.ts`, `src/channels/slack/app.ts`, `src/channels/slack/index.ts` — the public formatter APIs (names, signatures, outputs) must not change, so callers need no edits.
- `src/utils/diff-formatter.ts` and telegram/whatsapp channels.
- Deleting unused-looking exports (e.g. discord `splitMessage`) — usage cleanup is a separate decision.

## Git workflow

- Branch: `advisor/013-shared-channel-formatting`
- Conventional commits, e.g. `test(channels): characterize formatter outputs` → `feat(common): add shared text-formatting helpers` → `refactor(channels): re-point discord/slack formatters to shared helpers`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterization tests pinning CURRENT outputs (commit first)

Extend BOTH existing formatter test files with a `describe("characterization (plan 013)")` block. For each case, generate expectations by running the current code once and pasting exact outputs (do not hand-write expected strings). Golden cases, exercised through both channels' public functions:

- Oversized plain text: 5000 chars of repeated paragraphs → `splitMessage` (discord, default 2000) chunk count + first/last chars of each chunk; `truncateForSlack` output tail (must end with `...(truncated)`); `truncateForDiscord(…, 100)` exact output.
- Boundary preference: text with a paragraph break at 60% of maxLength → discord `splitMessage` splits at the paragraph; slack `chunkText` via `splitIntoBlocks` on >3000-char input.
- Nested/odd code blocks: input containing ` ``` ` inside a code block → `formatCodeBlock` output for both (slack escapes inner fences, discord does not — pin both behaviors).
- Unicode: a 300-char string of multi-byte chars (e.g. `"ğüşİö🦉"` repeated) through `truncateForDiscord(…, 100)` and `truncateForSlack(…, 100)` — pin current (length-based, possibly surrogate-splitting) behavior; do NOT fix it here.
- Quotes: multi-line text with `<`, `&` through discord `formatQuote` (no escaping) and slack `formatQuote` (escapes) — pin the difference.
- Mentions: `formatUserMention("U123")` / `formatChannelMention("C9")` identical for both modules.

**Verify**: both formatter suites pass against UNCHANGED code; commit.

### Step 2: Create src/common/text-formatting.ts

New module with colocated test, no channel imports, no external deps. Contents (behavior-parameterized so each channel keeps byte-identical output):

```ts
export interface SplitOptions {
  /** Gate ratios per boundary type; a boundary is used only if found past ratio*maxLength. */
  readonly paragraphRatio: number;   // discord 0.5, slack 0.5
  readonly newlineRatio: number;     // discord 0.7, slack 0.5
  readonly sentenceRatio: number;    // discord 0.8, slack 0.5
  readonly spaceRatio?: number;      // discord 0.8, slack: undefined (no space boundary)
  readonly trimChunks: boolean;      // discord true, slack false (slack trims remainder only)
}
export function splitAtBoundaries(text: string, maxLength: number, opts: SplitOptions): string[];

export interface TruncateOptions {
  readonly marker: string;                       // discord "...", slack "\n\n...(truncated)"
  readonly boundaries?: ReadonlyArray<"paragraph" | "newline" | "space">; // slack uses all three at 0.8; discord: undefined (plain substring)
  readonly boundaryRatio?: number;               // slack 0.8
}
export function truncateText(text: string, maxLength: number, opts: TruncateOptions): string;

export function fenceCodeBlock(code: string, language?: string, opts?: {
  readonly escapeInnerFences?: boolean;          // slack true, discord false
  readonly surroundingNewlines?: boolean;        // slack true, discord false
  readonly trimCode?: boolean;                   // discord true, slack false
}): string;

export function prefixLines(text: string, prefix: string, transform?: (line: string) => string): string; // quotes: discord ("> "), slack (">", escapeSlackText)
export function formatUserMention(userId: string): string;     // "<@id>"
export function formatChannelMention(channelId: string): string; // "<#id>"
```

Implementation detail that matters: replicate each channel's exact boundary semantics — Discord's `splitMessage` computes marker positions with `lastIndexOf(boundary, maxLength)` and compares against ratio thresholds (`> maxLength * ratio`), Discord truncate subtracts marker length from the budget (`maxLength - ellipsis.length`) while Slack's default budget already excludes the marker at the call-site default (`MAX_SLACK_MESSAGE_LENGTH - TRUNCATION_MARKER.length`). Port the two originals side-by-side and unify only where the logic is literally the same shape; where a semantic genuinely differs and can't be expressed by the options above, STOP (see conditions) rather than approximating.

Check `src/common/index.ts`: if `lru-cache`/`fetch-with-retry` are re-exported there, add `text-formatting` exports; otherwise leave the barrel alone.

**Verify**: `npm run typecheck:src` → exit 0; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/common/text-formatting.test.ts` → all pass (see Test plan).

### Step 3: Re-point Discord formatters

In `src/channels/discord/formatters.ts`, reimplement `splitMessage`, `truncateForDiscord`, `truncateForEmbedDescription`, `formatCodeBlock`, `formatQuote`, `formatUserMention`, `formatChannelMention` as thin wrappers over the shared module with Discord's option values. Keep every export name and signature identical. `formatToDiscordMarkdown`, `escapeDiscordMarkdown`, `formatRoleMention`, `formatSpoiler`, `formatTimestamp`, `formatInlineCode`, `formatFilePath`, `formatDiff`, `formatMultiLineQuote` stay local (note: `formatDiff` and `formatFilePath` call local `formatCodeBlock`/`formatInlineCode` — they keep working through the wrappers).

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/discord` → ALL pass, including the Step-1 characterization unchanged (this is the no-behavior-change proof).

### Step 4: Re-point Slack formatters

Same treatment in `src/channels/slack/formatters.ts`: `chunkText` (→ `splitAtBoundaries` with Slack options), `truncateForSlack` (→ `truncateText`), `formatCodeBlock` (→ `fenceCodeBlock` with Slack options), `formatQuote` (→ `prefixLines(text, ">", escapeSlackText)`), `formatUserMention`/`formatChannelMention` (→ shared). Everything else stays local. `src/channels/slack/index.ts` re-exports must keep resolving (they will, since export names are unchanged).

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/slack` → ALL pass, characterization unchanged.

### Step 5: Full gate

**Verify**: `npm run typecheck:src` → exit 0; `npm run lint:src` → exit 0; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/discord src/channels/slack src/common/text-formatting.test.ts` → all pass.

## Test plan

- Step 1: characterization cases listed above, in BOTH existing formatter test files (model on their existing style).
- `src/common/text-formatting.test.ts` (new; model structure on `src/common/fetch-with-retry.test.ts`):
  - `splitAtBoundaries`: under-limit passthrough; paragraph-preferred split; newline fallback; sentence fallback; hard cut with no boundaries; `trimChunks` true vs false producing different whitespace; empty string → `[""]`-or-`[]` matching the ported original (pin whichever the original does).
  - `truncateText`: no-op under limit; marker appended over limit; boundary-aware vs plain modes; marker length accounting (result length ≤ maxLength for the Discord-style budget mode).
  - `fenceCodeBlock`: all 3 option toggles; inner-fence escaping.
  - `prefixLines`: with and without transform; preserves trailing empty lines exactly as the originals do.
  - Mentions: exact `<@id>` / `<#id>` strings.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/common/text-formatting.ts` and its test exist; `npx vitest run src/common/text-formatting.test.ts` passes
- [ ] All Step-1 characterization expectations pass UNMODIFIED after Steps 3-4 (zero output drift)
- [ ] `grep -n "from \"../../common/text-formatting" src/channels/discord/formatters.ts src/channels/slack/formatters.ts` → 1 match in each
- [ ] `npm run typecheck:src` and `npm run lint:src` exit 0
- [ ] `npx vitest run src/channels/discord src/channels/slack` (with `NODE_OPTIONS=--max-old-space-size=8192`) exits 0
- [ ] `src/channels/discord/rate-limiter.ts` and `src/channels/slack/rate-limiter.ts` are untouched (`git status`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any Step-1 characterization expectation needs MODIFYING to make Step 3 or 4 pass — that is behavior drift, the one thing this plan forbids.
- The two originals' boundary semantics turn out not to be expressible via the `SplitOptions`/`TruncateOptions` surface without per-channel `if`s inside the shared module — report the irreducible difference instead of adding channel flags like `isSlack`.
- The live formatter files differ from the line-referenced excerpts (drift since `aea95ad`).
- `src/channels/slack/index.ts` re-export list references a symbol you were about to change the signature of.

## Maintenance notes

- Future Teams/Matrix/IRC rich formatters should build on `src/common/text-formatting.ts` instead of copying; reviewer should check no NEW divergence was introduced in the wrappers (each wrapper should be ≤5 lines).
- The unicode characterization pins current surrogate-unsafe length-based truncation; fixing that (code-point-aware truncation) is a deliberate follow-up — change it in ONE place (the shared module) when prioritized, updating both channels at once. That payoff is the point of this extraction.
- Deferred explicitly: rate-limiter unification (models genuinely differ — token bucket vs tiered history; both carry "do not consolidate" notes), deleting unused formatter exports, telegram/whatsapp adoption.
