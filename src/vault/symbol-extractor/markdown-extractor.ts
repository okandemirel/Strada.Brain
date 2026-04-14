import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultSymbol, VaultWikilink } from '../vault.interface.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const FENCE_RE = /```[\s\S]*?```/g;

export class MarkdownSymbolExtractor implements ISymbolExtractor {
  readonly lang = 'markdown' as const;

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const symbols: VaultSymbol[] = [{
      symbolId: `markdown::${input.path}`,
      path: input.path,
      kind: 'note',
      name: input.path.split('/').pop() ?? input.path,
      display: input.path,
      startLine: 1,
      endLine: input.content.split('\n').length || 1,
      doc: null,
    }];

    // Strip fenced code blocks before scanning wikilinks (preserve line counts).
    const stripped = input.content.replace(FENCE_RE, (m) => '\n'.repeat((m.match(/\n/g)?.length ?? 0)));
    const seen = new Set<string>();
    const wikilinks: VaultWikilink[] = [];
    for (const m of stripped.matchAll(WIKILINK_RE)) {
      const target = m[1]!.trim();
      if (seen.has(target)) continue;
      seen.add(target);
      wikilinks.push({ fromNote: input.path, target, resolved: false });
    }
    return { symbols, edges: [], wikilinks };
  }
}
