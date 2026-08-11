import { randomUUID } from "node:crypto";

export interface MessageQueueOptions<T> {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  batchSize: number;
  /** Discord: 30000ms timeout; Slack: not used. */
  timeoutMs?: number;
  /** Discord: 'fifo', Slack: 'priority'. */
  ordering: "fifo" | "priority";
  /** Slack: true (adds jitter to retry delay). Discord: false. */
  jitter?: boolean;
  /** Slack: true (skip backed-off entries). Discord: false. */
  skipBackedOff?: boolean;
  rateLimitBackoffMs: number;
  processItem: (item: T) => Promise<unknown>;
  isRateLimitError: (error: unknown) => boolean;
  extractRetryAfter: (error: unknown) => number | null;
  /** Discord: checked in retry-backoff timer to detect disconnection. */
  isConnected?: () => boolean;
}

export interface QueueEntry<T> {
  id: string;
  item: T;
  priority: number;
  retries: number;
  enqueuedAt: number;
  retryAfter?: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class MessageQueue<T> {
  /**
   * Exposed so channel adapters can keep backward-compatible accessors
   * (e.g. a getter named `messageQueue` that returns this array).
   */
  readonly entries: QueueEntry<T>[] = [];

  private processing = false;
  private rateLimited = false;
  private rateLimitResetTime = 0;

  /**
   * Exposed so channel adapters can keep backward-compatible accessors
   * (e.g. a getter named `retryTimers` that returns this map).
   */
  readonly timerMap = new Map<ReturnType<typeof setTimeout>, QueueEntry<T>>();

  private readonly opts: MessageQueueOptions<T>;

  constructor(opts: MessageQueueOptions<T>) {
    this.opts = opts;
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(item: T, priority = 0): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry: QueueEntry<T> = {
        id: randomUUID(),
        item,
        priority,
        retries: 0,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };

      if (this.opts.ordering === "priority") {
        const idx = this.entries.findIndex((e) => e.priority > priority);
        if (idx === -1) {
          this.entries.push(entry);
        } else {
          this.entries.splice(idx, 0, entry);
        }
      } else {
        // fifo
        this.entries.push(entry);
      }
    });
  }

  async processQueue(): Promise<void> {
    if (this.processing || this.entries.length === 0) return;
    if (this.rateLimited && Date.now() < this.rateLimitResetTime) return;

    this.processing = true;
    this.rateLimited = false;

    try {
      // Evict timed-out entries (Discord/FIFO mode).
      if (this.opts.timeoutMs != null) {
        const now = Date.now();
        const toReject: QueueEntry<T>[] = [];
        const surviving: QueueEntry<T>[] = [];
        for (const entry of this.entries) {
          if (now - entry.enqueuedAt > this.opts.timeoutMs) {
            toReject.push(entry);
          } else {
            surviving.push(entry);
          }
        }
        this.entries.length = 0;
        this.entries.push(...surviving);
        for (const entry of toReject) {
          entry.reject(new Error(`Message timed out after ${this.opts.timeoutMs}ms`));
        }
      }

      if (this.opts.ordering === "priority" && this.opts.skipBackedOff) {
        // Slack mode: walk snapshot, skip backed-off entries (HOL-skip).
        const snapshot = [...this.entries];
        const processedIds: string[] = [];
        let processedCount = 0;
        const now = Date.now();

        for (const entry of snapshot) {
          if (processedCount >= this.opts.batchSize) break;
          if (entry.retryAfter != null && now < entry.retryAfter) continue;

          processedCount++;
          try {
            const result = await this.opts.processItem(entry.item);
            processedIds.push(entry.id);
            entry.resolve(result);
          } catch (error) {
            if (this.opts.isRateLimitError(error)) {
              const retryAfter =
                this.opts.extractRetryAfter(error) ?? this.opts.rateLimitBackoffMs;
              this.rateLimited = true;
              this.rateLimitResetTime = Date.now() + retryAfter;
              break;
            }
            entry.retries++;
            if (entry.retries >= this.opts.maxRetries) {
              entry.reject(error instanceof Error ? error : new Error(String(error)));
              processedIds.push(entry.id);
            } else {
              entry.retryAfter = Date.now() + this.computeRetryDelay(entry.retries);
            }
          }
        }

        const surviving = this.entries.filter((e) => !processedIds.includes(e.id));
        this.entries.length = 0;
        this.entries.push(...surviving);
      } else {
        // FIFO/Discord mode: process from the front of the queue.
        const batchSize = Math.min(this.opts.batchSize, this.entries.length);
        for (let i = 0; i < batchSize; i++) {
          const entry = this.entries[0];
          if (!entry) break;

          try {
            const result = await this.opts.processItem(entry.item);
            this.removeEntry(entry);
            entry.resolve(result);
          } catch (error) {
            if (this.opts.isRateLimitError(error)) {
              const retryAfter =
                this.opts.extractRetryAfter(error) ?? this.opts.rateLimitBackoffMs;
              this.rateLimited = true;
              this.rateLimitResetTime = Date.now() + retryAfter;
              break;
            }

            entry.retries++;
            if (entry.retries >= this.opts.maxRetries) {
              entry.reject(error instanceof Error ? error : new Error(String(error)));
              this.removeEntry(entry);
            } else {
              const delay = this.computeRetryDelay(entry.retries);
              this.removeEntry(entry);
              const timer = setTimeout(() => {
                this.timerMap.delete(timer);
                if (this.opts.isConnected && !this.opts.isConnected()) {
                  entry.reject(new Error("Discord channel disconnected"));
                  return;
                }
                // Re-insert at the HEAD, not the tail: this entry was at the
                // front of the FIFO queue, so pushing it to the back would let
                // messages enqueued during its backoff be delivered ahead of it,
                // breaking Discord's in-order delivery. unshift preserves FIFO.
                this.entries.unshift(entry);
              }, delay);
              this.timerMap.set(timer, entry);
            }
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Remove a specific entry by identity.
   *
   * NOT `entries.shift()`. The FIFO branch reads `entries[0]`, awaits the send,
   * and only then removes it — but a retry timer can fire during that await and
   * `unshift` its own entry back to the HEAD (which it must, to preserve
   * in-order delivery). A positional `shift()` then removes the newly-inserted
   * entry instead of the one that was just sent: the re-queued message is
   * dropped forever (never sent, never resolved or rejected, so its caller
   * hangs) and the sent message stays queued and is delivered a second time.
   * Removing by identity is immune to the queue shifting under the await.
   */
  private removeEntry(entry: { id: string }): void {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx !== -1) this.entries.splice(idx, 1);
  }

  /**
   * Exponential backoff for a retry attempt: `baseDelayMs * 2^(retries-1)`,
   * clamped to `maxDelayMs` and with up to +10% additive jitter when those
   * opts are set (Slack mode). With neither set (Discord/FIFO mode) it returns
   * the bare `baseDelayMs * 2^(retries-1)`.
   */
  private computeRetryDelay(retries: number): number {
    const delay = Math.min(
      this.opts.baseDelayMs * Math.pow(2, retries - 1),
      this.opts.maxDelayMs ?? Infinity,
    );
    const jitter = this.opts.jitter ? Math.random() * delay * 0.1 : 0;
    return delay + jitter;
  }

  /** Drain the queue, rejecting all pending entries with the given reason. */
  rejectAll(reason: string): void {
    const items = this.entries.splice(0, this.entries.length);
    for (const entry of items) {
      entry.reject(new Error(reason));
    }
  }

  /** Cancel all pending retry timers and reject their entries. */
  rejectRetryTimers(reason: string): void {
    for (const [timer, entry] of this.timerMap) {
      clearTimeout(timer);
      entry.reject(new Error(reason));
    }
    this.timerMap.clear();
  }
}
