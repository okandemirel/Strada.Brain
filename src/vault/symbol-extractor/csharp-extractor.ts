import type { Node as SyntaxNode } from 'web-tree-sitter';
import { loadLanguageParser } from './tree-sitter-loader.js';
import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultEdge, VaultSymbol } from '../vault.interface.js';

function symId(path: string, qualified: string): string {
  return `csharp::${path}::${qualified}`;
}
function unresolvedId(qualified: string): string {
  return `csharp::unresolved::${qualified}`;
}

function leadingXmlDoc(n: SyntaxNode): string | null {
  let p = n.previousSibling;
  const lines: string[] = [];
  while (p && (p.type === 'comment' || p.type === 'line_comment')) {
    const t = p.text;
    if (t.startsWith('///')) lines.unshift(t);
    p = p.previousSibling;
  }
  return lines.length ? lines.join('\n') : null;
}

function walk(root: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    fn(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

export class CSharpSymbolExtractor implements ISymbolExtractor {
  readonly lang = 'csharp' as const;

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const parser = await loadLanguageParser('csharp');
    const tree = parser.parse(input.content);
    const root = tree?.rootNode;
    if (!root) return { symbols: [], edges: [], wikilinks: [] };

    const symbols: VaultSymbol[] = [];
    const edges: VaultEdge[] = [];

    const fileSym = symId(input.path, '<module>');
    symbols.push({
      symbolId: fileSym, path: input.path, kind: 'namespace', name: '<module>', display: input.path,
      startLine: 1, endLine: input.content.split('\n').length || 1, doc: null,
    });

    // using X.Y; → imports
    walk(root, (n) => {
      if (n.type === 'using_directive') {
        const parts: string[] = [];
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) parts.push(c.text);
        }
        const name = parts.join('.');
        edges.push({ fromSymbol: fileSym, toSymbol: unresolvedId(name), kind: 'imports', atLine: n.startPosition.row + 1 });
      }
    });

    const nsStack: string[] = [];
    const visit = (n: SyntaxNode): void => {
      if (n.type === 'namespace_declaration' || n.type === 'file_scoped_namespace_declaration') {
        const nameNode = n.childForFieldName('name');
        const nsName = nameNode?.text ?? '<anon>';
        nsStack.push(nsName);
        symbols.push({
          symbolId: symId(input.path, nsStack.join('.')),
          path: input.path, kind: 'namespace', name: nsName, display: nsName,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1, doc: null,
        });
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) visit(c);
        }
        nsStack.pop();
        return;
      }
      if (n.type === 'class_declaration' || n.type === 'struct_declaration' || n.type === 'interface_declaration') {
        const nameNode = n.childForFieldName('name');
        if (!nameNode) return;
        const className = nameNode.text;
        const qualified = [...nsStack, className].join('.');
        const kind = n.type === 'interface_declaration' ? 'interface' : 'class';
        symbols.push({
          symbolId: symId(input.path, qualified),
          path: input.path, kind, name: className, display: className,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
          doc: leadingXmlDoc(n),
        });
        // inherits / implements via base_list (no named field — find it as a direct child).
        for (let i = 0; i < n.namedChildCount; i++) {
          const child = n.namedChild(i);
          if (child?.type !== 'base_list') continue;
          for (let j = 0; j < child.namedChildCount; j++) {
            const b = child.namedChild(j);
            if (!b) continue;
            edges.push({
              fromSymbol: symId(input.path, qualified),
              toSymbol: unresolvedId(b.text),
              kind: 'inherits',
              atLine: b.startPosition.row + 1,
            });
          }
        }
        const body = n.childForFieldName('body');
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const mem = body.namedChild(i);
            if (!mem) continue;
            if (mem.type === 'method_declaration' || mem.type === 'constructor_declaration') {
              const mNameNode = mem.childForFieldName('name');
              if (!mNameNode) continue;
              const mName = mNameNode.text;
              const mQualified = `${qualified}.${mName}`;
              symbols.push({
                symbolId: symId(input.path, mQualified),
                path: input.path, kind: 'method', name: mName, display: mName,
                startLine: mem.startPosition.row + 1, endLine: mem.endPosition.row + 1,
                doc: leadingXmlDoc(mem),
              });
              walk(mem, (c) => {
                if (c.type === 'invocation_expression') {
                  const fn = c.childForFieldName('function') ?? c.namedChild(0);
                  const label = fn?.type === 'member_access_expression'
                    ? fn.childForFieldName('name')?.text ?? fn.text
                    : fn?.text ?? '<anon>';
                  edges.push({
                    fromSymbol: symId(input.path, mQualified),
                    toSymbol: unresolvedId(label),
                    kind: 'calls',
                    atLine: c.startPosition.row + 1,
                  });
                }
              });
            }
          }
        }
        return;
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) visit(c);
      }
    };
    visit(root);

    return { symbols, edges, wikilinks: [] };
  }
}
