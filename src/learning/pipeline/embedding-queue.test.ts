/**
 * EmbeddingQueue Tests — Batched async embedding generation for instincts
 *
 * Tests batch window behavior, flush logic, failure handling, and lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbeddingQueue } from "./embedding-queue.js";
import type { IEmbeddingProvider, EmbeddingBatch } from "../../rag/rag.interface.js";
import type { LearningStorage } from "../storage/learning-storage.js";

// Mock embedding provider
function createMockProvider(): IEmbeddingProvider {
  return {
    name: "test-provider",
    dimensions: 768,
    embed: vi.fn().mockImplementation(async (texts: string[]) => ({
      embeddings: texts.map(() => Array.from({ length: 768 }, () => Math.random())),
      usage: { totalTokens: texts.length * 10 },
    })),
  };
}

// Mock learning storage
function createMockStorage(): Pick<LearningStorage, "updateInstinctEmbedding"> {
  return {
    updateInstinctEmbedding: vi.fn(),
  };
}

describe("EmbeddingQueue", () => {
  let provider: IEmbeddingProvider;
  let storage: Pick<LearningStorage, "updateInstinctEmbedding">;
  let queue: EmbeddingQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = createMockProvider();
    storage = createMockStorage();
    queue = new EmbeddingQueue(provider, storage as LearningStorage, { batchWindowMs: 500 });
  });

  afterEach(() => {
    queue.shutdown();
    vi.useRealTimers();
  });

  it("enqueue does NOT immediately call embed -- waits for batch window", () => {
    queue.enqueue("instinct-1", "trigger pattern action text");

    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("after ~500ms, flush is called automatically and embeds all queued items in one embed() call", async () => {
    queue.enqueue("instinct-1", "first trigger action");
    queue.enqueue("instinct-2", "second trigger action");
    queue.enqueue("instinct-3", "third trigger action");

    // Advance past the batch window
    vi.advanceTimersByTime(500);

    // flush() is async, need to wait for microtasks
    await vi.runAllTimersAsync();

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith([
      "first trigger action",
      "second trigger action",
      "third trigger action",
    ]);
  });

  it("flush calls storage.updateInstinctEmbedding(id, embedding) for each successfully embedded item", async () => {
    const mockEmbeddings = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    vi.mocked(provider.embed).mockResolvedValueOnce({
      embeddings: mockEmbeddings,
      usage: { totalTokens: 20 },
    } as EmbeddingBatch);

    queue.enqueue("id-a", "text a");
    queue.enqueue("id-b", "text b");

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(storage.updateInstinctEmbedding).toHaveBeenCalledTimes(2);
    expect(storage.updateInstinctEmbedding).toHaveBeenCalledWith("id-a", [0.1, 0.2, 0.3]);
    expect(storage.updateInstinctEmbedding).toHaveBeenCalledWith("id-b", [0.4, 0.5, 0.6]);
  });

  it("if embed() throws, instincts are NOT lost -- error is logged, queue continues", async () => {
    vi.mocked(provider.embed).mockRejectedValueOnce(new Error("API rate limit"));

    queue.enqueue("id-fail", "this will fail");

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    // Should NOT crash -- storage should not have been called since embed failed
    expect(storage.updateInstinctEmbedding).not.toHaveBeenCalled();

    // Queue should still work for subsequent items
    vi.mocked(provider.embed).mockResolvedValueOnce({
      embeddings: [[1, 2, 3]],
      usage: { totalTokens: 10 },
    } as EmbeddingBatch);

    queue.enqueue("id-ok", "this will succeed");

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(storage.updateInstinctEmbedding).toHaveBeenCalledWith("id-ok", [1, 2, 3]);
  });

  it("multiple enqueue calls within the batch window are collected into a single embed() call", async () => {
    queue.enqueue("id-1", "text 1");

    // Small delay within the window
    vi.advanceTimersByTime(100);
    queue.enqueue("id-2", "text 2");

    vi.advanceTimersByTime(100);
    queue.enqueue("id-3", "text 3");

    // Now flush at 500ms
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();

    // All three should be in a single call
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith(["text 1", "text 2", "text 3"]);
  });

  it("shutdown clears the timer and discards pending items", async () => {
    queue.enqueue("id-discard", "will be discarded");

    queue.shutdown();

    // Even after advancing time, embed should not be called
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("enqueue after shutdown does nothing (no crash)", () => {
    queue.shutdown();

    expect(() => queue.enqueue("id-after", "after shutdown")).not.toThrow();
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("flush with empty queue is a no-op", async () => {
    // Trigger flush on empty queue
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(provider.embed).not.toHaveBeenCalled();
    expect(storage.updateInstinctEmbedding).not.toHaveBeenCalled();
  });
});
