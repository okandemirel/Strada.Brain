# src/utils/

Shared utilities for logging, process execution, and diff generation/formatting.

## Logger (`logger.ts`)

Singleton winston logger with console + file transports.

- `createLogger(level, logFile)` initializes the singleton; subsequent calls return the cached instance
- Console transport uses colorized `timestamp [level] message` format
- File transport rotates at 10 MB with 3 max files
- `defaultMeta` tags all entries with `service: "strata-brain"`
- `getLogger()` throws if called before `createLogger()`

## Process Runner (`process-runner.ts`)

Spawns child processes with output capture, timeout enforcement, and output truncation.

- `runProcess(opts: RunOptions): Promise<RunResult>` - used by shell-exec, git-tools, and dotnet-tools
- `DEFAULT_MAX_OUTPUT` = 16,384 characters; configurable via `opts.maxOutput`
- Output buffers are trimmed to `maxOutput` bytes from the tail when they exceed `2 * maxOutput`
- Timeout sends `SIGTERM`, then `SIGKILL` after 5 seconds if the process survives
- Timed-out processes return `exitCode: 124`; spawn errors return `exitCode: 127`
- stdin is set to `"ignore"`; stdout/stderr are piped

## Diff Generator (`diff-generator.ts`)

Creates unified diffs using the `diff` npm package (`createTwoFilesPatch`, `structuredPatch`).

- `generateFileDiff(oldPath, newPath, oldContent, newContent, options?)` returns a `FileDiff` with diff text, stats, and flags (`isNew`, `isDeleted`, `isRename`)
- `generateBatchDiff(files, options?)` diffs multiple files and aggregates stats into a `BatchDiff` with a summary string
- `calculateDiffStats(diff)` parses unified diff text, counting `additions`, `deletions`, `modifications` (min of adds/dels), `hunks`
- `truncateDiff(diff, maxLines?)` caps output at `DEFAULT_TRUNCATION_LINES` (100) with a `"... (N more lines truncated) ..."` trailer
- `generateInlineDiff(oldText, newText)` does simplified word-level diffing by splitting on whitespace
- `generateStructuredPatch()` wraps the `diff` library's `structuredPatch` with default context of 3 lines
- Options: `contextLines` (default 3), `ignoreWhitespace`, `ignoreCase`

## Diff Formatter (`diff-formatter.ts`)

Formats `FileDiff` / `BatchDiff` objects for different output channels.

- Three channel types: `telegram`, `whatsapp`, `cli`
- Per-channel limits control truncation:

| Channel | `maxLength` | `maxLines` | `batchMaxLines` |
|---------|-------------|------------|-----------------|
| telegram | 3500 | 50 | 30 |
| whatsapp | 1500 | 40 | 20 |
| cli | Infinity | 100 | 100 |

- Telegram formatter escapes MarkdownV2 special characters and wraps diffs in `` ```diff `` code blocks
- WhatsApp formatter uses plain code blocks; batch mode shows a compact file list with emoji prefixes and only the first file's diff if space permits
- CLI formatter applies ANSI color codes: green for additions, red for deletions, cyan for hunks/headers, gray for context
- `formatBatchDiffForChannel()` stops appending file diffs when cumulative length approaches `maxLength`
- `addLineNumbers(diff)` annotates hunk lines with 4-digit padded line numbers (non-CLI channels only)
- `formatCompactSummary()` produces a one-line stats string per channel

## Key Files

| File | Purpose |
|------|---------|
| `logger.ts` | Singleton winston logger with console + rotating file transports |
| `process-runner.ts` | Child process spawner with timeout, output capture, and truncation |
| `diff-generator.ts` | Unified diff generation, stats calculation, and batch diffing |
| `diff-formatter.ts` | Channel-aware diff formatting for Telegram, WhatsApp, and CLI |
