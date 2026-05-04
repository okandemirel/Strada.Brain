import type { IAIProvider } from '../agents/providers/provider.interface.js';

export interface SummarizerDeps {
  provider: IAIProvider;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
}

export async function summarizeSymbol(
  deps: SummarizerDeps,
  symbol: SymbolInfo,
  readFile: (path: string) => Promise<string>,
): Promise<string | null> {
  const body = await readFile(symbol.path);
  const lines = body.split('\n').slice(symbol.startLine - 1, symbol.endLine);
  const content = lines.join('\n').slice(0, 4000);

  if (!content.trim()) return null;

  const prompt =
    `Summarize this ${symbol.kind} \`${symbol.name}\` in 1-2 sentences. ` +
    `Focus on its purpose and behavior. Be concise.\n\n${content}`;

  try {
    const response = await deps.provider.chat(
      '',
      [{ role: 'user', content: prompt }],
      [],
    );
    return response.text.trim().slice(0, 300) || null;
  } catch {
    return null;
  }
}
