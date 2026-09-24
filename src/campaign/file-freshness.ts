/**
 * "Was this file written during the attempt?" — the one mtime rule every
 * campaign evidence reader applies (NUnit run record, play-through verdict,
 * capture frames).
 *
 * A file's mtime is stamped from the kernel's COARSE clock, which advances
 * once per scheduler tick, while `Date.now()` is the precise clock. A file
 * written right after the attempt began can therefore read OLDER than the
 * attempt: measured on Linux ext4 at 0.2–6.2 ms in 2000 of 2000 writes, and a
 * tick is up to 10 ms at HZ=100 and ~15.6 ms on Windows. The earlier 2 ms
 * allowance (blamed on utimes rounding) called fresh proofs stale on about one
 * delivery in ten on Linux CI; it passed on macOS, whose timestamps are exact.
 *
 * 50 ms is a few ticks on every platform we run on, and far below the gap
 * between a real earlier attempt's write and the next attempt's start
 * (a player build and run, i.e. minutes). It does NOT widen what counts as
 * this attempt's result: a copied or touched record is still refused by its
 * own `measuredAt` stamp and run id.
 */
export const FILE_MTIME_TOLERANCE_MS = 50;

/** True when a file's mtime says it was written before the attempt began. */
export function writtenBefore(mtimeMs: number, sinceMs: number): boolean {
  return mtimeMs + FILE_MTIME_TOLERANCE_MS < sinceMs;
}
