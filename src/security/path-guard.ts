import { realpath } from "node:fs/promises";
import { resolve, sep, normalize, isAbsolute } from "node:path";

/**
 * Sensitive file patterns that should never be accessed through tools,
 * even if they are within the project directory.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\.env$/i,
  /\.env\.[a-z]+$/i,
  /\.git[/\\]config$/i,
  /\.git[/\\]credentials$/i,
  /credentials\.json$/i,
  /secrets?\.json$/i,
  /secrets?\.ya?ml$/i,
  /\.ssh[/\\]/i,
  /node_modules[/\\]/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /keystore\.properties$/i,
  /google-services\.json$/i,
  /GoogleService-Info\.plist$/i,
  /\.npmrc$/i,
  /\.netrc$/i,
];

export interface PathValidationResult {
  valid: boolean;
  fullPath: string;
  error?: string;
}

// Cache resolved project root to avoid repeated realpath() syscalls
const realRootCache = new Map<string, string>();

/**
 * Resolve a relative path against the project root and validate it is safe to access.
 *
 * Security checks:
 *  1. Uses realpath() to resolve symlinks — prevents symlink escape attacks
 *  2. Trailing separator check — prevents prefix collision (/project vs /project-evil)
 *  3. Sensitive file blocklist — prevents access to .env, .git/config, credentials, etc.
 */

/**
 * Normalize a tool-supplied path to be relative to the project root.
 * Handles absolute paths that fall inside the project (strips prefix)
 * and cleans up redundant separators / `.` segments.
 * Returns `{ ok: true, relativePath }` or `{ ok: false, error }`.
 */
export function normalizeToolPathInput(
  projectPath: string,
  rawInput: string,
): { ok: true; relativePath: string } | { ok: false; error: string } {
  let cleaned = normalize(rawInput);

  if (isAbsolute(cleaned)) {
    const root = projectPath.endsWith("/") ? projectPath : projectPath + "/";
    if (cleaned === projectPath || cleaned.startsWith(root)) {
      cleaned = cleaned.slice(projectPath.length).replace(/^\/+/, "") || ".";
    } else {
      return { ok: false, error: "Absolute path is outside the project directory" };
    }
  }

  return { ok: true, relativePath: cleaned };
}

export interface ValidatePathOptions {
  /**
   * Accept a target whose parent directories do not exist yet, provided the
   * deepest ancestor that DOES exist is inside the project. For a caller that
   * is about to `mkdir -p`, a missing parent is the normal case, not an error.
   *
   * Off by default so read paths keep their existing semantics.
   */
  readonly allowMissingParents?: boolean;
}

/**
 * The refusal, with the boundary it is talking about.
 *
 * Measured 2026-08-21: an agent working inside a workspace lease worked out
 * for itself that two copies of the project existed and tried to list the
 * lease directory to find its own. It was told "Path resolves outside the
 * project directory" and nothing else — a refusal that withholds the one fact
 * that answers it. Naming the root turns a dead end into a redirection.
 */
function outsideProjectError(projectRoot: string): string {
  return `Path resolves outside the project directory (${resolve(projectRoot)})`;
}

export async function validatePath(
  projectRoot: string,
  relativePath: string,
  options: ValidatePathOptions = {}
): Promise<PathValidationResult> {
  if (!relativePath) {
    return { valid: false, fullPath: "", error: "Path is required" };
  }

  // Reject null bytes (defense-in-depth; Node.js also throws on null bytes)
  if (relativePath.includes("\0")) {
    return { valid: false, fullPath: "", error: "Path contains invalid characters" };
  }

  const rawFullPath = resolve(projectRoot, relativePath);

  // Resolve symlinks for project root (cached since it doesn't change)
  let realRoot = realRootCache.get(projectRoot);
  if (!realRoot) {
    try {
      realRoot = await realpath(projectRoot);
      realRootCache.set(projectRoot, realRoot);
    } catch {
      return {
        valid: false,
        fullPath: rawFullPath,
        error: "Project root does not exist",
      };
    }
  }

  let realFullPath: string;
  try {
    realFullPath = await realpath(rawFullPath);
  } catch {
    // If the target doesn't exist yet (e.g., for writes), validate the parent
    const parentDir = resolve(rawFullPath, "..");
    try {
      const realParent = await realpath(parentDir);
      if (
        realParent !== realRoot &&
        !realParent.startsWith(realRoot + sep)
      ) {
        return {
          valid: false,
          fullPath: rawFullPath,
          error: outsideProjectError(projectRoot),
        };
      }
      // Parent is valid; use the raw resolved path for the new file
      realFullPath = rawFullPath;
    } catch {
      // Parent doesn't exist - check if this is because the path escapes the project
      // Walk up the directory tree to find the first existing ancestor
      let currentPath = resolve(rawFullPath, "..");
      let foundExistingAncestor = false;
      
      while (currentPath !== resolve(currentPath, "..")) {
        try {
          const realCurrent = await realpath(currentPath);
          // Found an existing ancestor - check if it's within project
          if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + sep)) {
            return {
              valid: false,
              fullPath: rawFullPath,
              error: outsideProjectError(projectRoot),
            };
          }
          foundExistingAncestor = true;
          break;
        } catch {
          // This path component doesn't exist, go up one level
          currentPath = resolve(currentPath, "..");
        }
      }
      
      // If we walked all the way to root without finding anything,
      // or ended up outside the project
      if (!foundExistingAncestor || (currentPath !== realRoot && !currentPath.startsWith(realRoot + sep))) {
        // Double-check: if we reached project root via walking, it's valid (just missing parent)
        // If we ended up elsewhere, it's outside
        if (!foundExistingAncestor && currentPath === resolve(realRoot, "..")) {
          // Walked up past project root - path is outside
          return {
            valid: false,
            fullPath: rawFullPath,
            error: outsideProjectError(projectRoot),
          };
        }
      }

      // The walk above already did the security work: it realpath'd the deepest
      // EXISTING ancestor and confirmed it sits inside the project root. The
      // components below it do not exist, so they cannot be symlinks, and `..`
      // was resolved before the walk began — the target is provably contained.
      // The loop's own comment says as much ("it's valid (just missing
      // parent)"), and then the code rejected it anyway.
      //
      // Cost of that contradiction, measured: file_write could not create a
      // file in a directory that did not already exist. An agent asked for a
      // layered set of scripts made 42 write attempts, 38 were refused with
      // "Parent directory does not exist", and it ended up cramming every type
      // into the one file that happened to sit in an existing directory.
      //
      // Audited 2026-09-02: this branch used to `return { valid: true }` right
      // here, ABOVE the BLOCKED_PATTERNS loop — so `Assets/.env` was refused
      // while `Assets/Config/.env` (Config not yet created) was accepted and
      // file_write then mkdir -p'd the chain and put the secret on disk. The
      // walk proves containment, not harmlessness: fall through to the shared
      // tail so the blocklist is consulted like every other accepted path. The
      // missing components cannot be symlinks, so rawFullPath is the right
      // string to test.
      if (!(options.allowMissingParents && foundExistingAncestor)) {
        return {
          valid: false,
          fullPath: rawFullPath,
          error: "Parent directory does not exist",
        };
      }
      realFullPath = rawFullPath;
    }
  }

  // Check that path is within project root (with trailing separator to avoid prefix collision)
  if (realFullPath !== rawFullPath) {
    // Path was resolved by realpath (existing file) — verify against realpath'd root
    if (
      realFullPath !== realRoot &&
      !realFullPath.startsWith(realRoot + sep)
    ) {
      return {
        valid: false,
        fullPath: realFullPath,
        error: outsideProjectError(projectRoot),
      };
    }
  } else {
    // New file (realpath failed, parent was validated above) or no-symlink system.
    // Verify against the raw (un-symlinked) project root to catch traversal on Linux.
    const rawRoot = resolve(projectRoot);
    if (
      rawFullPath !== rawRoot &&
      !rawFullPath.startsWith(rawRoot + sep)
    ) {
      return {
        valid: false,
        fullPath: rawFullPath,
        error: outsideProjectError(projectRoot),
      };
    }
  }

  // Check against sensitive file patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(realFullPath)) {
      return {
        valid: false,
        fullPath: realFullPath,
        error: "Access to sensitive files is not permitted",
      };
    }
  }

  return { valid: true, fullPath: realFullPath };
}

/**
 * Validate a C# identifier to prevent code injection in generated files.
 * Allows dotted names for namespaces (e.g., "Game.Modules.Combat").
 */
export function isValidCSharpIdentifier(name: string, allowDots = false): boolean {
  if (!name || name.length > 256) return false;

  const pattern = allowDots
    ? /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
    : /^[A-Za-z_][A-Za-z0-9_]*$/;

  return pattern.test(name);
}

/**
 * Validate a C# type name, which may include generic arguments (e.g., "float3", "List<int>").
 */
export function isValidCSharpType(typeName: string): boolean {
  if (!typeName || typeName.length > 256) return false;

  // Block characters that could inject code
  if (/[;{}()=]/.test(typeName)) return false;

  // Reject newlines/carriage returns (prevent multi-line injection)
  if (/[\n\r]/.test(typeName)) return false;

  // Allow basic type names, generics, and array types (literal space only, not \s)
  return /^[A-Za-z_][A-Za-z0-9_<>, \[\].?]*$/.test(typeName);
}
