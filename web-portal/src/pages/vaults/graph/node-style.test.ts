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

    it('splits head on first whitespace into (kind, name)', () => {
      // The regex always treats the first whitespace-delimited token as the
      // kind label — backend always emits `**kind** name`, so ambiguous input
      // like "**Just a note**" is parsed as kind="Just", name="a note".
      const parsed = parseNodeText('**Just a note**');
      expect(parsed.kind).toBe('Just');
      expect(parsed.name).toBe('a note');
    });
  });

  describe('stripMarkdown', () => {
    it('removes bold and italic markers', () => {
      expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
    });
  });
});
