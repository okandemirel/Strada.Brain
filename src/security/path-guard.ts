import { realpath, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import path, { resolve, sep, isAbsolute, join, relative } from "node:path";

/**
 * Sensitive file patterns that should never be accessed through tools,
 * even if they are within the project directory.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  // The lease's ownership/seed sidecars are the lease manager's, not the
  // agent's: review 2026-09-08 showed a forged seed map could make salvage
  // overwrite a user's edit or delete a user's file.
  /(?:^|[/\\])\.strada-lease-(?:owner|seed)\.json$/i,
  // Audited 2026-09-02: this was `/\.env$/` plus `/\.env\.[a-z]+$/`, which
  // required exactly one all-alpha suffix — so `.env.production.local`,
  // `.env.dev2`, `.env.staging-eu` and the two backup names this repo already
  // pushed a live key in (`.env.bak.191546`, `.env.backup-loglevel`, see
  // .gitignore) were readable in full. Any chain of dot-separated suffixes
  // after `.env` is now blocked; `.envrc` / `Env.cs` are still allowed.
  // Two rules, because one regex cannot express both dotenv families without
  // also swallowing project files. A rejected round-2 attempt anchored on the
  // basename START, which silently unblocked the whole `<name>.env` family
  // (prod.env, secrets.env, config/local.env) — a security regression
  // (audited 2026-09-02).
  //   (a) a basename that IS .env plus any suffix chain: .env, .env.local,
  //       .env.production.local, .env.bak.191546
  /(?:^|[/\\])\.env(\.[A-Za-z0-9_-]+)*$/i,
  //   (b) a basename ENDING in .env: prod.env, staging.env, local.env
  /(?:^|[/\\])[^/\\]*\.env$/i,
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
  /** Set when an absolute path into the lease's real checkout was rewritten into the lease. */
  redirectedFrom?: string;
}

/**
 * Does this absolute path match the sensitive-file blocklist?
 *
 * Exposed so a caller that relaxes CONFINEMENT (a file the user named outside
 * the project) can still honour the blocklist — the two are separate
 * guarantees, and validatePath only reaches the blocklist for paths that
 * already passed confinement. Audited 2026-09-02.
 */
export function isSensitivePath(absolutePath: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(absolutePath));
}

/**
 * SEC-23: the path-guard caches are keyed by project root, and every task
 * lease is a new root, so a long-running daemon added an entry per lease
 * forever. Both caches are LRU-capped at this many roots.
 */
export const PATH_GUARD_CACHE_MAX_ROOTS = 256;

/** Read `key`, refreshing its recency (Map order is least-recently-used first). */
function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function lruSet<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > PATH_GUARD_CACHE_MAX_ROOTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Cache resolved project root to avoid repeated realpath() syscalls. The
 * root's identity (dev/ino) is kept with it: a root that was removed, or
 * recreated as something else, is re-resolved instead of reusing its old
 * realpath (SEC-23).
 */
const realRootCache = new Map<string, { real: string; dev: number; ino: number }>();

/** Number of roots each path-guard cache holds (tests). */
export function pathGuardCacheSizes(): { realRoots: number; leaseOwners: number } {
  return { realRoots: realRootCache.size, leaseOwners: leaseOwnerCache.size };
}

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
  pathApi: path.PlatformPath = path,
): { ok: true; relativePath: string } | { ok: false; error: string } {
  const cleaned = pathApi.normalize(rawInput);
  if (!pathApi.isAbsolute(cleaned)) return { ok: true, relativePath: cleaned };

  // path.relative, not a "/" prefix test: on Windows the root is `C:\proj`
  // (and may differ in case), so a hardcoded "/" refused every absolute
  // in-project path (review SEC-17).
  const inside = pathApi.relative(pathApi.resolve(projectPath), pathApi.resolve(cleaned));
  if (inside === ".." || inside.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(inside)) {
    return { ok: false, error: "Absolute path is outside the project directory" };
  }
  return { ok: true, relativePath: inside || "." };
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

/**
 * The real checkout a workspace lease was seeded from, read from the
 * lease's owner file (written by the lease manager), or undefined when the
 * root is not a lease. Cached by the owner file's mtime.
 */
const LEASE_OWNER_FILE = ".strada-lease-owner.json";
const leaseOwnerCache = new Map<string, { mtimeMs: number; owner: string | undefined }>();
export function leaseOwnerRootOf(projectRoot: string): string | undefined {
  const file = join(projectRoot, LEASE_OWNER_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = lruGet(leaseOwnerCache, projectRoot);
  if (cached && cached.mtimeMs === mtimeMs) return cached.owner;
  let owner: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { projectRoot?: unknown };
    owner = typeof parsed.projectRoot === "string" && parsed.projectRoot.length > 0 ? resolve(parsed.projectRoot) : undefined;
  } catch {
    owner = undefined;
  }
  lruSet(leaseOwnerCache, projectRoot, { mtimeMs, owner });
  return owner;
}

/**
 * An absolute path into the lease's REAL checkout, rewritten into the lease.
 * Measured 2026-09-08 07:17-07:27: five file_read/list_directory calls in
 * ten minutes refused as "outside the project directory" because the model
 * named the checkout it knows (/Users/…/PixelFlow-Clean/Assets/…) while the
 * run's project was its lease under the temp directory. The MCP tools have
 * redirected that case since 2026-09-07; the built-in tools refused it.
 */
export function redirectRealCheckoutPath(projectRoot: string, absolutePath: string): string | undefined {
  if (!isAbsolute(absolutePath)) return undefined;
  const owner = leaseOwnerRootOf(projectRoot);
  if (!owner) return undefined;
  const target = resolve(absolutePath);
  // An owner that IS the root already ends in the separator ("/" + "/" was
  // "//", and nothing under it matched — Codex review 2026-09-09).
  const ownerPrefix = owner.endsWith(sep) ? owner : owner + sep;
  if (target !== owner && !target.startsWith(ownerPrefix)) return undefined;
  const rel = relative(owner, target);
  return rel === "" ? "." : rel;
}

/**
 * The realpath of `projectRoot`: cached while the root still names the same
 * directory (dev/ino), re-resolved otherwise. Throws when it does not exist.
 */
async function resolveRealRoot(projectRoot: string): Promise<string> {
  let current: { dev: number; ino: number };
  try {
    current = await stat(projectRoot);
  } catch (err) {
    realRootCache.delete(projectRoot);
    throw err;
  }
  const cached = lruGet(realRootCache, projectRoot);
  if (cached && cached.dev === current.dev && cached.ino === current.ino) return cached.real;
  const real = await realpath(projectRoot);
  lruSet(realRootCache, projectRoot, { real, dev: current.dev, ino: current.ino });
  return real;
}

/** `candidate` is `root` or under it; a root that already ends in the separator ("/", a drive root) included. */
function isInsideOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The realpath of `start` or of its nearest existing ancestor, up to AND including the filesystem root. */
async function deepestExistingAncestor(start: string): Promise<string | undefined> {
  for (let current = start; ; ) {
    try {
      return await realpath(current);
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return undefined;
      current = parent;
    }
  }
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

  // The real checkout's path names the lease's twin (see redirectRealCheckoutPath).
  let redirectedFrom: string | undefined;
  const redirected = redirectRealCheckoutPath(projectRoot, relativePath);
  if (redirected !== undefined) {
    redirectedFrom = relativePath;
    relativePath = redirected;
  }

  const rawFullPath = resolve(projectRoot, relativePath);

  // Resolve symlinks for project root (cached while the root is the same directory)
  let realRoot: string;
  try {
    realRoot = await resolveRealRoot(projectRoot);
  } catch {
    return {
      valid: false,
      fullPath: rawFullPath,
      error: "Project root does not exist",
    };
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
      // Parent doesn't exist: judge containment by the deepest ancestor that
      // DOES exist. The walk used to stop one short of the filesystem root, so
      // a path whose only existing ancestor was the root (a drive root on
      // Windows, where there is no /etc) was never compared with the project
      // and came back "Parent directory does not exist" instead of the
      // confinement refusal. No existing ancestor at all is outside, too.
      const ancestor = await deepestExistingAncestor(resolve(rawFullPath, ".."));
      if (ancestor === undefined || !isInsideOrEqual(realRoot, ancestor)) {
        return {
          valid: false,
          fullPath: rawFullPath,
          error: outsideProjectError(projectRoot),
        };
      }

      // The walk above already did the security work: it realpath'd the deepest
      // EXISTING ancestor and confirmed it sits inside the project root. The
      // components below it do not exist, so they cannot be symlinks, and `..`
      // was resolved before the walk began — the target is provably contained.
      // The old loop's own comment said as much ("it's valid (just missing
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
      if (!options.allowMissingParents) {
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

  return redirectedFrom !== undefined
    ? { valid: true, fullPath: realFullPath, redirectedFrom }
    : { valid: true, fullPath: realFullPath };
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
