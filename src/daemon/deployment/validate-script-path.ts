/**
 * Shared script path validation utility.
 *
 * Prevents directory traversal by ensuring the resolved path stays
 * within the project root. Verifies the file exists and is executable.
 */

import { accessSync, realpathSync, constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Validate a script path against the project root.
 * Prevents directory traversal (including symlink escapes) and checks file is executable.
 * @returns The fully resolved script path.
 * @throws If the path escapes the project root or the file is not executable.
 */
export function validateScriptPath(scriptPath: string, projectRoot: string): string {
  const normalizedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(normalizedRoot, scriptPath);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error(`Script path traversal detected: "${scriptPath}" resolves outside project root`);
  }

  try {
    accessSync(resolved, fsConstants.X_OK);
  } catch {
    throw new Error(`Script not found or not executable: "${resolved}"`);
  }

  // Resolve symlinks and verify real path stays within project root (best-effort)
  try {
    const realPath = realpathSync(resolved);
    if (!realPath.startsWith(normalizedRoot + path.sep) && realPath !== normalizedRoot) {
      throw new Error(`Script path traversal via symlink: "${scriptPath}" resolves to "${realPath}" outside project root`);
    }
    return realPath;
  } catch (err) {
    // Re-throw symlink traversal errors
    if (err instanceof Error && err.message.includes("traversal via symlink")) throw err;
    // If realpathSync fails (e.g., race condition), fall back to resolved path
    return resolved;
  }
}
