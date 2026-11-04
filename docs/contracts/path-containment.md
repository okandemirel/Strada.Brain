---
id: path-containment
status: active
scope: "Deciding whether a path lies inside a root directory: a project, a workspace lease, a vault, an install root, an upload or download directory."
read_trigger: "Before writing any check of the form 'is X inside / under / within Y'; before comparing a realpath with a configured or user-typed path; when something is reported 'outside the project' that is not."
keywords: ["path", "containment", "inside", "within", "under", "traversal", "startsWith", "relative", "realpath", "symlink", "/private/var", "8.3 short name", "sec-H2"]
related: []
single_producer: {"file": "src/common/path-containment.ts", "exports": ["isAtOrInside", "isStrictlyInside"]}
rules:
  [{"id": "no-hand-rolled-containment", "severity": "error", "text": "Never hand-roll a containment check; call isAtOrInside or isStrictlyInside from src/common/path-containment.ts.", "detector": {"kind": "vitest", "file": "src/path-containment-ratchet.test.ts"}}]
---
# Path containment

When this contract was written (2026-11-04) the question "is this path inside
that root?" was answered by hand on 62 lines in 42 files, in five different
shapes, and the copies disagreed with each other:

- string prefix (`candidate.startsWith(root + sep)`) against `path.relative()`;
- `relative(...).startsWith("..")`, which calls a child named `..cache` an escape;
- the root itself counted as inside by some copies and outside by others;
- `root + sep` that broke on a filesystem root (`"/" + sep` is `"//"`);
- one copy with its arguments reversed, `(candidate, root)`.

It has failed in the same way more than once. A path that is reached through a
symlink has two spellings: macOS temp directories are `/var` → `/private/var`,
and Windows CI home directories have 8.3 short names (`C:\Users\RUNNER~1`). A
check that compared one real spelling with one typed spelling judged the
project's own files "outside the project". This happened in the vault registry
(74db22a1) and in the path guard (5fb0d54c). Then on 2026-11-04 it was found a
third time, in a copy that had been written as a "mirror of file-read.ts".
`vault_search` kept comparing the typed spelling after file-read moved to the
real one, so a project reached through a symlink lost its own knowledge vault.

## Single producer

`src/common/path-containment.ts` answers this question for the whole repo:

- `isAtOrInside(root, candidate)`: the root itself counts.
- `isStrictlyInside(root, candidate)`: the root itself does not count.

Both are lexical and segment-based, and both use the platform's own path rules.
To test Windows behaviour on any host, pass `path.win32` as the third argument.

The first six copies moved to the producer in the same change. The remaining
56 lines in 38 files are held by the ratchet in
`src/path-containment-ratchet.test.ts`.

## Caller rules

- Bring both sides into the same spelling before you ask. Either realpath both
  or realpath neither. If the answer must match what `validatePath` hands the
  file tools, use `canonicalVaultPath` (the native realpath). Comparing one
  real path with one typed path is the defect.
- Choose between at-or-inside and strictly-inside on purpose. A file the
  producer names must be strictly inside the project. A configured directory
  may be the root itself.
- Test with a symlinked root as well as a plain one. A plain temp-dir fixture
  passes on Linux and hides the macOS and Windows failures.
- When you touch a file that is in the ratchet's `BASELINE`
  (`src/path-containment-ratchet.test.ts`), move its check to the producer and
  lower its count in the same change.

## Don't

- Hand-roll a containment check in any shape: `startsWith(root + sep)`, `relative(...).startsWith("..")`, `rel !== ".." && …`, `endsWith(sep) ? root : root + sep`, or a new one. {#no-hand-rolled-containment}
- Copy ("mirror") a check from another file instead of importing it. A copy never receives the original's fixes.
- Read a passing test as proof when its fixture root has only one spelling.
