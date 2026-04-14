import chokidar, { type FSWatcher } from 'chokidar';
import { relative } from 'node:path';

export interface VaultWatcherOptions {
  root: string;
  debounceMs: number;
  onBatch: (paths: string[]) => Promise<void> | void;
}

const IGNORE_REGEX = /(^|\/)(Library|Temp|Logs|obj|bin|\.git|node_modules|\.strada)(\/|$)/;

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private opts: VaultWatcherOptions) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.opts.root, {
      ignoreInitial: true,
      usePolling: true,
      interval: 100,
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
    // Wait for the watcher to finish its initial scan and settle so subsequent writes are detected.
    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => {
        // Brief settle to ensure the polling loop is active before callers write files.
        setTimeout(resolve, 50);
      });
    });
  }

  private scheduleDrain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.drain(), this.opts.debounceMs);
  }

  private async drain(): Promise<void> {
    const batch = [...this.dirty].sort();
    this.dirty.clear();
    this.timer = null;
    if (batch.length) await this.opts.onBatch(batch);
  }

  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    if (this.dirty.size) await this.drain();
  }
}
