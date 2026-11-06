---
id: clean-checkout
status: active
scope: "What a test run may leave in the checkout it runs from: no runtime entry (.strada, .strada-memory, .strada-update.lock, any name starting .strada) at the checkout's root, whether it came through the working directory a relative default resolves against or the install root a vault or lock is built from."
read_trigger: "Before a test builds a config, store, vault or lock from defaults or from an environment it makes by hand; before a test resolves a runtime path against process.cwd() or the repository root; when vitest.worker-setup.ts fails a file with 'left … in the checkout it runs from'."
keywords: ["checkout", "working directory", "process.cwd", "relative default", ".strada-memory", ".strada", "vault", "install root", "MODEL_INTELLIGENCE_DB_PATH", "gitignored", "worker setup", "test pollution", "hermetic", "çalışma dizini"]
related: ["test-integrity"]
single_producer: {"file": "src/common/runtime-paths.ts", "exports": ["resolveRuntimePaths", "resolveStradaHome"]}
rules:
  [{"id": "no-runtime-entry-in-checkout", "severity": "error", "text": "A test file leaves no new .strada… entry in the checkout it runs from; every runtime path it opens lies in its own temp folder or the worker's home.", "detector": {"kind": "vitest", "file": "src/tests/clean-checkout.test.ts"}}]
---
# Clean checkout: a test run leaves no runtime state in the repository

Under vitest the checkout is two things at once. It is the working directory,
which a relative default such as `.strada-memory/model-intelligence.db`
resolves against. It is also the install root, which a vault or a lock is
built from (`<root>/.strada/vault`, `<root>/.strada/runtime.lock`). A test
that reaches either one writes runtime state into the repository. The
`.gitignore` hides every such entry, so `git status` stays clean and every
assertion stays green.

It happened twice:

- **2026-10-11.** Tests opened `<repo>/.strada-memory/*.db`. The workers
  stood in the checkout, and the databases defaulted to relative paths
  (fixed in 3d1531cb by pointing them at each worker's home).
- **2026-11-05.** The golden run wrote `model-intelligence.db`,
  `dynamic-profiles.db` and a 9 MB `.strada/vault/index.db` there
  (a474355c). It handed `loadConfig` an environment built by hand, which the
  worker setup's paths never reached, and it let the framework vault index
  the repository.

Both times a reviewer found it by listing ignored files by hand.

## Single producer

- **Where runtime state goes:** `resolveRuntimePaths` and
  `resolveStradaHome` in `src/common/runtime-paths.ts`. Under vitest,
  `vitest.global-setup.ts` points the config root and `STRADA_HOME` at the
  run's temp root. `vitest.worker-setup.ts` gives each worker its own home and
  points `MEMORY_DB_PATH` and `MODEL_INTELLIGENCE_DB_PATH` inside it.
- **The check:** `vitest.worker-setup.ts` lists the runtime entries in the
  checkout before each test file and again when the file ends, with
  `runtimeEntriesIn` and `newRuntimeEntries` from
  `src/tests/helpers/checkout-runtime-entries.ts`. A file that ends with a new
  one fails, naming each path. It lists both the working directory and the
  repository root; under vitest they are one directory.

## Caller rules

- **A test that builds its own environment gives its own paths.** A
  `loadConfig({...})` with a hand-made env does not see the worker setup's
  database paths. Pass `MEMORY_DB_PATH` and `MODEL_INTELLIGENCE_DB_PATH`
  inside the test's temp folder.
- **A test that boots the runtime indexes no tree outside its folder.** Turn
  off the self vault and give `frameworkVaultTargets` nothing, as the golden
  run does.
- **When the check names a file, run that file alone first**
  (`npx vitest run <file>`). Files in other workers share the checkout, so a
  file that ran at the same time can be named too. The file that wrote the
  entry is named as well, unless the write landed after its own check (see
  below).
- **Fix the path, then delete the entry.** An entry that is already there
  when a file starts is not new, and the check cannot see a file write to it.

## Don't

- Leave a new `.strada…` entry in the checkout from a test file. {#no-runtime-entry-in-checkout}
- Write into the checkout and remove it in your own `afterAll`. The check
  passes your file, but a file in another worker that ends in between is
  blamed for it.
- Run again without deleting the entry to see whether the message is gone.
  The entry is already there on the second run, so the second run passes
  without the fix.

## What it cannot see

- **An entry already there when the file starts.** This covers a live
  daemon's own state in its checkout, and a leak an earlier run left
  behind. CI's checkout is fresh, so there nothing is already there.
- **A write to a path that is not new.** A file that reopens a database that
  is already there is not caught.
- **A write that lands after the check.** Each test file runs in its own
  process, so a background task the file did not stop dies with it. A write
  it makes between the check and the exit is blamed on the next file to end,
  in any worker.
- **Which of several files running at the same time wrote the entry.**
- **Anything else in the checkout.** Only the `.strada…` entries at its root
  are listed, not `src/` or `docs/`.

## Calibration

Measured on 2026-11-06 against the whole suite (28 batches, 1,108 test
files, about 18,000 tests) in a fresh worktree: 0 findings, so the rule gates
with no baseline. The same run also listed every new entry of any name at the
checkout's root, to see whether the runtime leaves something not called
`.strada…`: there was none. Five tests in three files failed for an unrelated
reason, a missing `dist/`.
