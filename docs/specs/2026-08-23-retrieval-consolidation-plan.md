# Retrieval Consolidation Plan — rag/ ↔ vault/

**Date**: 2026-08-23
**Status**: Proposed (not implemented)
**Motivation**: AGENTS.md declares the Codebase Memory Vault the canonical codebase-retrieval surface, yet `src/rag/` still runs a full second retrieval stack wired into bootstrap (`RAGPipeline`) and the `code_search` tool. Two stacks means two embedding paths, two HNSW stores, two freshness models — and every reliability fix must be applied twice (see the 2026-08-23 audit: atomic reindex landed in vault only).

## Current state (verified)

| Concern | rag/ | vault/ |
|---|---|---|
| Scope | C#/TS source semantic search | Whole project: BM25(FTS5) + vectors + symbolic PPR over call/import graph |
| Embedding adapter | `rag/embedding-adapter.ts` (+ LRU disk cache) | `vault/embedding-adapter.ts` |
| Vector store | `rag/hnsw/hnsw-vector-store.ts` (also consumed by `memory/unified/agentdb-*`) | `vault/sqlite-vault-store.ts` FTS5 + per-file HNSW ids |
| Chunking | structural brace-matcher (`rag/chunker.ts`) | vault's own chunker |
| Freshness | manual sync / orchestrator-driven | chokidar watcher + write hook + hash short-circuit |
| Consumers | `code_search` tool, orchestrator knowledge context, doc-RAG subtrack | vault tools (`vault_*`), SelfVault |

## Target state

One retrieval stack (vault), one set of shared primitives, rag reduced to its genuinely distinct asset: the **doc-RAG subtrack** and the Unity-aware reranker heuristics until vault reproduces them.

## Phased plan

1. **Phase 0 — Contract freeze (no behavior change).** Snapshot current `code_search` result shapes and retrieval-quality bench baselines (`npm run bench:retrieval:record`). The existing machine-independent retrieval-quality CI gate is the regression harness for everything below.
2. **Phase 1 — Extract shared primitives to `src/retrieval/`.** Move embedding adapter (+disk cache) and HNSW store out of rag/ into a neutral home. vault/, rag/doc-track and memory/unified import from there. Pure refactor; all three consumers keep working.
3. **Phase 2 — `code_search` becomes a vault facade.** Re-register the tool against the vault registry with a language filter (`lang=csharp|typescript`). Flag-gated (`CODE_SEARCH_BACKEND=vault|legacy`) so rollback is a config flip.
4. **Phase 3 — Retire the legacy path.** Remove `RAGPipeline` wiring from bootstrap after one release cycle with the vault backend default. Keep the doc-RAG track and port any reranker boosts vault lacks (measure via nDCG corpus first).
5. **Phase 4 — Cleanup.** Delete dead rag modules, fold remaining types, single chunker.

## Non-negotiables during migration

- The vault reindex atomicity fix (2026-08-23, provisional-hash pattern) is the required baseline — no migration may reintroduce non-atomic index writes.
- hnswlib-node absence must degrade gracefully in BOTH stacks (vault already does brute-force fallback via the shared store).
- Memory/unified's direct import of rag's HNSW store moves in Phase 1, not later — it is the coupling that makes independent rag changes risky today.

## Rollback

Every phase lands behind the Phase-2 flag or is a pure move-refactor verified by typecheck + the retrieval-quality gate. Worst case: flip `CODE_SEARCH_BACKEND=legacy`, revert the phase commit.
