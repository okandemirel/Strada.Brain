import { describe, expect, it } from 'vitest';
import {
  getKindStyle,
  KIND_STYLE_MAP,
  parseNodeText,
  stripMarkdown,
} from './node-style';

describe('node-style', () => {
  describe('getKindStyle', () => {
    it('returns the configured style for a known kind', () => {
      const s = getKindStyle('class');
      expect(s).toBe(KIND_STYLE_MAP.class);
    });

    it('handles the special `file` kind (not in SymbolKind)', () => {
      const s = getKindStyle('file');
      expect(s.label).toBe('File');
    });

    it('falls back for unknown kinds', () => {
      const s = getKindStyle('alien-kind');
      expect(s.label).toBe('Symbol');
    });

    it('falls back for null / undefined', () => {
      expect(getKindStyle(null).label).toBe('Symbol');
      expect(getKindStyle(undefined).label).toBe('Symbol');
    });
  });

  describe('parseNodeText', () => {
    it('parses canonical backend text "**kind** name\\n\\n*file:line*"', () => {
      const parsed = parseNodeText('**class** Foo\n\n*src/a.ts:42*');
      expect(parsed).toEqual({ kind: 'class', name: 'Foo', file: 'src/a.ts', line: 42 });
    });

    it('returns null file/line when tail is missing', () => {
      const parsed = parseNodeText('**method** Bar');
      expect(parsed.kind).toBe('method');
      expect(parsed.name).toBe('Bar');
      expect(parsed.file).toBeNull();
      expect(parsed.line).toBeNull();
    });

    it('extracts kind only from the `**kind** name` form, not bold-wrapped text', () => {
      // "**class** Foo" carries a real kind marker → kind="class".
      expect(parseNodeText('**class** Foo')).toMatchObject({ kind: 'class', name: 'Foo' });
      // "**Just a note**" is bold-wrapped text, NOT `**kind** name` — the whole
      // thing is the name (previously `Just` was wrongly dropped as a kind).
      const parsed = parseNodeText('**Just a note**');
      expect(parsed.kind).toBeNull();
      expect(parsed.name).toBe('Just a note');
    });

    it('keeps a bare file-graph basename containing spaces intact as the name', () => {
      const parsed = parseNodeText('My File.md');
      expect(parsed.kind).toBeNull();
      expect(parsed.name).toBe('My File.md');
      expect(parsed.file).toBeNull();
    });

    it('parses a tail path that itself contains colons (drive/path refs)', () => {
      const parsed = parseNodeText('**method** Bar\n\n*C:/repo/a.ts:99*');
      expect(parsed.file).toBe('C:/repo/a.ts');
      expect(parsed.line).toBe(99);
    });
  });

  describe('stripMarkdown', () => {
    it('removes bold and italic markers', () => {
      expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
    });
  });
});
