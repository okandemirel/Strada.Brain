import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { VaultFile } from './vault.interface.js';

export const IGNORE_DIRS = new Set([
  'Library',
  'Temp',
  'Logs',
  'obj',
  'bin',
  '.git',
  'node_modules',
  '.strada',
  '.obsidian',
]);
export const MAX_INDEXABLE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_VAULT_ROOT_PATH_LENGTH = 1024;

export const EXT_LANG: Record<string, VaultFile['lang']> = {
  '.cs': 'csharp', '.ts': 'typescript', '.tsx': 'typescript',
  '.md': 'markdown', '.json': 'json',
  '.hlsl': 'hlsl', '.shader': 'hlsl', '.cginc': 'hlsl',
};

const JSON_SECRET_BASENAME = /^(appsettings.*|\.env.*|secrets?.*|credentials?.*|.*\.secrets\..*|.*\.credentials\..*)\.json$/i;
const SECRET_BASENAME = /^(\.env.*|secrets?.*|credentials?.*)$/i;

export function isSecretLikeJson(name: string): boolean {
  return JSON_SECRET_BASENAME.test(name);
}

export function normalizeVaultRelPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function rejectAbsoluteVaultPath(path: string): void {
  if (isAbsolute(path) || path.replaceAll('\\', '/').startsWith('/')) {
    throw new Error(`path escapes vault root: ${path}`);
  }
}

export function isIgnoredVaultPath(relPath: string): boolean {
  const parts = normalizeVaultRelPath(relPath).split('/').filter(Boolean);
  return parts.some((part) => IGNORE_DIRS.has(part));
}

export function langForVaultPath(relPath: string): VaultFile['lang'] | undefined {
  return EXT_LANG[extname(relPath).toLowerCase()];
}

export function isSecretLikeVaultPath(relPath: string): boolean {
  const name = basename(normalizeVaultRelPath(relPath));
  return SECRET_BASENAME.test(name) || isSecretLikeJson(name);
}

export function isPotentiallyIndexableVaultPath(relPath: string): boolean {
  if (isIgnoredVaultPath(relPath) || isSecretLikeVaultPath(relPath)) return false;
  return langForVaultPath(relPath) !== undefined;
}

export function isIndexableVaultPath(relPath: string, sizeBytes: number): boolean {
  return isPotentiallyIndexableVaultPath(relPath) && sizeBytes <= MAX_INDEXABLE_FILE_BYTES;
}

export function validateSafeVaultWriteRelPath(relPath: string, contentBytes: number): string {
  rejectAbsoluteVaultPath(relPath);
  const normalized = normalizeVaultRelPath(relPath);
  if (!isIndexableVaultPath(normalized, contentBytes)) {
    throw new Error(`vault path is not allowed: ${relPath}`);
  }
  return normalized;
}

export async function getIndexableFileInfo(
  rootPath: string,
  relPath: string,
): Promise<
  | { ok: true; absPath: string; relPath: string; size: number; mtimeMs: number; lang: VaultFile['lang'] }
  | { ok: false; relPath: string; reason: string }
> {
  if (isAbsolute(relPath) || relPath.replaceAll('\\', '/').startsWith('/')) {
    return { ok: false, relPath, reason: 'absolute path' };
  }
  const normalized = normalizeVaultRelPath(relPath);
  if (!isPotentiallyIndexableVaultPath(normalized)) {
    return { ok: false, relPath: normalized, reason: 'not indexable' };
  }
  const absPath = resolveInsideVault(rootPath, normalized);
  try {
    // Optimization: lstat the leaf FIRST. If the leaf doesn't exist (or isn't
    // a file) we save N filesystem syscalls for ancestor lstats that would
    // never matter. Only walk ancestors once we know the leaf is real.
    const linkStats = await lstat(absPath);
    if (linkStats.isSymbolicLink()) return { ok: false, relPath: normalized, reason: 'symlink' };
    if (!linkStats.isFile()) return { ok: false, relPath: normalized, reason: 'not a file' };
    if (!isIndexableVaultPath(normalized, linkStats.size)) {
      return { ok: false, relPath: normalized, reason: 'not indexable' };
    }
    // Walk ancestors after the leaf check: a symlink directory anywhere
    // between root and the final file would let an attacker escape the vault
    // even when the leaf itself is a regular file. lstat() on the leaf alone
    // cannot catch this.
    if (await hasSymlinkAncestor(rootPath, absPath)) {
      return { ok: false, relPath: normalized, reason: 'symlink-ancestor' };
    }
    await assertRealpathInside(rootPath, absPath);
    if (await isLikelyBinaryFile(absPath)) {
      return { ok: false, relPath: normalized, reason: 'binary-content' };
    }
    const lang = langForVaultPath(normalized);
    if (!lang) return { ok: false, relPath: normalized, reason: 'unsupported extension' };
    return {
      ok: true,
      absPath,
      relPath: normalized,
      size: linkStats.size,
      mtimeMs: linkStats.mtimeMs,
      lang,
    };
  } catch {
    return { ok: false, relPath: normalized, reason: 'missing' };
  }
}

/**
 * Returns true if any directory between `rootPath` (exclusive) and `absPath`
 * (exclusive) is a symbolic link. The leaf itself is intentionally not
 * inspected — callers already lstat() the leaf separately.
 *
 * Pre-condition: `absPath` must already be confirmed to live inside
 * `rootPath` via `resolveInsideVault`.
 */
export async function hasSymlinkAncestor(rootPath: string, absPath: string): Promise<boolean> {
  const rel = relative(rootPath, absPath);
  if (!rel || rel === '.' || rel.startsWith('..')) return false;
  const segments = rel.split(sep).filter((s) => s.length > 0);
  // Drop the leaf; only intermediate directories matter for ancestor checks.
  segments.pop();
  let current = rootPath;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return true;
    } catch {
      // Missing ancestor cannot leak data; treat as non-symlink and let the
      // downstream lstat on the leaf fail naturally.
      return false;
    }
  }
  return false;
}

const BINARY_SAMPLE_BYTES = 8 * 1024;
const REPLACEMENT_CHAR_THRESHOLD = 5;

/**
 * Heuristic binary detector. Reads the first 8KB and flags the file as binary
 * if it contains any NUL byte OR fails strict UTF-8 decoding OR contains too
 * many U+FFFD replacement characters after a lossy decode.
 *
 * P2 fix: the previous version flagged any sample with >30% bytes >= 0x80 as
 * binary. UTF-8 Turkish / Japanese / Korean / Chinese markdown comfortably
 * exceeds 30% high-bytes per sample, and was being silently dropped from
 * indexing — breaking documented multi-language support. The new logic
 * (NUL → binary; strict UTF-8 decode → text; replacement chars → binary)
 * correctly classifies real-world non-ASCII text as text while still
 * catching minified/obfuscated/binary blobs.
 *
 * Note: a truncated 1–3 byte UTF-8 sequence at the tail of the sample
 * produces at most 1–3 replacement chars in the lossy step. The
 * REPLACEMENT_CHAR_THRESHOLD (5) absorbs that noise comfortably, so we
 * don't need a special-cased trailer trim (re-review finding 6).
 */
export async function isLikelyBinaryFile(absPath: string): Promise<boolean> {
  const { open } = await import('node:fs/promises');
  let handle;
  try {
    handle = await open(absPath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SAMPLE_BYTES, 0);
    if (bytesRead === 0) return false;
    // Strong binary signal: NUL byte in a text file is exceedingly rare.
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    const slice = buf.subarray(0, bytesRead);
    // Step 1: try strict decoding. If it throws, the sample is not valid UTF-8.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(slice);
      return false;
    } catch {
      // fall through to lossy decode + replacement char count
    }
    // Step 2: lossy decode and count U+FFFD replacements. A handful can occur
    // legitimately (truncated multi-byte tail, an unusual document quoting
    // raw bytes), but a true binary will produce dozens.
    const lossy = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    let replacements = 0;
    for (let i = 0; i < lossy.length; i++) {
      if (lossy.charCodeAt(i) === 0xfffd) replacements++;
      if (replacements > REPLACEMENT_CHAR_THRESHOLD) return true;
    }
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function resolveSafeVaultReadPath(rootPath: string, relPath: string): Promise<string> {
  rejectAbsoluteVaultPath(relPath);
  const normalized = normalizeVaultRelPath(relPath);
  if (isIgnoredVaultPath(normalized) || isSecretLikeVaultPath(normalized)) {
    throw new Error(`vault path is not allowed: ${relPath}`);
  }
  const absPath = resolveInsideVault(rootPath, normalized);
  // Layered defense against symlink escape:
  //  1. hasSymlinkAncestor() lstats every intermediate directory between
  //     rootPath and the leaf — rejects when any ancestor is a symlink.
  //  2. lstat() on the leaf itself — rejects symlink-to-file.
  //  3. assertRealpathInside() resolves the full path with realpath() and
  //     verifies the result still lives inside rootPath — closes the small
  //     TOCTOU window between the pre-checks above and the caller's open().
  // We deliberately do NOT use O_NOFOLLOW: Node's fs.open with O_NOFOLLOW
  // has platform-quirky behavior (symlink-to-dir vs symlink-to-file differs
  // between Linux/macOS/Windows). Documented follow-up.
  if (await hasSymlinkAncestor(rootPath, absPath)) {
    throw new Error(`vault path uses a symlink: ${relPath}`);
  }
  const linkStats = await lstat(absPath);
  if (linkStats.isSymbolicLink()) {
    throw new Error(`vault path uses a symlink: ${relPath}`);
  }
  if (!linkStats.isFile()) {
    throw new Error(`vault path is not a file: ${relPath}`);
  }
  if (linkStats.size > MAX_INDEXABLE_FILE_BYTES) {
    throw new Error(`vault path is too large: ${relPath}`);
  }
  await assertRealpathInside(rootPath, absPath);
  return absPath;
}

export async function prepareSafeVaultWritePath(
  rootPath: string,
  relPath: string,
  contentBytes: number,
): Promise<string> {
  const normalized = validateSafeVaultWriteRelPath(relPath, contentBytes);
  const absPath = resolveInsideVault(rootPath, normalized);
  await mkdir(dirname(absPath), { recursive: true });
  await assertRealpathInside(rootPath, dirname(absPath));
  try {
    const linkStats = await lstat(absPath);
    if (linkStats.isSymbolicLink()) {
      throw new Error(`vault path uses a symlink: ${relPath}`);
    }
    await assertRealpathInside(rootPath, absPath);
  } catch (err) {
    if (err instanceof Error && err.message.includes('symlink')) throw err;
  }
  return absPath;
}

export async function resolveExistingVaultRoot(rootPath: string): Promise<
  { ok: true; realPath: string } | { ok: false; error: string }
> {
  if (!rootPath || rootPath.length > MAX_VAULT_ROOT_PATH_LENGTH || rootPath.includes('\x00')) {
    return { ok: false, error: 'invalid rootPath' };
  }
  if (!isAbsolute(rootPath)) {
    return { ok: false, error: 'rootPath must be absolute' };
  }
  try {
    const linkStats = await lstat(rootPath);
    if (linkStats.isSymbolicLink()) {
      return { ok: false, error: 'rootPath must not be a symlink' };
    }
  } catch {
    return { ok: false, error: 'path does not exist' };
  }
  let realPath: string;
  try {
    realPath = await realpath(rootPath);
  } catch {
    return { ok: false, error: 'path does not exist' };
  }
  try {
    const rootStats = await stat(realPath);
    if (!rootStats.isDirectory()) return { ok: false, error: 'path is not a directory' };
  } catch {
    return { ok: false, error: 'path is not accessible' };
  }
  return { ok: true, realPath };
}

export async function isVaultRootAllowed(rootPath: string, allowedRootPaths: readonly string[]): Promise<boolean> {
  const root = await resolveExistingVaultRoot(rootPath);
  if (!root.ok) return false;
  for (const allowedRootPath of allowedRootPaths) {
    const allowed = await resolveExistingVaultRoot(allowedRootPath);
    if (!allowed.ok) continue;
    if (isInsideOrEqual(root.realPath, allowed.realPath)) return true;
  }
  return false;
}

function resolveInsideVault(rootPath: string, relPath: string): string {
  rejectAbsoluteVaultPath(relPath);
  const absPath = resolve(rootPath, relPath);
  const rel = relative(rootPath, absPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes vault root: ${relPath}`);
  }
  return absPath;
}

async function assertRealpathInside(rootPath: string, path: string): Promise<void> {
  const [rootReal, pathReal] = await Promise.all([realpath(rootPath), realpath(path)]);
  if (!isInsideOrEqual(pathReal, rootReal)) {
    throw new Error(`path escapes vault root: ${path}`);
  }
}

function isInsideOrEqual(candidatePath: string, rootPath: string): boolean {
  const rootWithSep = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath === rootPath || candidatePath.startsWith(rootWithSep);
}

/**
 * Compute homedir() once at module load — it never changes for the life of
 * the process, so the lookup belongs out of the hot path.
 */
const REDACT_HOMEDIR = homedir();

/**
 * Escape a literal path for embedding in a RegExp constructor. Path
 * separators (`/`, `\\`) are intentionally treated as literals, not
 * alternation — sanitizeSyncResponse (server-vault-routes.ts) is the
 * authoritative defense against any new-shape leak. `-` is escaped too so
 * the pattern stays safe if it's ever moved inside a character class.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Redact absolute filesystem paths from an error message before it crosses a
 * trust boundary. Replaces occurrences of:
 *   - `rootPath` (lexical) → `<vault>`
 *   - `realpath(rootPath)` when it differs (e.g. /var/folders → /private/var) → `<vault>`
 *   - `os.homedir()` → `<home>`
 *
 * Pure string function (no fs access): it lives in this leaf module so vault
 * consumers (VaultRegistry) can import it without eagerly pulling in the whole
 * obsidian-vault implementation graph. `obsidian-vault.ts` re-exports it for
 * existing importers.
 *
 * Windows note: this best-effort helper matches the path string exactly as it
 * appears. It does NOT canonicalize forward-slash vs backslash, the `\\?\`
 * long-path prefix, or short-name (8.3) variants. `sanitizeSyncResponse` in
 * server-vault-routes.ts is the authoritative defense — it replaces
 * `canvas.error` with a stable generic string regardless of content, so any
 * variant this helper misses is still scrubbed at the HTTP boundary.
 *
 * Synchronous: `realpathRoot` is resolved once at construction time by
 * `ObsidianVault`; the standalone export path takes the realpath as an
 * optional argument so callers (and tests) can pass a value without an
 * extra fs hit.
 */
export function redactPathsInMessage(msg: string, rootPath: string, realpathRoot?: string): string {
  if (!msg) return msg;
  let out = msg;
  if (rootPath) {
    out = out.replace(new RegExp(escapeForRegExp(rootPath), 'g'), '<vault>');
    if (realpathRoot && realpathRoot !== rootPath) {
      out = out.replace(new RegExp(escapeForRegExp(realpathRoot), 'g'), '<vault>');
    }
  }
  if (REDACT_HOMEDIR && REDACT_HOMEDIR !== '/' && REDACT_HOMEDIR !== rootPath) {
    out = out.replace(new RegExp(escapeForRegExp(REDACT_HOMEDIR), 'g'), '<home>');
  }
  return out;
}
