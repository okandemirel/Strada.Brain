import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

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
export async function validatePath(
  projectRoot: string,
  relativePath: string
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
          error: "Path resolves outside the project directory",
        };
      }
      // Parent is valid; use the raw resolved path for the new file
      realFullPath = rawFullPath;
    } catch {
      return {
        valid: false,
        fullPath: rawFullPath,
        error: "Parent directory does not exist",
      };
    }
  }

  // Check that path is within project root (with trailing separator to avoid prefix collision)
  if (
    realFullPath !== realRoot &&
    !realFullPath.startsWith(realRoot + sep)
  ) {
    return {
      valid: false,
      fullPath: realFullPath,
      error: "Path resolves outside the project directory",
    };
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
