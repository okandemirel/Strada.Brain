import chokidar, { type FSWatcher } from 'chokidar';
import { basename, relative } from 'node:path';
import { lstat } from 'node:fs/promises';
import { getLoggerSafe } from '../utils/logger.js';
import {
  hasSymlinkAncestor,
  isIgnoredVaultPath,
  isPotentiallyIndexableVaultPath,
} from './path-policy.js';

export interface VaultWatcherOptions {
  root: string;
  debounceMs: number;
  onBatch: (paths: string[]) => Promise<void> | void;
  /** Poll interval in ms. Defaults to 100 for test-runner reliability on macOS FSEvents. Set 0 to use native events. */
  pollIntervalMs?: number;
}

const IGNORE_REGEX = /(^|\/)(Library|Temp|Logs|obj|bin|\.git|node_modules|\.strada|\.obsidian)(\/|$)/;
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
    const rootStats = await lstat(this.opts.root).catch(() => null);
    const rootIsFile = Boolean(rootStats?.isFile());
    this.watcher = chokidar.watch(this.opts.root, {
      ignoreInitial: true,
      // Fix SecH1: symlinks can point outside the vault root; never follow them.
      followSymlinks: false,
      usePolling: pollInterval > 0,
      interval: pollInterval > 0 ? pollInterval : undefined,
      ignored: (path) => IGNORE_REGEX.test(path.replaceAll('\\', '/')),
    });
    const computeRel = (absPath: string): string => {
      return rootIsFile
        ? basename(this.opts.root)
        : relative(this.opts.root, absPath).replaceAll('\\', '/');
    };
    const shouldIngest = async (rel: string, absPath: string): Promise<boolean> => {
      if (IGNORE_REGEX.test('/' + rel) || isIgnoredVaultPath(rel) || !isPotentiallyIndexableVaultPath(rel)) {
        return false;
      }
      // followSymlinks:false stops chokidar from descending into symlinked
      // directories, but events from already-tracked paths may still surface
      // if a symlinked dir was created after the initial scan. Walk ancestors
      // explicitly so /vault/secret -> /etc cannot leak files.
      if (!rootIsFile && (await hasSymlinkAncestor(this.opts.root, absPath))) {
        getLoggerSafe().warn('[VaultWatcher] skipping event under symlinked directory', {
          op: 'watcher-skip-symlink',
          path: rel,
        });
        return false;
      }
      return true;
    };
    const enqueue = async (absPath: string): Promise<void> => {
      const rel = computeRel(absPath);
      if (!(await shouldIngest(rel, absPath))) return;
      this.dirty.add(rel);
      this.scheduleDrain();
    };
    const enqueueSafe = (absPath: string): void => {
      // Surface enqueue rejections in the logs instead of dropping them on
      // the floor; chokidar otherwise has no visibility into our async work.
      enqueue(absPath).catch((err) => {
        getLoggerSafe().warn('[VaultWatcher] enqueue failed', {
          op: 'watcher-enqueue',
          path: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    this.watcher.on('add', enqueueSafe);
    this.watcher.on('change', enqueueSafe);
    this.watcher.on('unlink', enqueueSafe);
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
      getLoggerSafe().warn('[VaultWatcher] onBatch threw', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    if (this.dirty.size) await this.drain();
  }
}

