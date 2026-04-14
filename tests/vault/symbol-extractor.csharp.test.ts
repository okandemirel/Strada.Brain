import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CSharpSymbolExtractor } from '../../src/vault/symbol-extractor/csharp-extractor.js';

const FIX = join(process.cwd(), 'tests/fixtures/unity-mini/Assets/Scripts');

describe('CSharpSymbolExtractor', () => {
  it('extracts namespace, class, method symbols for Player.cs', async () => {
    const content = await readFile(join(FIX, 'Player.cs'), 'utf8');
    const x = new CSharpSymbolExtractor();
    const out = await x.extract({ path: 'Assets/Scripts/Player.cs', content, lang: 'csharp' });
    const names = out.symbols.map((s) => s.name);
    expect(names).toContain('Game');
    expect(names).toContain('Player');
    expect(names).toContain('Move');
    const player = out.symbols.find((s) => s.name === 'Player');
    expect(player?.kind).toBe('class');
    expect(player?.doc).toMatch(/Top-level player entity/);
  }, 20_000);

  it('extracts the Controller → Player.Move call edge', async () => {
    const content = await readFile(join(FIX, 'Controller.cs'), 'utf8');
    const x = new CSharpSymbolExtractor();
    const out = await x.extract({ path: 'Assets/Scripts/Controller.cs', content, lang: 'csharp' });
    const calls = out.edges.filter((e) => e.kind === 'calls');
    expect(calls.some((e) => e.toSymbol.endsWith('Move'))).toBe(true);
  }, 20_000);

  it('extracts inheritance edge Controller → MonoBehaviour', async () => {
    const content = await readFile(join(FIX, 'Controller.cs'), 'utf8');
    const x = new CSharpSymbolExtractor();
    const out = await x.extract({ path: 'Assets/Scripts/Controller.cs', content, lang: 'csharp' });
    const inherits = out.edges.filter((e) => e.kind === 'inherits');
    expect(inherits.some((e) => e.toSymbol.endsWith('MonoBehaviour'))).toBe(true);
  }, 20_000);
});
