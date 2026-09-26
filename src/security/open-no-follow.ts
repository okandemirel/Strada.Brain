import { lstat, open, type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

/** O_NOFOLLOW where the platform has it; Windows has none (see openNoFollow). */
const NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

function followRefusal(fullPath: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `ELOOP: refusing to open through a symbolic link, or a file that changed while it was opened: ${fullPath}`,
  );
  err.code = "ELOOP";
  err.path = fullPath;
  return err;
}

/**
 * Open `fullPath` without following a symbolic link in its FINAL component, on
 * every platform. Throws an ELOOP error when the path is (or becomes) a link.
 *
 * O_NOFOLLOW alone was the defence, and Windows has no O_NOFOLLOW: there the
 * open followed a link swapped in after the path was validated, and a write
 * landed in a file outside the project. So, everywhere:
 *   1. the path is lstat'ed first, and a link there is refused before
 *      anything is created, opened or truncated through it;
 *   2. after the open, the file the handle holds must be the very entry that
 *      is at the path (same dev/ino, not a link) — which catches a link
 *      swapped in between the lstat and the open;
 *   3. O_TRUNC is deferred until (2) has passed, so a followed link can
 *      never empty the file it points at.
 * O_NOFOLLOW is still added where it exists; the checks cost two stats.
 */
export async function openNoFollow(fullPath: string, flags: number, mode?: number): Promise<FileHandle> {
  const before = await lstat(fullPath).catch(() => undefined);
  if (before?.isSymbolicLink()) throw followRefusal(fullPath);

  const truncate = (flags & fsConstants.O_TRUNC) !== 0;
  const handle = await open(fullPath, (flags & ~fsConstants.O_TRUNC) | NOFOLLOW_FLAG, mode);
  try {
    const [opened, atPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(fullPath, { bigint: true }),
    ]);
    if (atPath.isSymbolicLink() || opened.dev !== atPath.dev || opened.ino !== atPath.ino) {
      throw followRefusal(fullPath);
    }
    if (truncate) await handle.truncate(0);
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
