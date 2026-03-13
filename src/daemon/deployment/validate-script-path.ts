/**
 * Shared script path validation utility.
 *
 * Prevents directory traversal by ensuring the resolved path stays
 * within the project root. Verifies the file exists and is executable.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Validate a script path against the project root.
 * Prevents directory traversal and checks file is executable.
 * @returns The fully resolved script path.
 * @throws If the path escapes the project root or the file is not executable.
 */
export function validateScriptPath(scriptPath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, scriptPath);

  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new Error(`Script path traversal detected: "${scriptPath}" resolves outside project root`);
  }

  try {
    accessSync(resolved, fsConstants.X_OK);
  } catch {
    throw new Error(`Script not found or not executable: "${resolved}"`);
  }

  return resolved;
}
