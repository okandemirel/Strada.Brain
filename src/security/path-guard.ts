import { realpath, stat } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path, { basename, resolve, sep, isAbsolute, join, relative } from "node:path";

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
  // Home-directory credential stores (audit 2026-10, security-config#5): this
  // list is shell_exec's only check on the files a command names and holds for
  // a path the user named outside the project, yet `cat ~/.docker/config.json`
  // passed it — as did the ChatGPT login this product uses (~/.codex/auth.json)
  // and the daemon's operator credential, which unlocks the operator routes.
  /(?:^|[/\\])\.aws[/\\](?:credentials|config)$/i,
  /(?:^|[/\\])\.git-credentials$/i,
  /(?:^|[/\\])git[/\\]credentials$/i,
  /(?:^|[/\\])\.docker[/\\]config\.json$/i,
  /(?:^|[/\\])\.kube[/\\]config$/i,
  /(?:^|[/\\])gh[/\\]hosts\.ya?ml$/i,
  /(?:^|[/\\])\.pgpass$/i,
  /(?:^|[/\\])\.codex[/\\]auth\.json$/i,
  /(?:^|[/\\])opencode[/\\]auth\.json$/i,
  /(?:^|[/\\])\.strada[/\\]locks[/\\][^/\\]*\.operator\.json$/i,
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
const realRootCache = new Map<string, { real: string; dev: bigint; ino: bigint }>();

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
  const relativeInside = (root: string, target: string): string | undefined => {
    const inside = pathApi.relative(root, target);
    return inside === ".." || inside.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(inside) ? undefined : inside;
  };
  // Then in the real form: a macOS lease root is /var/…, and pwd, git and
  // build errors name the same directory /private/var/… (audit 2026-10).
  // Only on this platform's own paths: realpath cannot read a win32 path here.
  const inside =
    relativeInside(pathApi.resolve(projectPath), pathApi.resolve(cleaned)) ??
    (pathApi === path ? relativeInside(realpathOfNearest(projectPath), realpathOfNearest(cleaned)) : undefined);
  if (inside === undefined) {
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
 * root is not a lease. Cached while the owner file's size, mtime, ctime and
 * inode are what they were: mtime alone stayed put when the file was
 * replaced, or rewritten with its mtime put back, and the old checkout kept
 * being redirected into the lease.
 *
 * …and only once the file has settled. A filesystem stamps in ticks (NTFS
 * ~15.6 ms, HFS+ and ext3 a second, FAT two), so a lease path re-used for
 * another checkout inside one tick moves no stamp at all. As the evidence
 * ledger's digest memory does (windows-test 2f8041bc), an owner file that
 * changed less than a window before the read is read again next time.
 */
const LEASE_OWNER_FILE = ".strada-lease-owner.json";
const LEASE_OWNER_SETTLED_NS = 5_000_000_000n;
const leaseOwnerCache = new Map<string, { stamp: string; owner: string | undefined }>();
export function leaseOwnerRootOf(projectRoot: string): string | undefined {
  const file = join(projectRoot, LEASE_OWNER_FILE);
  // Taken before the stat, so a write that lands during this call counts as fresh.
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  let stamp: string;
  let changedNs: bigint;
  try {
    const st = statSync(file, { bigint: true });
    stamp = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
    changedNs = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
  } catch {
    return undefined;
  }
  const cached = lruGet(leaseOwnerCache, projectRoot);
  if (cached && cached.stamp === stamp) return cached.owner;
  let owner: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { projectRoot?: unknown };
    owner = typeof parsed.projectRoot === "string" && parsed.projectRoot.length > 0 ? resolve(parsed.projectRoot) : undefined;
  } catch {
    owner = undefined;
  }
  if (changedNs <= startedNs - LEASE_OWNER_SETTLED_NS) lruSet(leaseOwnerCache, projectRoot, { stamp, owner });
  else leaseOwnerCache.delete(projectRoot);
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
 * Where a tool given `rawPath` will land, relative to `projectRoot` and
 * "/"-separated, or undefined when that is the root itself or outside it.
 *
 * A rule about project layout has to judge this, not the spelling:
 * validatePath accepts an absolute path, a real-checkout path in a lease and a
 * detour through `..` alike, so each writes the same file as the plain
 * relative form. The root is compared in its lexical and its real form, since
 * /var/… and /private/var/… are one directory on macOS, where leases live.
 * Backslashes count as separators, as they do for a Windows checkout.
 */
export function projectRelativeTarget(projectRoot: string, rawPath: string): string | undefined {
  const spelled = rawPath.replace(/\\/g, "/");
  const target = resolve(projectRoot, redirectRealCheckoutPath(projectRoot, spelled) ?? spelled);
  const forms: Array<[string, string]> = [
    [resolve(projectRoot), target],
    [realpathOfNearest(projectRoot), realpathOfNearest(target)],
  ];
  for (const [root, full] of forms) {
    const rel = relative(root, full);
    if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return rel.split(sep).join("/");
    }
  }
  return undefined;
}

/**
 * The realpath of `p`, or of its nearest existing ancestor with the rest re-attached.
 * The native realpath, as validatePath's: the JS one keeps the letter case it
 * was given, so on macOS `.../proj/Assets/X.cs` under a `.../Proj` root was
 * "outside" here while validatePath landed it inside (review 2026-10).
 */
function realpathOfNearest(p: string): string {
  const rest: string[] = [];
  for (let current = resolve(p); ; ) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolve(p);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The realpath of `projectRoot`: cached while the root still names the same
 * directory (dev/ino), re-resolved otherwise. Throws when it does not exist.
 */
async function resolveRealRoot(projectRoot: string): Promise<string> {
  let current: { dev: bigint; ino: bigint };
  try {
    // bigint: a Windows file id is 64 bits and loses precision as a double,
    // so two different directories could compare equal and a root re-pointed
    // at another directory kept resolving to the old one.
    current = await stat(projectRoot, { bigint: true });
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

/** `start` or its nearest existing ancestor, up to AND including the filesystem root, with its realpath. */
async function deepestExistingAncestor(start: string): Promise<{ path: string; real: string } | undefined> {
  for (let current = start; ; ) {
    try {
      return { path: current, real: await realpath(current) };
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

  // realFullPath is what the caller gets: the realpath of an existing target,
  // the path as resolved for a new one. realTarget is where it lands in real
  // form, which is what containment is judged on (see below).
  let realFullPath: string;
  let realTarget: string;
  try {
    realFullPath = realTarget = await realpath(rawFullPath);
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
      realTarget = join(realParent, basename(rawFullPath));
    } catch {
      // Parent doesn't exist: judge containment by the deepest ancestor that
      // DOES exist. The walk used to stop one short of the filesystem root, so
      // a path whose only existing ancestor was the root (a drive root on
      // Windows, where there is no /etc) was never compared with the project
      // and came back "Parent directory does not exist" instead of the
      // confinement refusal. No existing ancestor at all is outside, too.
      const ancestor = await deepestExistingAncestor(resolve(rawFullPath, ".."));
      if (ancestor === undefined || !isInsideOrEqual(realRoot, ancestor.real)) {
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
      // missing components cannot be symlinks, so the real ancestor plus that
      // tail is where the file lands.
      if (!options.allowMissingParents) {
        return {
          valid: false,
          fullPath: rawFullPath,
          error: "Parent directory does not exist",
        };
      }
      realFullPath = rawFullPath;
      realTarget = join(ancestor.real, relative(ancestor.path, rawFullPath));
    }
  }

  // Containment is judged in the real form, against the real root. A target
  // whose realpath came back unchanged was compared with the LEXICAL root, so
  // with a root reached through a symlink — every macOS lease, /var being
  // /private/var — an in-project path written the way pwd, git and build
  // errors print it was refused as outside the directory it named (audit
  // 2026-10). The lexical test guarded nothing the real one does not: inside
  // the lexical root but outside the real one is a symlink escape.
  if (!isInsideOrEqual(realRoot, realTarget)) {
    return {
      valid: false,
      fullPath: realFullPath,
      error: outsideProjectError(projectRoot),
    };
  }

  // Check against sensitive file patterns; a new file in both forms, the one
  // it is written through and the one it lands at (Assets/keys/x, with keys a
  // symlink to .ssh, is .ssh/x).
  for (const candidate of realTarget === realFullPath ? [realFullPath] : [realFullPath, realTarget]) {
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(candidate))) {
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
