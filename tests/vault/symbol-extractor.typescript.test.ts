import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptSymbolExtractor } from '../../src/vault/symbol-extractor/typescript-extractor.js';

const FIX = join(process.cwd(), 'tests/fixtures/ts-mini/src');

describe('TypeScriptSymbolExtractor', () => {
  it('extracts classes, methods, functions from a.ts', async () => {
    const content = await readFile(join(FIX, 'a.ts'), 'utf8');
    const extractor = new TypeScriptSymbolExtractor();
    const out = await extractor.extract({ path: 'a.ts', content, lang: 'typescript' });
    const names = out.symbols.map((s) => s.name).sort();
    expect(names).toContain('Alpha');
    expect(names).toContain('greet');
    expect(names).toContain('topLevel');
    expect(out.symbols.find((s) => s.name === 'Alpha')?.kind).toBe('class');
    expect(out.symbols.find((s) => s.name === 'topLevel')?.kind).toBe('function');
    expect(out.symbols.find((s) => s.name === 'greet')?.kind).toBe('method');
  }, 20_000);

  it('extracts import + call edges from b.ts', async () => {
    const content = await readFile(join(FIX, 'b.ts'), 'utf8');
    const extractor = new TypeScriptSymbolExtractor();
    const out = await extractor.extract({ path: 'b.ts', content, lang: 'typescript' });
    const imports = out.edges.filter((e) => e.kind === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports.some((e) => e.toSymbol.includes('Alpha'))).toBe(true);
    const calls = out.edges.filter((e) => e.kind === 'calls');
    expect(calls.some((e) => e.toSymbol.endsWith('greet'))).toBe(true);
  }, 20_000);
});
