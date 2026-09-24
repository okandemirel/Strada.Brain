/**
 * Permission faults for tests that must also hold as root.
 *
 * `chmod` is the real fault, and wherever the kernel enforces it the tests use
 * it. Root ignores permission bits (Docker CI images, root dev containers) and
 * Windows has no POSIX modes, so there a test raises the same EACCES at the
 * call the code under test makes instead: the scenario still runs, it is not
 * skipped.
 */
import { sep } from "node:path";

/** False as root and on Windows, where `chmod 000` makes nothing unreadable. */
export const kernelEnforcesPermissions: boolean =
  process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0);

/** The error a permission-denied syscall raises, shaped as Node shapes it. */
export function permissionDenied(syscall: string, target: unknown): NodeJS.ErrnoException {
  const path = String(target);
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${path}'`), {
    code: "EACCES",
    errno: -13,
    syscall,
    path,
  });
}

/** True when `candidate` is `root` itself or a path below it. */
export function isAtOrUnder(candidate: unknown, root: string): boolean {
  const path = String(candidate);
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
