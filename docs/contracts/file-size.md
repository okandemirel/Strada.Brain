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
`scripts/ci/check-test-integrity.mjs`, reads that baseline from the base
commit. It treats a raised or added `SIZE_BASELINE` line as a loosened pin,
and it holds the growth that the baseline cannot see.

## What the detectors see

- **The tree** (`src/file-size-ratchet.test.ts`, in `npm test` and the gates'
  contract detectors) fails in three cases. The first is a file over 1,000
  lines that is not in `SIZE_BASELINE`. The second is a baselined file longer
  than its line. The third is a baselined file 100 lines (`SLACK`) or more
  under its line.
- **The range** (`check-test-integrity.mjs`, in the gates' "test integrity",
  the pre-push hook and CI) fails on a file in the base's `SIZE_BASELINE`
  that is longer at the head than at the base, even while it is still under
  its line. The base is where the range left main
  (`git merge-base <base> <head>`). The count is net over the range: an
  extraction commit followed by a commit that adds back as many lines is not
  growth. The growth passes only when a commit in the range that changes the
  file carries a `Test-Weakened:` line. The same detector also judges a
  raised or added `SIZE_BASELINE` line.

## What they do not see

- **Growth under the line, seen by the tree alone.** A line may sit up to
  `SLACK` lines above its file. On 2026-11-11, 5 of the 64 files had 84 lines
  of room between them. In #31, `orchestrator-session-manager.ts` went from
  1631 to 1633 lines under its line of 1650, and the tree check stayed green.
  Only the range check catches this. A run of the vitest file on its own
  (`npm test`, `vitest related`) does not.
- **A branch pushed in pieces.** The range is one push. If an extraction is
  pushed first and the addition later, the second push is judged on its own
  and fails. This makes the check stricter, not blind. Push the extraction
  and the addition together.
- **A renamed or moved baselined file.** It is missing at one end of the
  range, so the range check does not compare it. The tree check sees it, as a
  file over the limit that is not in the baseline.
- **`workflow_dispatch` CI runs.** They skip the integrity step.
- **Lines joined to cut the count.** No counter sees this (see Don't).

## Why the range, not a lower baseline

The other way was to lower every line to the file's current length and drop
`SLACK`. Then every commit that shrinks a baselined file would also have to
edit `SIZE_BASELINE`. In the 50 commits before 2026-11-11, 18 touched a
baselined file: 6 shrank one and 6 grew one under its line. Parallel workers
would all edit the same block of one file, which means conflicts and a shared
scope lock. Measuring each file against itself across the range keeps that
file untouched, at the cost of a change to the gate's code. The gate's code
is governed, and it is judged from the base commit.

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
