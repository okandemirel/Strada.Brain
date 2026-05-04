import { describe, it, expect, vi } from 'vitest';
import { summarizeSymbol, type SummarizerDeps, type SymbolInfo } from './symbol-summarizer.js';
import type { IAIProvider } from '../agents/providers/provider.interface.js';

function makeProvider(text: string): IAIProvider {
  return {
    name: 'mock',
    capabilities: { contextWindow: 128000, vision: false, thinkingSupported: false, toolCalling: false, streaming: false },
    chat: vi.fn().mockResolvedValue({ text, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
  } as unknown as IAIProvider;
}

const symbol: SymbolInfo = {
  name: 'Player',
  kind: 'class',
  path: 'Assets/Scripts/Player.cs',
  startLine: 1,
  endLine: 3,
};

const readFile = vi.fn().mockResolvedValue('namespace Game {\n  public class Player { }\n}');

describe('summarizeSymbol', () => {
  it('returns LLM response trimmed to 300 chars', async () => {
    const provider = makeProvider('  Manages player movement and input.  ');
    const result = await summarizeSymbol({ provider }, symbol, readFile);
    expect(result).toBe('Manages player movement and input.');
    expect(provider.chat).toHaveBeenCalledWith(
      '',
      [{ role: 'user', content: expect.stringContaining('class `Player`') }],
      [],
    );
  });

  it('truncates LLM response to 300 chars', async () => {
    const longText = 'a'.repeat(500);
    const provider = makeProvider(longText);
    const result = await summarizeSymbol({ provider }, symbol, readFile);
    expect(result).toHaveLength(300);
  });

  it('returns null when file content is empty', async () => {
    const provider = makeProvider('ignored');
    const result = await summarizeSymbol({ provider }, symbol, async () => '');
    expect(result).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('returns null on LLM failure', async () => {
    const provider = makeProvider('');
    provider.chat = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await summarizeSymbol({ provider }, symbol, readFile);
    expect(result).toBeNull();
  });

  it('caps content at 4000 chars', async () => {
    const provider = makeProvider('ok');
    const hugeContent = 'x'.repeat(10000);
    await summarizeSymbol({ provider }, symbol, async () => hugeContent);
    const prompt = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![1][0].content as string;
    expect(prompt.length).toBeLessThanOrEqual(4000 + 100); // prompt prefix + 4000 chars
  });
});
