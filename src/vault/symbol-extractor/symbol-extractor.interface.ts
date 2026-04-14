import type { VaultSymbol, VaultEdge, VaultWikilink } from '../vault.interface.js';

export interface ExtractInput {
  path: string;            // vault-relative
  content: string;
  lang: 'typescript' | 'csharp' | 'markdown';
}

export interface ExtractOutput {
  symbols: VaultSymbol[];
  edges: VaultEdge[];
  wikilinks: VaultWikilink[];
}

export interface ISymbolExtractor {
  readonly lang: ExtractInput['lang'];
  extract(input: ExtractInput): Promise<ExtractOutput>;
}
