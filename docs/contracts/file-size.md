---
id: file-size
status: active
scope: "How long a TypeScript source file under src/ may grow. Tests, declarations and the web portal are outside it."
read_trigger: "Before adding code to a file near or over 1,000 lines (campaign-manager.ts, orchestrator.ts, learning-storage.ts, channel.ts, background-executor.ts and the other 59 in SIZE_BASELINE); when src/file-size-ratchet.test.ts names a file; before raising a SIZE_BASELINE line."
keywords: ["file size", "line count", "large file", "god class", "split", "extract module", "campaign-manager", "orchestrator", "ratchet", "SIZE_BASELINE", "dosya boyutu", "büyük sınıf"]
related: ["test-integrity"]
rules:
  [{"id": "no-file-grows-past-the-limit", "severity": "error", "text": "No source file under src/ grows past 1,000 lines, and a file already past it never grows; new code goes into a module beside it.", "detector": {"kind": "vitest", "file": "src/file-size-ratchet.test.ts"}}]
---
# File size: no file grows past the limit

The owner's first answer to "what keeps breaking" was the run loop: PAOR,
the supervisor and goal decomposition stopped carrying work forward. Every AI
that tried to fix them made them worse, until v1 was deleted and rewritten
(83270634). The cause the owner gave is classes thousands of lines long that
no reader can hold, and no AI either. The owner's review pain is the same:
adding a feature to a crowded class is hard to check (2026-11-04).

The numbers when this was written:

- 64 files under `src/` were over 1,000 lines, holding 122,605 lines, 41% of
  the source.
- `campaign-manager.ts` was 11,538 lines and had taken 308 commits since
  2026-09-01, because every feature lands there.
- Brain asks the game's worker to keep each file under 200 lines (the
  `[STRADA FILE TOO LONG]` gate), and carries 11,000-line files itself.

## Single producer

`src/file-size-ratchet.test.ts` holds the limit (`LIMIT`, 1,000 lines) and
the baseline of files already past it (`SIZE_BASELINE`). The commit layer,
`scripts/ci/check-test-integrity.mjs`, treats a raised or added
`SIZE_BASELINE` line as a loosened pin.

## Caller rules

- **When a change would grow a baselined file,** put the new code in a new
  module beside it, and keep only the call in the big file. If it has to sit
  inside the file, take out at least as many lines as you add, by extracting
  something the change touches anyway.
- **Extract along seams that already exist.** Choose a cluster of private
  methods with one caller, or a block that reads its own state. Do not cut
  the file in arbitrary halves.
- **Extraction is behaviour-preserving.** Make it a commit of its own: no
  feature in the same diff, and tests unchanged. Then any test that turns red
  is about the move.
- **Lower the baseline when you shrink a file.** When a baselined file shrinks
  by 100 lines or more (`SLACK`), lower its line in the same change, so that
  the room cannot quietly be filled again. Delete the line once the file is
  at or under the limit.

## Don't

- Grow a source file past 1,000 lines, or grow a file in SIZE_BASELINE at all. {#no-file-grows-past-the-limit}
- Raise or add a SIZE_BASELINE line without a `Test-Weakened:` line in the commit that says why the code cannot live elsewhere.
- Dodge the count by joining statements onto fewer lines. The point is code a reader can hold, not a number.
