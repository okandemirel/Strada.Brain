# Plan 006: Add characterization + unit tests for the vault subsystem (src/vault/)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/vault/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`src/vault/` contains 26 non-test TypeScript source files (verified: `find src/vault -name "*.ts" | grep -v test | wc -l` → 26, including the 6 files in `src/vault/symbol-extractor/`) but only ONE test file (`src/vault/symbol-summarizer.test.ts`, 63 lines). The vault subsystem mutates user files on disk, owns a SQLite database per vault, enforces path-traversal/symlink security boundaries, and is high-churn (multiple hardening rounds in April–May 2026). Any regression in the path policy is a security hole; any regression in the reindex/sync logic silently corrupts the index. These tests pin the current (audited, hardened) behavior so future refactors can't quietly undo it.

## Current state

Relevant files (all under `/Users/okanunico/Documents/Strada/Strada.Brain`):

- `src/vault/path-policy.ts` (332 lines) — ALL path safety: `resolveSafeVaultReadPath` (line 214), `prepareSafeVaultWritePath` (line 248), `validateSafeVaultWriteRelPath` (line 65), `getIndexableFileInfo` (line 74), `hasSymlinkAncestor` (line 133), `isLikelyBinaryFile` (line 175), `resolveExistingVaultRoot` (line 269), `isVaultRootAllowed` (line 301). **No tests exist for this file anywhere in the repo** (verified: `grep -rn "path-policy" src --include="*.test.ts"` → no matches). Note: `src/security/path-guard.test.ts` tests a DIFFERENT module.
- `src/vault/obsidian-vault.ts` (803 lines) — `ObsidianVault`. `AsyncLock` class at lines 85–108 (FIFO lock + re-entrancy guard). `sync()` at 238–259 runs under `this.writeLock.run(...)`. `readFile` at 348–351 goes through `resolveSafeVaultReadPath`. `writeFile` at 353–364 tries the Obsidian REST API first and **falls back to a plain FS write** (NOT temp+rename). The temp+rename atomic write lives in `regenerateCanvasWithStatus()` at 688–729 (validate JSON → write `.tmp` → `fsp.rename`; on rename failure, unlink the `.tmp`). `query()` at 268+ throws `VaultQueryError` (exported, lines 41–48) for whitespace-only queries. `redactPathsInMessage` (exported, line 146) redacts rootPath/homedir from error strings.
- `src/vault/unity-project-vault.ts` (451 lines) — `UnityProjectVault`. `readFile` at 180–183 (via `resolveSafeVaultReadPath`), `writeFile` at 185–188 (via `prepareSafeVaultWritePath`, direct write). `reindexFile` (public, line 242) short-circuits on unchanged xxhash at line 253: `if (existing?.blobHash === hash) return false;`. Embedding failure is best-effort (lines 269–280: catch + warn, indexing continues). NO write lock on this class (only ObsidianVault has one) — do not test concurrency here.
- `src/vault/vault-registry.ts` (129 lines) — `VaultRegistry`: `register/unregister/get/list`, `resolveVaultForPath` (longest-prefix, realpath-canonicalized, line 84), `query()` (line 103) merges per-vault results via `Promise.allSettled` — a vault whose `query` rejects is silently skipped. `createAndRegister` (line 49) rejects roots outside `factory.allowedRootPaths`.
- `src/vault/hash.ts` (34 lines) — `xxhash64Hex` (xxhashjs, seed `0xc0ffee`, 16 hex chars padded), `chunkIdFor` (sha256 truncated to 32 hex chars).
- `src/vault/discovery.ts` (66 lines) — `listIndexableFiles(root)`: recursive walk skipping `IGNORE_DIRS` (`Library`, `Temp`, `Logs`, `obj`, `bin`, `.git`, `node_modules`, `.strada`, `.obsidian`), skipping symlinks (line 44), skipping secret-like JSON (line 52), skipping files > 2 MB.
- `src/vault/embedding-adapter.ts` — interfaces to fake in tests:

```ts
// src/vault/embedding-adapter.ts:4-15
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
export interface VectorStore {
  add(vector: Float32Array, payload: unknown): number;
  remove(id: number): void;
  search(vector: Float32Array, k: number): Array<{ id: number; score: number; payload?: unknown }>;
  clear(): void;
}
```

- `ObsidianVault` constructor deps (`src/vault/obsidian-vault.ts:29-35`): `{ id, rootPath, embedding, vectorStore, obsidian: { apiUrl, apiKey } }`. `init()` (line 224) calls `client.healthCheck()` which catches all fetch errors and returns false (`src/vault/obsidian-client.ts:128-135`), logs a warn, and continues with FS-only mode — so pointing `apiUrl` at `http://127.0.0.1:1` makes tests work offline with a fast ECONNREFUSED.
- `UnityProjectVault` constructor deps (`src/vault/unity-project-vault.ts:25-30`): `{ id, rootPath, embedding, vectorStore }`. Both constructors synchronously create `<root>/.strada/vault/index.db` via better-sqlite3.

Repo test conventions:
- Vitest, colocated `*.test.ts`. Temp-dir + real-fs pattern exemplar: `src/channels/web/web-identity-store.test.ts` (uses `mkdtempSync(join(tmpdir(), 'strada-...'))`, pushes dirs onto a `tempDirs` array, `rmSync(..., { recursive: true, force: true })` in `afterEach`). Match it.
- Use ONLY `.md` fixture files in vault temp dirs — the markdown symbol extractor is pure JS; `.ts`/`.cs` fixtures would load tree-sitter WASM and slow/flake the tests.

Fake providers to define once in a test helper section of each vault test file (do NOT create a shared helper module; keep tests self-contained per repo convention):

```ts
function fakeEmbedding(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    model: 'fake-embed', dim: 4,
    embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    ...overrides,
  };
}
function fakeVectorStore(): VectorStore {
  let next = 1;
  const items = new Map<number, { payload: unknown }>();
  return {
    add: (_v, payload) => { const id = next++; items.set(id, { payload }); return id; },
    remove: (id) => { items.delete(id); },
    search: (_v, k) => [...items.entries()].slice(0, k).map(([id, e]) => ({ id, score: 1, payload: e.payload })),
    clear: () => items.clear(),
  };
}
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0 (only if node_modules missing) |
| Typecheck | `npm run typecheck:src` | exit 0, no errors |
| Lint | `npm run lint:src` | exit 0 |
| One test file | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/path-policy.test.ts` | all pass |
| Full suite | `node scripts/run-vitest-batches.mjs` | all pass |

## Scope

**In scope** (create these test files; modify NOTHING else):
- `src/vault/path-policy.test.ts` (create)
- `src/vault/hash.test.ts` (create)
- `src/vault/discovery.test.ts` (create)
- `src/vault/unity-project-vault.test.ts` (create)
- `src/vault/obsidian-vault.test.ts` (create)
- `src/vault/vault-registry.test.ts` (create)

**Out of scope** (do NOT touch, do NOT test in this plan — explicitly deferred):
- Any `src/vault/*.ts` SOURCE file — this plan adds tests only. If a test reveals a bug, write the test to pin CURRENT behavior, add a `// TODO(bug):` comment in the test, and report it.
- `src/vault/sqlite-vault-store.ts`, `chunker.ts`, `query-pipeline.ts`, `ppr.ts`, `canvas-generator.ts`, `embedding-adapter.ts`, `env-helpers.ts`, `watcher.ts`, `write-hook.ts`, `self-vault.ts`, `obsidian-client.ts`, `symbol-extractor/*` — exercised indirectly here; direct tests deferred to a future plan.
- `src/dashboard/server-vault-routes.ts` — covered by plan 007.

## Git workflow

- Branch: `advisor/006-vault-characterization-tests`
- Conventional commits, e.g. `test(vault): add path-policy and hash unit tests`. One commit per step is fine.
- Do NOT push or open a PR.

## Steps

### Step 1: `src/vault/path-policy.test.ts`

Use `mkdtempSync`/`rmSync` per the exemplar. Create a real vault root temp dir plus a second "outside" temp dir per test as needed. Cover (one `describe` per function):

1. `resolveSafeVaultReadPath(root, rel)`:
   - happy path: `notes/a.md` inside root resolves to the absolute path.
   - rejects `../escape.md` and `notes/../../escape.md` (throws `/escapes vault root/`).
   - rejects absolute input `/etc/passwd` (throws).
   - rejects a symlink leaf: `symlinkSync(outsideFile, join(root, 'link.md'))` → throws `/uses a symlink/`.
   - rejects a symlink ancestor: `symlinkSync(outsideDir, join(root, 'linkdir'))`, then read `linkdir/a.md` → throws `/uses a symlink/`.
   - rejects secret-like names: `.env.md` is NOT secret (regex matches basenames like `.env*` — verify: `secrets.md` IS rejected, throws `/not allowed/`); also rejects paths inside `node_modules/`.
   - rejects a file larger than 2 MB (`MAX_INDEXABLE_FILE_BYTES`): write a 2 MB + 1 byte file → throws `/too large/`.
2. `validateSafeVaultWriteRelPath(rel, bytes)`: returns normalized path for `notes\\a.md` → `notes/a.md`; throws for absolute paths, for non-indexable extensions (`a.exe`), for `secrets.json`, and for `bytes` > 2 MB.
3. `getIndexableFileInfo(root, rel)`: ok for a small `.md`; `{ ok:false, reason:'symlink' }` for a symlink leaf; `{ ok:false, reason:'symlink-ancestor' }` for symlinked dir; `{ ok:false, reason:'missing' }` for nonexistent; `{ ok:false, reason:'absolute path' }` for absolute input; `{ ok:false, reason:'binary-content' }` for a file starting with NUL bytes.
4. `isLikelyBinaryFile(abs)`: true for a buffer containing `\x00`; false for ASCII; **false for UTF-8 Turkish text** (e.g. `'ğüşıöçĞÜŞİÖÇ '.repeat(500)`) — this pins the May-2026 P2 fix; true for random bytes that are invalid UTF-8 (e.g. `Buffer.from([0xff, 0xfe, 0xfd, ...].repeat enough to exceed 5 replacement chars)`).
5. `resolveExistingVaultRoot`: ok for existing dir (returns realpath); `{ ok:false }` for relative path, nonexistent path, a file (not dir), and a symlinked root.
6. `isVaultRootAllowed`: true when root equals/is inside an allowed root; false when outside; false when allowed list empty entries don't resolve.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/path-policy.test.ts` → all pass.

### Step 2: `src/vault/hash.test.ts`

- `xxhash64Hex('hello')` is deterministic (call twice, equal), returns exactly 16 lowercase-hex chars, differs for `'hello!'`; identical for equal `string` vs `Buffer.from(string)` input.
- `chunkIdFor(path, offset, body)`: 32 hex chars; differs when any of path/offset/body differs; stable across calls.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/hash.test.ts` → all pass.

### Step 3: `src/vault/discovery.test.ts`

Build a temp tree: `a.md`, `src/b.ts`, `node_modules/x.md`, `.git/y.md`, `.strada/z.md`, `secrets.json`, `appsettings.production.json`, `big.md` (> 2 MB), a symlinked file, `image.png`. Assert `listIndexableFiles(root)`:
- includes `a.md` (lang `markdown`) and `src/b.ts` (lang `typescript`);
- excludes everything under `node_modules`, `.git`, `.strada`; excludes both secret-like JSONs; excludes `big.md`; excludes the symlink; excludes `image.png`;
- returned paths are root-relative with forward slashes.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/discovery.test.ts` → all pass.

### Step 4: `src/vault/unity-project-vault.test.ts`

Real temp dirs + fake embedding/vector store (helpers above). Use `.md` fixtures only. Always `await vault.dispose()` in `afterEach` BEFORE `rmSync` (better-sqlite3 holds the db open). Cover:

1. **init + index happy path**: create root with `notes/a.md`; `await vault.init()`; `vault.listFiles()` contains `notes/a.md` with non-empty `blobHash`; `(await vault.stats()).fileCount === 1`.
2. **hash short-circuit (Fix C1, line 253)**: after init, call `await vault.reindexFile('notes/a.md')` → returns `false` (content unchanged). Rewrite the file with DIFFERENT content → `reindexFile` returns `true`. Then `await vault.sync()` with no further changes → `changed === 0`.
3. **read confinement through the PUBLIC API**: `vault.readFile('../outside.md')` rejects; `vault.readFile('/etc/hosts')` rejects; symlink inside root pointing outside rejects; `vault.readFile('notes/a.md')` returns content.
4. **write confinement**: `vault.writeFile('notes/new.md', '# hi')` creates the file on disk inside root; `vault.writeFile('../evil.md', 'x')` rejects; `vault.writeFile('secrets.json', '{}')` rejects.
5. **deletion pruning**: after init with 2 files, `rmSync` one, `await vault.sync()` → `changed === 1` and `listFiles()` no longer contains it.
6. **embedding failure is best-effort**: construct vault with `fakeEmbedding({ embed: async () => { throw new Error('provider down'); } })`; `init()` resolves; `listFiles()` still contains the file (FTS indexing survives embedding failure).

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/unity-project-vault.test.ts` → all pass.

### Step 5: `src/vault/obsidian-vault.test.ts`

Construct with `obsidian: { apiUrl: 'http://127.0.0.1:1', apiKey: 'test' }` (unreachable → fast failure → FS fallback paths exercised). Cover:

1. **sync() serialization (AsyncLock, lines 85–108 + 238–259)**: init with one `.md` file. Build an instrumented embedding provider: `let active = 0; let overlapped = false;` and `embed` does `active++; if (active > 1) overlapped = true; await new Promise(r => setTimeout(r, 25)); active--; return vectors;`. Modify the file, then fire `const [r1, r2] = await Promise.all([vault.sync(), vault.sync()]);`. Assert `overlapped === false`, `r1.changed + r2.changed === 1` (exactly one sync sees the change; the other short-circuits on the unchanged hash). This fails if the lock is removed: both syncs would index and the counts/overlap change.
2. **writeFile falls back to FS when the Obsidian API is unreachable (lines 353–364)**: `await vault.writeFile('notes/n.md', '# note')` resolves and the file exists on disk under root. Also: `writeFile('../evil.md', 'x')` rejects (validateSafeVaultWriteRelPath).
3. **canvas regen atomicity + tmp cleanup (lines 688–729)**: after init, the canvas exists at `<root>/.strada/vault/graph.canvas`. Force a rename failure: delete the canvas file and create a non-empty DIRECTORY at that exact path (`mkdirSync(finalPath)` + a file inside it). Modify a vault file, `const r = await vault.sync()`; assert `r.canvas?.ok === false`, the directory at `graph.canvas` is intact, and `graph.canvas.tmp` does NOT exist (cleanup ran). Assert `r.canvas.error` does NOT contain the temp root path (redaction). Note: on some platforms rename-over-dir may behave differently — if this fixture does not produce a failure on the executor's platform, fall back to mocking `node:fs/promises` with `vi.mock` + `importActual`, overriding only `rename`.
4. **VaultQueryError on empty query (lines 50–58, 268–272)**: after init, `await expect(vault.query({ text: '   ' })).rejects.toThrowError(VaultQueryError)` (import `VaultQueryError` from `./obsidian-vault.js`).
5. **redactPathsInMessage (exported, line 146)**: pure unit tests — replaces rootPath with `<vault>`, replaces homedir with `<home>`, replaces a differing realpathRoot argument, returns input unchanged when nothing matches, handles empty string.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/obsidian-vault.test.ts` → all pass.

### Step 6: `src/vault/vault-registry.test.ts`

Use hand-rolled fake `IVault` objects (plain objects implementing `id/kind/rootPath/query/dispose/...` with `vi.fn`) — no real fs needed except for `resolveVaultForPath`/`createAndRegister`, which need real temp dirs (they realpath/lstat). Cover:

1. `register/get/list/unregister` round-trip; `onRegister` listener fires on register and unsubscribes.
2. **query() with one failing vault**: register two fake vaults; vault A's `query` rejects, vault B returns one hit. `await registry.query({ text: 'x' })` resolves with B's hit only (Promise.allSettled at line 107) — registry survives a broken vault.
3. `resolveVaultForPath`: longest-prefix wins for nested roots (create temp dirs `root/` and `root/inner/`, two fakes); returns `undefined` for an unrelated path.
4. `createAndRegister`: with a factory whose `allowedRootPaths` is `[allowedTmpDir]`, registering a dir inside it succeeds; registering an OUTSIDE temp dir rejects with `'vault root is outside the allowed project roots'`; with empty `allowedRootPaths` it always rejects; with no factory it rejects `'vault factory unavailable'`.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/vault-registry.test.ts` → all pass.

### Step 7: Full gate

Run typecheck, lint, and all six new files together:
`NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/` → all pass (including the pre-existing `symbol-summarizer.test.ts`).

**Verify**: `npm run typecheck:src` → exit 0; `npm run lint:src` → exit 0.

## Test plan

(This plan IS the test plan — see steps 1–6 for the case lists.) Structural patterns: `src/channels/web/web-identity-store.test.ts` for temp-dir/fs lifecycle; `src/vault/symbol-summarizer.test.ts` for vault-local test style. Final verification: `node scripts/run-vitest-batches.mjs` → all pass.

## Done criteria

- [ ] `npm run typecheck:src` exits 0
- [ ] `npm run lint:src` exits 0
- [ ] All 6 new test files exist and pass via `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/`
- [ ] `node scripts/run-vitest-batches.mjs` exits 0 (no existing test broken)
- [ ] `git status` shows ONLY the 6 new test files (no source file modified)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any excerpt in "Current state" doesn't match the live code (drift since `aea95ad`).
- The sync()-serialization test (Step 5.1) shows `overlapped === true` — that is a real concurrency bug in the lock; pin nothing, report it.
- A confinement test PASSES a path it should reject (e.g. `readFile('../x')` resolves) — that is a live security bug; report immediately.
- Constructing a vault in a temp dir fails because better-sqlite3 or xxhashjs native bindings are missing — environment problem, not fixable in tests.
- The canvas rename-failure fixture (Step 5.3) cannot be made to fail on this platform even with the vi.mock fallback.
- You find yourself wanting to edit any non-test file.

## Maintenance notes

- These are characterization tests: they pin behavior as of `aea95ad`, including the May-2026 hardening (binary detection, symlink-ancestor walk, AsyncLock). If a future change intentionally alters policy (e.g. allowing larger files), update the corresponding constant-driven assertions, not the security assertions.
- Reviewer focus: Step 5.1's concurrency assertion (`r1.changed + r2.changed === 1`) is the load-bearing one; make sure it isn't weakened to `>= 1`.
- Explicitly deferred (future plan): direct tests for `sqlite-vault-store.ts` (`runReindexTxn` rollback), `chunker.ts`, `query-pipeline.ts` (`rrfFuse`/`packByBudget`), `embedding-adapter.ts` (batch mismatch error), `self-vault.ts`, `watcher.ts`, and the symbol extractors.
- The original audit note claimed `ObsidianVault.writeFile` uses temp+rename atomicity — it does not (it is API-write with FS fallback); the atomic temp+rename pattern is in canvas regeneration only. This plan tests what actually exists.
