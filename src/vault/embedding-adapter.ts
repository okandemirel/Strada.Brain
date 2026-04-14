export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface VectorStore {
  add(vector: Float32Array, payload: unknown): number;
  remove(id: number): void;
  search(vector: Float32Array, k: number): Array<{ id: number; score: number; payload?: unknown }>;
}

export interface ChunkToEmbed {
  chunkId: string;
  content: string;
}

export class EmbeddingAdapter {
  constructor(readonly provider: EmbeddingProvider, readonly store: VectorStore) {}

  async upsertBatch(chunks: ChunkToEmbed[]): Promise<Record<string, number>> {
    if (chunks.length === 0) return {};
    const vectors = await this.provider.embed(chunks.map((c) => c.content));
    if (vectors.length !== chunks.length) {
      throw new Error(`EmbeddingProvider contract violation: got ${vectors.length} vectors for ${chunks.length} chunks`);
    }
    const out: Record<string, number> = {};
    for (let i = 0; i < chunks.length; i++) {
      const id = this.store.add(vectors[i]!, { chunkId: chunks[i]!.chunkId });
      out[chunks[i]!.chunkId] = id;
    }
    return out;
  }

  remove(hnswId: number): void {
    this.store.remove(hnswId);
  }

  async search(query: string, topK: number): Promise<Array<{ id: number; score: number; payload?: unknown }>> {
    const [vec] = await this.provider.embed([query]);
    return this.store.search(vec!, topK);
  }
}
