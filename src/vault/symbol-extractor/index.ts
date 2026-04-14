import { TypeScriptSymbolExtractor } from './typescript-extractor.js';
import { CSharpSymbolExtractor } from './csharp-extractor.js';
import { MarkdownSymbolExtractor } from './markdown-extractor.js';
import type { ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultFile } from '../vault.interface.js';

let ts: TypeScriptSymbolExtractor | null = null;
let cs: CSharpSymbolExtractor | null = null;
let md: MarkdownSymbolExtractor | null = null;

export function getExtractorFor(lang: VaultFile['lang']): ISymbolExtractor | null {
  switch (lang) {
    case 'typescript': return (ts ??= new TypeScriptSymbolExtractor());
    case 'csharp':     return (cs ??= new CSharpSymbolExtractor());
    case 'markdown':   return (md ??= new MarkdownSymbolExtractor());
    default: return null;
  }
}

export type { ISymbolExtractor, ExtractInput, ExtractOutput } from './symbol-extractor.interface.js';
export { TypeScriptSymbolExtractor } from './typescript-extractor.js';
export { CSharpSymbolExtractor } from './csharp-extractor.js';
export { MarkdownSymbolExtractor } from './markdown-extractor.js';
