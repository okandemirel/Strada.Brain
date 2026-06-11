import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getIndexableFileInfo,
  isLikelyBinaryFile,
  isVaultRootAllowed,
  MAX_INDEXABLE_FILE_BYTES,
  resolveExistingVaultRoot,
  resolveSafeVaultReadPath,
  validateSafeVaultWriteRelPath,
} from './path-policy.js';

describe('path-policy', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('resolveSafeVaultReadPath', () => {
    it('resolves a regular file inside the vault root', async () => {
      const root = makeTempDir('strada-path-policy-');
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes', 'a.md'), '# hello');

      const abs = await resolveSafeVaultReadPath(root, 'notes/a.md');
      expect(abs).toBe(join(root, 'notes', 'a.md'));
    });

    it('rejects relative paths that escape the vault root', async () => {
      const root = makeTempDir('strada-path-policy-');
      await expect(resolveSafeVaultReadPath(root, '../escape.md')).rejects.toThrow(/escapes vault root/);
      await expect(resolveSafeVaultReadPath(root, 'notes/../../escape.md')).rejects.toThrow(/escapes vault root/);
    });

    it('rejects absolute input paths', async () => {
      const root = makeTempDir('strada-path-policy-');
      await expect(resolveSafeVaultReadPath(root, '/etc/passwd')).rejects.toThrow(/escapes vault root/);
    });

    it('rejects a symlink leaf', async () => {
      const root = makeTempDir('strada-path-policy-');
      const outside = makeTempDir('strada-path-policy-outside-');
      const outsideFile = join(outside, 'outside.md');
      writeFileSync(outsideFile, '# outside');
      symlinkSync(outsideFile, join(root, 'link.md'));

      await expect(resolveSafeVaultReadPath(root, 'link.md')).rejects.toThrow(/uses a symlink/);
    });

    it('rejects a symlink ancestor directory', async () => {
      const root = makeTempDir('strada-path-policy-');
      const outside = makeTempDir('strada-path-policy-outside-');
      writeFileSync(join(outside, 'a.md'), '# outside');
      symlinkSync(outside, join(root, 'linkdir'), 'dir');

      await expect(resolveSafeVaultReadPath(root, 'linkdir/a.md')).rejects.toThrow(/uses a symlink/);
    });

    it('rejects secret-like basenames and ignored directories', async () => {
      const root = makeTempDir('strada-path-policy-');
      // Characterization: SECRET_BASENAME matches `.env*` basenames, so even
      // `.env.md` is treated as secret-like and rejected.
      await expect(resolveSafeVaultReadPath(root, '.env.md')).rejects.toThrow(/not allowed/);
      await expect(resolveSafeVaultReadPath(root, 'secrets.md')).rejects.toThrow(/not allowed/);
      await expect(resolveSafeVaultReadPath(root, 'node_modules/x.md')).rejects.toThrow(/not allowed/);
    });

    it('rejects files larger than MAX_INDEXABLE_FILE_BYTES', async () => {
      const root = makeTempDir('strada-path-policy-');
      writeFileSync(join(root, 'big.md'), Buffer.alloc(MAX_INDEXABLE_FILE_BYTES + 1, 0x61));

      await expect(resolveSafeVaultReadPath(root, 'big.md')).rejects.toThrow(/too large/);
    });
  });

  describe('validateSafeVaultWriteRelPath', () => {
    it('normalizes backslash separators', () => {
      expect(validateSafeVaultWriteRelPath('notes\\a.md', 10)).toBe('notes/a.md');
    });

    it('throws for absolute paths', () => {
      expect(() => validateSafeVaultWriteRelPath('/abs/a.md', 10)).toThrow(/escapes vault root/);
    });

    it('throws for non-indexable extensions', () => {
      expect(() => validateSafeVaultWriteRelPath('a.exe', 10)).toThrow(/not allowed/);
    });

    it('throws for secret-like JSON names', () => {
      expect(() => validateSafeVaultWriteRelPath('secrets.json', 10)).toThrow(/not allowed/);
    });

    it('throws when content exceeds MAX_INDEXABLE_FILE_BYTES', () => {
      expect(() => validateSafeVaultWriteRelPath('notes/a.md', MAX_INDEXABLE_FILE_BYTES + 1)).toThrow(/not allowed/);
    });
  });

  describe('getIndexableFileInfo', () => {
    it('returns ok for a small markdown file', async () => {
      const root = makeTempDir('strada-path-policy-');
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes', 'a.md'), '# hello');

      const info = await getIndexableFileInfo(root, 'notes/a.md');
      expect(info.ok).toBe(true);
      if (info.ok) {
        expect(info.absPath).toBe(join(root, 'notes', 'a.md'));
        expect(info.relPath).toBe('notes/a.md');
        expect(info.lang).toBe('markdown');
        expect(info.size).toBeGreaterThan(0);
      }
    });

    it('flags a symlink leaf', async () => {
      const root = makeTempDir('strada-path-policy-');
      const outside = makeTempDir('strada-path-policy-outside-');
      const outsideFile = join(outside, 'outside.md');
      writeFileSync(outsideFile, '# outside');
      symlinkSync(outsideFile, join(root, 'link.md'));

      expect(await getIndexableFileInfo(root, 'link.md')).toEqual({
        ok: false, relPath: 'link.md', reason: 'symlink',
      });
    });

    it('flags a symlinked ancestor directory', async () => {
      const root = makeTempDir('strada-path-policy-');
      const outside = makeTempDir('strada-path-policy-outside-');
      writeFileSync(join(outside, 'a.md'), '# outside');
      symlinkSync(outside, join(root, 'linkdir'), 'dir');

      expect(await getIndexableFileInfo(root, 'linkdir/a.md')).toEqual({
        ok: false, relPath: 'linkdir/a.md', reason: 'symlink-ancestor',
      });
    });

    it('flags a nonexistent file as missing', async () => {
      const root = makeTempDir('strada-path-policy-');
      expect(await getIndexableFileInfo(root, 'nope.md')).toEqual({
        ok: false, relPath: 'nope.md', reason: 'missing',
      });
    });

    it('flags absolute input', async () => {
      const root = makeTempDir('strada-path-policy-');
      expect(await getIndexableFileInfo(root, '/etc/passwd')).toEqual({
        ok: false, relPath: '/etc/passwd', reason: 'absolute path',
      });
    });

    it('flags binary content', async () => {
      const root = makeTempDir('strada-path-policy-');
      writeFileSync(join(root, 'bin.md'), Buffer.from([0, 0, 0, 0x61, 0x62, 0x63]));

      expect(await getIndexableFileInfo(root, 'bin.md')).toEqual({
        ok: false, relPath: 'bin.md', reason: 'binary-content',
      });
    });
  });

  describe('isLikelyBinaryFile', () => {
    it('returns true for content containing a NUL byte', async () => {
      const root = makeTempDir('strada-path-policy-');
      const file = join(root, 'nul.md');
      writeFileSync(file, Buffer.from('abc\x00def'));
      expect(await isLikelyBinaryFile(file)).toBe(true);
    });

    it('returns false for plain ASCII text', async () => {
      const root = makeTempDir('strada-path-policy-');
      const file = join(root, 'ascii.md');
      writeFileSync(file, '# plain ascii markdown\nhello world\n');
      expect(await isLikelyBinaryFile(file)).toBe(false);
    });

    it('returns false for UTF-8 Turkish text (May-2026 P2 fix)', async () => {
      const root = makeTempDir('strada-path-policy-');
      const file = join(root, 'turkish.md');
      writeFileSync(file, 'ğüşıöçĞÜŞİÖÇ '.repeat(500), 'utf8');
      expect(await isLikelyBinaryFile(file)).toBe(false);
    });

    it('returns true for invalid UTF-8 byte soup', async () => {
      const root = makeTempDir('strada-path-policy-');
      const file = join(root, 'soup.md');
      // 0xff/0xfe/0xfd are never valid in UTF-8; 60 bytes of them produce far
      // more than the 5 allowed replacement characters.
      writeFileSync(file, Buffer.from(Array.from({ length: 20 }, () => [0xff, 0xfe, 0xfd]).flat()));
      expect(await isLikelyBinaryFile(file)).toBe(true);
    });
  });

  describe('resolveExistingVaultRoot', () => {
    it('returns the realpath for an existing directory', async () => {
      const root = makeTempDir('strada-path-policy-');
      expect(await resolveExistingVaultRoot(root)).toEqual({ ok: true, realPath: realpathSync(root) });
    });

    it('rejects relative paths', async () => {
      expect(await resolveExistingVaultRoot('some/relative/path')).toEqual({
        ok: false, error: 'rootPath must be absolute',
      });
    });

    it('rejects nonexistent paths', async () => {
      const root = makeTempDir('strada-path-policy-');
      expect(await resolveExistingVaultRoot(join(root, 'nope'))).toEqual({
        ok: false, error: 'path does not exist',
      });
    });

    it('rejects a file (not a directory)', async () => {
      const root = makeTempDir('strada-path-policy-');
      const file = join(root, 'a.md');
      writeFileSync(file, '# hi');
      expect(await resolveExistingVaultRoot(file)).toEqual({
        ok: false, error: 'path is not a directory',
      });
    });

    it('rejects a symlinked root', async () => {
      const root = makeTempDir('strada-path-policy-');
      const target = makeTempDir('strada-path-policy-target-');
      const link = join(root, 'link');
      symlinkSync(target, link, 'dir');
      expect(await resolveExistingVaultRoot(link)).toEqual({
        ok: false, error: 'rootPath must not be a symlink',
      });
    });
  });

  describe('isVaultRootAllowed', () => {
    it('allows a root equal to an allowed root', async () => {
      const allowed = makeTempDir('strada-path-policy-allowed-');
      expect(await isVaultRootAllowed(allowed, [allowed])).toBe(true);
    });

    it('allows a root nested inside an allowed root', async () => {
      const allowed = makeTempDir('strada-path-policy-allowed-');
      const inner = join(allowed, 'inner');
      mkdirSync(inner);
      expect(await isVaultRootAllowed(inner, [allowed])).toBe(true);
    });

    it('rejects a root outside every allowed root', async () => {
      const allowed = makeTempDir('strada-path-policy-allowed-');
      const outside = makeTempDir('strada-path-policy-outside-');
      expect(await isVaultRootAllowed(outside, [allowed])).toBe(false);
    });

    it('rejects when allowed entries do not resolve', async () => {
      const root = makeTempDir('strada-path-policy-');
      expect(await isVaultRootAllowed(root, [join(root, 'does-not-exist')])).toBe(false);
    });

    it('rejects when the allowed list is empty', async () => {
      const root = makeTempDir('strada-path-policy-');
      expect(await isVaultRootAllowed(root, [])).toBe(false);
    });
  });
});
