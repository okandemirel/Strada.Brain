# src/memory/

Persistent memory systems for Strada.Brain, providing conversation recall, project analysis caching, and semantic retrieval across sessions.

## Memory Systems Overview

The memory module implements two backends behind a shared `IMemoryManager` interface:

1. **FileMemoryManager** (`file-memory-manager.ts`) -- File-based JSON storage with TF-IDF retrieval. Lightweight, zero-dependency option suitable for single-instance deployments.
2. **AgentDBMemory** (`unified/agentdb-memory.ts`) -- SQLite + HNSW vector-indexed backend with 3-tier memory architecture. Higher performance for semantic search and large memory stores.

A `BackwardCompatibleMemory` wrapper and `MemoryMigrator` handle migration from the legacy TF-IDF backend to the unified vector backend.

## IMemoryManager Interface

Defined in `memory.interface.ts`, the core interface provides:

- **Project analysis cache** -- `cacheAnalysis()` / `getCachedAnalysis()` with TTL-based invalidation (default 24h).
- **Conversation memory** -- `storeConversation()` saves trimmed session messages for later recall.
- **Typed entries** -- 7 entry types: `conversation`, `analysis`, `note`, `insight`, `error`, `command`, `task`. Each has a dedicated TypeScript interface with type guards.
- **Retrieval** -- Text (TF-IDF), semantic (vector), hybrid, chat-scoped, and type-filtered search modes. All return scored `RetrievalResult` objects.

## RAG Pipeline (src/rag/)

The RAG (Retrieval-Augmented Generation) pipeline lives in `src/rag/` and is consumed by the orchestrator. It indexes project source code into vector embeddings and retrieves relevant chunks at query time.

- **`rag-pipeline.ts`** -- `IRAGPipeline` implementation: indexes files, searches by query, formats context for LLM injection.
- **`chunker.ts`** -- Code-aware chunking that respects language boundaries (classes, methods, functions).
- **`reranker.ts`** -- Cross-encoder reranking for improved relevance after initial vector search.
- **`vector-store.ts`** -- Flat vector store with cosine similarity search.
- **Embedding providers** -- `embeddings/openai-embeddings.ts` (OpenAI API), `embeddings/ollama-embeddings.ts` (local Ollama), `embeddings/embedding-cache.ts` (LRU caching layer).

## HNSW Vector Indexing (src/rag/hnsw/)

The HNSW (Hierarchical Navigable Small World) module provides high-performance approximate nearest-neighbor search:

- **`hnsw-vector-store.ts`** -- `HNSWVectorStore` implementing `IVectorStore`. Supports cosine/euclidean/dot-product metrics, configurable `M`, `efConstruction`, and `efSearch` parameters.
- **`quantization.ts`** -- Binary, scalar, and product quantization for memory-efficient storage (up to 32x compression with binary quantization).
- **`hnsw-mock.ts`** -- In-memory mock for testing without native dependencies.
- Default parameters: `M=16`, `efConstruction=200`, `efSearch=128`, max 11,100 elements.

## AgentDB Unified Memory (unified/)

The unified memory system integrates AgentDB with HNSW vector indexing:

- **3-tier architecture**: Working (active context, 100 entries), Ephemeral (short-term, 1000 entries, 24h TTL), Persistent (long-term knowledge, 10,000 entries).
- **Automatic tier management** -- entries are promoted/demoted based on access patterns and importance scores.
- **Hybrid search** -- combines HNSW semantic search with TF-IDF text search using configurable weights (default 70/30 semantic/text).
- **MMR diversity** -- Maximal Marginal Relevance reranking to avoid redundant results.
- **Migration** -- `MemoryMigrator` converts legacy `FileMemoryManager` data with backup/rollback support.

## Key Files

| File | Purpose |
|---|---|
| `memory.interface.ts` | `IMemoryManager` interface, entry types, retrieval options |
| `file-memory-manager.ts` | JSON-based memory with TF-IDF (legacy backend) |
| `text-index.ts` | TF-IDF index, term extraction, cosine similarity |
| `unified/unified-memory.interface.ts` | `IUnifiedMemory`, tier/HNSW types, config |
| `unified/agentdb-memory.ts` | SQLite + HNSW unified memory implementation |
| `unified/migration.ts` | `MemoryMigrator`, `BackwardCompatibleMemory` |
| `unified/index.ts` | Barrel exports for unified memory module |
