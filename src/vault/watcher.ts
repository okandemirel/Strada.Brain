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
  /**
   * Hard cap on how long a continuous stream of edits may defer a drain.
   * Without it the trailing-only debounce starves indexing under non-stop
   * writes (the timer keeps resetting). Defaults to max(debounceMs * 5, 5000).
   */
  maxWaitMs?: number;
}

const IGNORE_REGEX = /(^|\/)(Library|Temp|Logs|obj|bin|\.git|node_modules|\.strada|\.obsidian)(\/|$)/;
/**
 * Grace period after chokidar's 'ready' before the watch is treated as live.
 *
 * 'ready' means the initial scan finished, NOT that the backend is armed.
 * Measured on macOS with native FSEvents, writing a file immediately after
 * 'ready': 10 of 20 files produced no event at all. With a 50 ms settle, 0 of
 * 20 were missed (and 100 ms is no better, so 50 is the knee).
 *
 * This applies to both backends. The polling backend needs the window to
 * install its stat callbacks; the native backend needs it because FSEvents
 * registration is asynchronous inside the OS. Skipping it on the native path
 * silently drops newly created files — a file the user just wrote never gets
 * indexed, with nothing in the logs to say so.
 */
const WATCH_SETTLE_MS = 50;

/**
 * Poll interval when the caller does not specify one. Zero means "use native
 * filesystem events".
 *
 * This used to default to 100 ms, which put chokidar into stat-polling mode for
 * every vault in production — measured at roughly a quarter of a CPU core,
 * continuously, on an idle tree, because every watched file is stat()ed ten
 * times a second. The comment explaining it cited test-runner reliability on
 * macOS FSEvents: a test workaround that leaked into the shipped default.
 *
 * Native events are correct almost everywhere. Polling remains available for
 * the cases that genuinely need it — network filesystems, some container
 * bind-mounts — via VAULT_WATCH_POLL_INTERVAL_MS.
 */
function defaultPollIntervalMs(): number {
  const raw = process.env["VAULT_WATCH_POLL_INTERVAL_MS"];
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  // A malformed value must not silently re-enable a CPU-burning poll loop.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private pendingDrain = false;
  private firstScheduledAt: number | null = null;
  private stopped = false;
  constructor(private opts: VaultWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const pollInterval = this.opts.pollIntervalMs ?? defaultPollIntervalMs();
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
      this.watcher!.on('ready', () => setTimeout(resolve, WATCH_SETTLE_MS));
    });
  }

  private scheduleDrain(): void {
    const now = Date.now();
    if (this.firstScheduledAt === null) this.firstScheduledAt = now;
    if (this.timer) clearTimeout(this.timer);
    // Trailing debounce, capped by maxWaitMs so a continuous edit stream can't
    // defer indexing forever. Once the cap is hit the next tick fires at once.
    const maxWait = this.opts.maxWaitMs ?? Math.max(this.opts.debounceMs * 5, 5000);
    const elapsed = now - this.firstScheduledAt;
    const wait = Math.max(0, Math.min(this.opts.debounceMs, maxWait - elapsed));
    this.timer = setTimeout(() => void this.drain(), wait);
  }

  private async drain(): Promise<void> {
    // In-flight guard: never run two onBatch passes concurrently. If a drain
    // fires while one is running, defer it — the running pass reschedules on
    // completion when new events have arrived.
    if (this.draining) {
      this.pendingDrain = true;
      return;
    }
    this.timer = null;
    this.firstScheduledAt = null;
    const batch = [...this.dirty].sort();
    this.dirty.clear();
    if (batch.length === 0) return;
    this.draining = true;
    try {
      await this.opts.onBatch(batch);
    } catch (err) {
      getLoggerSafe().warn('[VaultWatcher] onBatch threw', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.draining = false;
      // Events that arrived during onBatch (a deferred tick, or freshly enqueued
      // paths) get a fresh drain — unless we're shutting down.
      if (!this.stopped && (this.pendingDrain || this.dirty.size > 0)) {
        this.pendingDrain = false;
        this.scheduleDrain();
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
    if (this.dirty.size && !this.draining) await this.drain();
  }
}

