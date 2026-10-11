/**
 * When a Strada package directory is a package, and when it is only a path.
 *
 * A clone made without --recurse-submodules leaves every gitlink path an empty
 * directory, and Packages/manifest.json still points at it. Unity cannot load
 * a `file:` package that has no package.json, so the directory proves nothing.
 * Counted as installed, it made the doctor print [OK] Strada.Core, skipped the
 * setup flow, and named the empty directory to the agent as the framework's
 * authoritative source (audit security-config#2).
 *
 * strada-deps (is it installed?) and module-folders (can its module layout be
 * read?) both answer from this one reading, so neither one calls installed what
 * the other calls an incomplete checkout.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** What finishes a checkout that was cloned without its submodules. */
export const SUBMODULE_INIT_COMMAND = "git submodule update --init --recursive";

/** A package directory without the package.json Unity loads it by. */
export function isIncompleteCheckout(
  dir: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return !exists(join(dir, "package.json"));
}
