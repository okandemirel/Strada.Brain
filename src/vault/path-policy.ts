import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
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
    const linkStats = await lstat(absPath);
    if (linkStats.isSymbolicLink()) return { ok: false, relPath: normalized, reason: 'symlink' };
    if (!linkStats.isFile()) return { ok: false, relPath: normalized, reason: 'not a file' };
    if (!isIndexableVaultPath(normalized, linkStats.size)) {
      return { ok: false, relPath: normalized, reason: 'not indexable' };
    }
    await assertRealpathInside(rootPath, absPath);
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

export async function resolveSafeVaultReadPath(rootPath: string, relPath: string): Promise<string> {
  rejectAbsoluteVaultPath(relPath);
  const normalized = normalizeVaultRelPath(relPath);
  if (isIgnoredVaultPath(normalized) || isSecretLikeVaultPath(normalized)) {
    throw new Error(`vault path is not allowed: ${relPath}`);
  }
  const absPath = resolveInsideVault(rootPath, normalized);
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
