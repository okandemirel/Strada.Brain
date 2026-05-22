import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getIndexableFileInfo,
  hasSymlinkAncestor,
  isLikelyBinaryFile,
} from '../../src/vault/path-policy.js';

let vaultDir: string;
let elsewhereDir: string;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'vault-policy-'));
  elsewhereDir = mkdtempSync(join(tmpdir(), 'vault-policy-out-'));
});
afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(elsewhereDir, { recursive: true, force: true });
});

describe('path-policy binary heuristic', () => {
  it('flags files containing a NUL byte as binary', async () => {
    const file = join(vaultDir, 'blob.json');
    const buf = Buffer.concat([Buffer.from('{"a":1}'), Buffer.from([0x00]), Buffer.alloc(64, 0x41)]);
    writeFileSync(file, buf);
    expect(await isLikelyBinaryFile(file)).toBe(true);
  });

  it('flags arbitrary non-UTF-8 byte noise as binary', async () => {
    const file = join(vaultDir, 'noise.bin');
    const buf = Buffer.alloc(256);
    // Sequence of stray high bytes that is invalid UTF-8 (lone continuation bytes).
    for (let i = 0; i < buf.length; i++) buf[i] = i < 32 ? 0x41 : 0x80;
    writeFileSync(file, buf);
    expect(await isLikelyBinaryFile(file)).toBe(true);
  });

  it('does not flag normal ASCII text', async () => {
    const file = join(vaultDir, 'plain.md');
    writeFileSync(file, '# Hello\n\nthis is a normal markdown file with text.\n');
    expect(await isLikelyBinaryFile(file)).toBe(false);
  });

  it('does not flag UTF-8 Turkish markdown as binary', async () => {
    const file = join(vaultDir, 'tr.md');
    // Turkish text exceeds 30% high bytes once you count special letters,
    // which would false-positive the legacy heuristic.
    writeFileSync(
      file,
      '# Başlık\n\nÖğrenci işleri için günlük güncellemeler.\n' +
        'Şu anda çalışmakta olan özelliklerin hepsini gözden geçiriyoruz.\n' +
        'Açıklama: bu dosya tamamen geçerli UTF-8 Türkçe markdown olmalıdır.\n',
    );
    expect(await isLikelyBinaryFile(file)).toBe(false);
  });

  it('does not flag UTF-8 Japanese markdown as binary', async () => {
    const file = join(vaultDir, 'jp.md');
    writeFileSync(
      file,
      '# プロジェクト\n\nこれは日本語のマークダウンファイルです。\n' +
        '内容は通常のテキストですが、ほとんどのバイトが高位バイト範囲にあります。\n',
    );
    expect(await isLikelyBinaryFile(file)).toBe(false);
  });

  it('does not flag UTF-8 Chinese markdown as binary', async () => {
    const file = join(vaultDir, 'cn.md');
    writeFileSync(
      file,
      '# 项目说明\n\n这是一个用中文写的 markdown 文件，全部都是合法的 UTF-8 文本。\n',
    );
    expect(await isLikelyBinaryFile(file)).toBe(false);
  });

  it('does not flag a small text sample with a few high bytes as binary', async () => {
    const file = join(vaultDir, 'mixed.md');
    // Mostly ASCII with a single non-ASCII accented word — must remain text.
    writeFileSync(file, '# Title\n\nA quick note about café and résumé.\n');
    expect(await isLikelyBinaryFile(file)).toBe(false);
  });

  it('getIndexableFileInfo returns binary-content for a binary file', async () => {
    const buf = Buffer.concat([Buffer.alloc(32, 0x00), Buffer.from('{"a":1}')]);
    writeFileSync(join(vaultDir, 'blob.json'), buf);
    const info = await getIndexableFileInfo(vaultDir, 'blob.json');
    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.reason).toBe('binary-content');
  });
});

describe('path-policy symlink-ancestor containment', () => {
  it('hasSymlinkAncestor detects a symlinked intermediate directory', async () => {
    symlinkSync(elsewhereDir, join(vaultDir, 'linked'), 'dir');
    writeFileSync(join(elsewhereDir, 'leak.md'), '# leak');
    expect(await hasSymlinkAncestor(vaultDir, join(vaultDir, 'linked', 'leak.md'))).toBe(true);
  });

  it('hasSymlinkAncestor returns false for a normal nested path', async () => {
    mkdirSync(join(vaultDir, 'a', 'b'), { recursive: true });
    writeFileSync(join(vaultDir, 'a', 'b', 'note.md'), '# note');
    expect(await hasSymlinkAncestor(vaultDir, join(vaultDir, 'a', 'b', 'note.md'))).toBe(false);
  });

  it('getIndexableFileInfo refuses files under a symlinked directory', async () => {
    symlinkSync(elsewhereDir, join(vaultDir, 'linked'), 'dir');
    writeFileSync(join(elsewhereDir, 'leak.md'), '# leak');
    const info = await getIndexableFileInfo(vaultDir, 'linked/leak.md');
    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.reason).toBe('symlink-ancestor');
  });
});
