/**
 * EmbeddingQueue — Batched async embedding generation for instincts
 *
 * Collects instinct IDs and texts for ~500ms, then embeds all at once
 * via the shared IEmbeddingProvider. Updates instinct rows with their
 * embedding vectors via LearningStorage.updateInstinctEmbedding().
 *
 * Fire-and-forget: embedding failure is logged but never rethrown.
 * Instincts are already persisted to SQLite before queueing.
 */

import type { IEmbeddingProvider } from "../../rag/rag.interface.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import { getLogger } from "../../utils/logger.js";

interface PendingItem {
  instinctId: string;
  text: string;
}

interface EmbeddingQueueOptions {
  batchWindowMs?: number;
  maxPendingItems?: number;
}

const DEFAULT_BATCH_WINDOW_MS = 500;
const DEFAULT_MAX_PENDING_ITEMS = 1000;

export class EmbeddingQueue {
  private readonly provider: IEmbeddingProvider;
  private readonly storage: LearningStorage;
  private readonly batchWindowMs: number;
  private readonly maxPendingItems: number;

  private pending: PendingItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    provider: IEmbeddingProvider,
    storage: LearningStorage,
    options?: EmbeddingQueueOptions,
  ) {
    this.provider = provider;
    this.storage = storage;
    this.batchWindowMs = options?.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxPendingItems = options?.maxPendingItems ?? DEFAULT_MAX_PENDING_ITEMS;
  }

  /**
   * Enqueue an instinct for embedding generation.
   * Does NOT embed immediately — waits for the batch window.
   */
  enqueue(instinctId: string, text: string): void {
    if (this.stopped) return;

    if (this.pending.length >= this.maxPendingItems) {
      this.pending.shift(); // Drop oldest to prevent unbounded growth
    }

    this.pending.push({ instinctId, text });

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.batchWindowMs);
      this.timer.unref();
    }
  }

  /**
   * Flush all pending items: embed texts in one batch, then update storage.
   * Errors are caught and logged — never rethrown (fire-and-forget).
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;

    // Splice out current batch so new enqueues go to a fresh array
    const batch = this.pending.splice(0, this.pending.length);

    try {
      const texts = batch.map((item) => item.text);
      const result = await this.provider.embed(texts);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]!;
        const embedding = result.embeddings[i];
        if (embedding) {
          this.storage.updateInstinctEmbedding(item.instinctId, embedding);
        }
      }
    } catch (error) {
      // Fire-and-forget: instincts are already persisted in SQLite.
      // Embedding failure just means no semantic search for these instincts.
      try {
        const logger = getLogger();
        logger.debug("EmbeddingQueue: batch embedding failed", {
          count: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Logger may not be initialized in test environments — silently ignore
      }
    }
  }

  /**
   * Stop the queue: clear timer and discard pending items.
   * Instincts are already persisted — only embedding generation is lost.
   */
  shutdown(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
  }
}
