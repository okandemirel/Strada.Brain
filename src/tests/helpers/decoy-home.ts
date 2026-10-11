/**
 * The empty directory vitest.worker-setup.ts hands a test file as
 * os.homedir(), made under `<root>/user-home`.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Canonical, as a real home is: code under test realpaths a path under the
 * home and compares the result with homedir(), so both must be the same
 * string. macOS's temp root is /var → /private/var.
 *
 * The native realpath, the one fs/promises' realpath (the setup wizard's)
 * also is. The JS realpathSync resolves symlinks only and keeps every other
 * spelling it is given: on windows-test the run root sits in tmpdir()
 * C:\Users\RUNNER~1\…, which it left an 8.3 short name while the wizard
 * answered C:\Users\runneradmin\…; a TMPDIR in another letter case does the
 * same on macOS.
 */
export function newDecoyHome(root: string): string {
  const parent = join(root, "user-home");
  mkdirSync(parent, { recursive: true });
  return realpathSync.native(mkdtempSync(join(parent, "file-")));
}
