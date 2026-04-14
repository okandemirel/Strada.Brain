import chokidar, { type FSWatcher } from 'chokidar';
import { relative } from 'node:path';

export interface VaultWatcherOptions {
  root: string;
  debounceMs: number;
  onBatch: (paths: string[]) => Promise<void> | void;
  /** Poll interval in ms. Defaults to 100 for test-runner reliability on macOS FSEvents. Set 0 to use native events. */
  pollIntervalMs?: number;
}

const IGNORE_REGEX = /(^|\/)(Library|Temp|Logs|obj|bin|\.git|node_modules|\.strada)(\/|$)/;
// Chokidar's 'ready' fires once the initial scan settles, but the polling backend needs a short window
// to install stat callbacks before subsequent writes register reliably.
const POLLING_SETTLE_MS = 50;

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private opts: VaultWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const pollInterval = this.opts.pollIntervalMs ?? 100;
    this.watcher = chokidar.watch(this.opts.root, {
      ignoreInitial: true,
      usePolling: pollInterval > 0,
      interval: pollInterval > 0 ? pollInterval : undefined,
      ignored: (path) => IGNORE_REGEX.test(path.replaceAll('\\', '/')),
    });
    const enqueue = (absPath: string) => {
      const rel = relative(this.opts.root, absPath).replaceAll('\\', '/');
      if (IGNORE_REGEX.test('/' + rel)) return;
      this.dirty.add(rel);
      this.scheduleDrain();
    };
    this.watcher.on('add', enqueue);
    this.watcher.on('change', enqueue);
    this.watcher.on('unlink', enqueue);
    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => {
        if (pollInterval > 0) setTimeout(resolve, POLLING_SETTLE_MS);
        else resolve();
      });
    });
  }

  private scheduleDrain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), this.opts.debounceMs);
  }

  private async drain(): Promise<void> {
    const batch = [...this.dirty].sort();
    this.dirty.clear();
    this.timer = null;
    if (batch.length === 0) return;
    try {
      await this.opts.onBatch(batch);
    } catch (err) {
      console.warn('[VaultWatcher] onBatch threw:', err);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    if (this.dirty.size) await this.drain();
  }
}
