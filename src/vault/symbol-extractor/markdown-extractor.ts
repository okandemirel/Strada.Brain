import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultSymbol, VaultWikilink } from '../vault.interface.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const FENCE_RE = /```[\s\S]*?```/g;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const TAG_RE = /(?:^|\s)(#[\w\-/]+)/g;

function parseFrontmatter(content: string): Record<string, string> | undefined {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return undefined;
  const yaml = m[1];
  const out: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseTags(content: string): string[] | undefined {
  const seen = new Set<string>();
  const tags: string[] = [];
  // Skip frontmatter and code fences for tag scanning
  let body = content;
  const fm = body.match(FRONTMATTER_RE);
  if (fm) body = body.slice(fm[0].length);
  body = body.replace(FENCE_RE, '');
  for (const m of body.matchAll(TAG_RE)) {
    const tag = m[1]!.trim();
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.length ? tags : undefined;
}

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

    const frontmatter = parseFrontmatter(input.content);
    const tags = parseTags(input.content);

    return { symbols, edges: [], wikilinks, frontmatter, tags };
  }
}
