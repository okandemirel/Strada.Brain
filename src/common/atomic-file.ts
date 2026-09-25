/**
 * Crash-safe whole-file replacement, shared by the stores that rewrite a file
 * in one go (memory.json, the FileVectorStore pair, graph.canvas).
 *
 * `writeFile` truncates the target first, so a crash, a power loss or a second
 * writer in that window left a half-written file behind — and the loaders then
 * read it as "no data yet" and overwrote it (MEM-13). Here the bytes go to a
 * uniquely named sibling, are fsync'd and renamed over the target: a reader sees
 * the old file or the new one, never a mix, and two concurrent writers can no
 * longer interleave inside one shared temp file (MEM-15).
 *
 * On Windows a rename over a file that another process (antivirus, indexer, an
 * editor) holds open fails with EPERM/EACCES/EBUSY for a moment; that is retried
 * briefly before giving up.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Attempts in total; the waits between them grow 20, 40, 80, 160, 320 ms. */
const RENAME_ATTEMPTS = 6;
const RENAME_BASE_DELAY_MS = 20;

let tmpCounter = 0;

function tempPathFor(target: string): string {
  tmpCounter += 1;
  return `${target}.${process.pid}.${tmpCounter}.${randomBytes(4).toString("hex")}.tmp`;
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_RENAME_CODES.has(code);
}

function retryDelayMs(attempt: number): number {
  return RENAME_BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !isTransientRenameError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !isTransientRenameError(error)) throw error;
      sleepSync(retryDelayMs(attempt));
    }
  }
}

export interface AtomicWriteOptions {
  /** File mode for a newly created target (default 0o666, minus the umask). */
  mode?: number;
}

/** Replace `target` with `data` atomically (temp sibling + fsync + rename). Strings are written as UTF-8. */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = tempPathFor(target);
  try {
    const handle = await open(tmp, "wx", options.mode ?? 0o666);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Synchronous {@link writeFileAtomic}, for stores whose flush is synchronous. */
export function writeFileAtomicSync(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const tmp = tempPathFor(target);
  try {
    const fd = openSync(tmp, "wx", options.mode ?? 0o666);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetrySync(tmp, target);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort: the original error is the one worth reporting.
    }
    throw error;
  }
}

/** `<path>.corrupt-<timestamp>`; the timestamp avoids ':' so the name is valid on Windows. */
export function corruptFilePath(path: string, now: Date = new Date()): string {
  return `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Move a file that could not be loaded out of the way, so the store's next
 * save cannot overwrite the only copy of the data. Returns where it went, or
 * null when the move itself failed.
 */
export async function moveAsideCorruptFile(path: string): Promise<string | null> {
  const aside = corruptFilePath(path);
  try {
    await renameWithRetry(path, aside);
    return aside;
  } catch {
    return null;
  }
}

/** Synchronous {@link moveAsideCorruptFile}. */
export function moveAsideCorruptFileSync(path: string): string | null {
  const aside = corruptFilePath(path);
  try {
    renameWithRetrySync(path, aside);
    return aside;
  } catch {
    return null;
  }
}
