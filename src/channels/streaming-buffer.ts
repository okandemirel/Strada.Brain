export interface StreamingBufferOptions {
  /** Minimum milliseconds between flushes (throttle window). */
  throttleMs: number;
  /** Called each time the buffer is flushed (throttled or immediate). */
  onFlush: (text: string) => Promise<void>;
  /** If provided, called instead of onFlush for the final finalize call. */
  onFinalize?: (text: string) => Promise<void>;
}

/**
 * Throttled streaming buffer.
 *
 * Accumulates text updates and flushes them at most once per `throttleMs`.
 * A deferred flush scheduled inside the throttle window is automatically
 * cancelled when `finalize()` or `clearOnDisconnect()` is called so the
 * final (or no-longer-relevant) flush cannot fire late and overwrite the
 * final content.
 */
export class StreamingBuffer {
  private accumulatedText = "";
  private lastUpdate = 0;
  private updateQueued = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;

  constructor(private readonly opts: StreamingBufferOptions) {}

  /** Accumulate new text and flush if outside the throttle window. */
  async update(text: string): Promise<void> {
    if (this.finalized) return;

    this.accumulatedText = text;

    const now = Date.now();
    const elapsed = now - this.lastUpdate;

    if (elapsed < this.opts.throttleMs) {
      // Inside throttle window — schedule a deferred flush (once).
      if (!this.updateQueued) {
        this.updateQueued = true;
        this.throttleTimer = setTimeout(() => {
          this.updateQueued = false;
          this.throttleTimer = null;
          if (!this.finalized) {
            void this.opts.onFlush(this.accumulatedText).catch(() => {
              // Swallow errors from deferred flushes — they are best-effort.
            });
            this.lastUpdate = Date.now();
          }
        }, this.opts.throttleMs - elapsed);
      }
      return;
    }

    // Outside throttle window — flush immediately.
    await this.opts.onFlush(this.accumulatedText);
    this.lastUpdate = Date.now();
  }

  /**
   * Finalize the buffer with the definitive final text.
   *
   * Cancels any pending deferred flush and calls `onFinalize` (or `onFlush`
   * if no `onFinalize` was provided). Subsequent `update` calls are no-ops.
   */
  async finalize(text: string): Promise<void> {
    if (this.finalized) return;

    this.finalized = true;

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.updateQueued = false;
    this.accumulatedText = text;

    if (this.opts.onFinalize) {
      await this.opts.onFinalize(text);
    } else {
      await this.opts.onFlush(text);
    }
  }

  /**
   * Mark the buffer as finalized without flushing (used on disconnect).
   *
   * Cancels any pending deferred flush so no timer fires against a destroyed
   * client after the channel shuts down.
   */
  clearOnDisconnect(): void {
    this.finalized = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.updateQueued = false;
  }
}
