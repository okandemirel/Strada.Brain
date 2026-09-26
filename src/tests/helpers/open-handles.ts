/**
 * Open file handles, seen from Linux, for tests about Windows.
 *
 * A handle a store leaves open is harmless on POSIX (unlink succeeds, the inode
 * lives on) and fatal on Windows: the file cannot be deleted, renamed over or
 * restored (EBUSY) until the process exits. Linux CI would never see that
 * failure, so these tests count this process's descriptors on the file instead,
 * through /proc/self/fd. Where /proc is absent (macOS, Windows) the count reads
 * 0 and the platform's own cleanup failure is the check.
 */
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const FD_DIR = "/proc/self/fd";

/** The path a descriptor link would name for `file`, with symlinked parents resolved. */
function canonical(file: string): string {
  try {
    return join(realpathSync(dirname(file)), basename(file));
  } catch {
    return resolve(file);
  }
}

/**
 * Whether descriptors can be counted here at all. Where they cannot, a test's
 * "it is open now" precondition has nothing to read, and the cleanup's EBUSY
 * on Windows is what catches a handle left open.
 */
export function descriptorsObservable(): boolean {
  return existsSync(FD_DIR);
}

/** How many descriptors this process holds open on `file` (0 where it cannot be observed). */
export function openDescriptorsOn(file: string): number {
  let fds: string[];
  try {
    fds = readdirSync(FD_DIR);
  } catch {
    return 0;
  }
  const target = canonical(file);
  let count = 0;
  for (const fd of fds) {
    let link: string;
    try {
      link = readlinkSync(join(FD_DIR, fd));
    } catch {
      continue; // closed while we looked (the readdir's own descriptor, for one)
    }
    if (link === target || link === `${target} (deleted)`) count++;
  }
  return count;
}
