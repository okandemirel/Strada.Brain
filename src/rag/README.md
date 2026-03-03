# src/rag/

Retrieval-Augmented Generation pipeline that indexes C# source code for semantic search. The agent uses this to find relevant code when answering questions or generating new code.

## How It Works

### Indexing (runs on startup, background)

```
*.cs files in UNITY_PROJECT_PATH
  → parseCSharpFile() (structural C# parsing)
  → chunkCSharpFile() (split into semantic chunks)
  → embeddingProvider.embed(chunks) (batch vectorization)
  → hnswStore.upsert(vectors) (index for fast search)
```

**Chunking is C#-specific.** The chunker (`chunker.ts`) uses a brace-aware parser that tracks string literals, verbatim strings, char literals, and comments to correctly identify class/struct/method boundaries.

Chunk types:
- File header (lines before first type declaration)
- Structs (always one chunk per struct — ECS structs are assumed small)
- Classes: if body <= 1500 chars, one chunk; otherwise split per-method/constructor with `// File: ... // Class: ...` context headers

Chunk IDs: 16-char hex SHA-256 of `filePath:startLine:endLine`.

### Search (per agent message)

```
Query text
  → embeddingProvider.embed(query)
  → hnswStore.search(queryVector, topK * 3 candidates)
  → Filter by kind/file pattern
  → rerankResults(candidates, query) (weighted scoring)
  → Filter by minScore (0.15), take topK (default 8)
  → Format as fenced code blocks with metadata headers
```

### Reranking (`reranker.ts`)

Weighted combination:
- **Vector similarity:** 60% weight (cosine distance from HNSW)
- **Keyword overlap:** 25% weight (query terms found in chunk)
- **Structural score:** 15% weight (bonuses for class/struct kind, symbol name match, `System` suffix for ECS, `IComponent` in content)

## Embedding Providers

| Provider | File | Models | Batch Size |
|----------|------|--------|------------|
| OpenAI | `embeddings/openai-embeddings.ts` | `text-embedding-3-small` (1536d), `text-embedding-3-large` (3072d), `ada-002` (1536d) | 100 |
| Ollama | `embeddings/ollama-embeddings.ts` | `nomic-embed-text` (768d), `mxbai-embed-large` (1024d), `all-minilm` (384d) | Batch or sequential |

**Cache** (`embeddings/embedding-cache.ts`): LRU cache (10K entries max) keyed by SHA-256 of provider+text. Persists to `embedding-cache.json` on shutdown.

## Vector Stores

Two implementations coexist (migration period):

### HNSWVectorStore (`hnsw/hnsw-vector-store.ts`) — Primary

Native `hnswlib-node` (C++ bindings). Default config:
- M=16 (links per node), efConstruction=200, efSearch=128
- Cosine similarity via inner product on L2-normalized vectors
- Max 100,000 elements
- Persistence: `hnsw.index` (binary graph) + `metadata.json`

Soft delete only (`markDelete()`). Deleted indices tracked in a Set and filtered during search.

### FileVectorStore (`vector-store.ts`) — Legacy

Flat `Float32Array` storage with an inline hand-rolled HNSW implementation (pure TypeScript). Switches to HNSW search automatically when >100 entries. Persists to `vectors.bin` + `chunks.json`. Kept as fallback during migration.

## Quantization (`hnsw/quantization.ts`)

Three quantization modes for large vector sets:
- **Binary** (32x reduction): sign bits per dimension
- **Scalar** (4x reduction): float32 → int8 via min/max scaling
- **Product** (8-16x reduction): subvector codebooks via k-means

`getRecommendedQuantization()` selects automatically: >1GB binary, >100MB product, >10MB scalar, else none.

## RAG Pipeline (`rag-pipeline.ts`)

Orchestrates indexing and search. Key behaviors:
- Content hashing to skip unchanged files during re-indexing
- Writes to both HNSW and legacy stores during migration
- Budget truncation: drops lowest-scored chunks or truncates last chunk to fit context window
- Context formatting: `### kind - symbol (file:start-end) [score: X.XXX]` headers with fenced C# code

## Key Files

| File | Purpose |
|------|---------|
| `rag.interface.ts` | All RAG types: `IRAGPipeline`, `CodeChunk`, `VectorSearchHit` |
| `rag-pipeline.ts` | Orchestration: index, search, format context |
| `chunker.ts` | C#-specific structural chunking (brace-aware parser) |
| `reranker.ts` | Weighted reranking (vector + keyword + structural) |
| `vector-store.ts` | Legacy flat store + inline HNSW |
| `hnsw/hnsw-vector-store.ts` | Production HNSW via hnswlib-node |
| `hnsw/quantization.ts` | Binary/scalar/product vector quantization |
| `embeddings/openai-embeddings.ts` | OpenAI embedding provider |
| `embeddings/ollama-embeddings.ts` | Ollama embedding provider |
| `embeddings/embedding-cache.ts` | LRU embedding cache with persistence |
