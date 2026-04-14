import type { Node as SyntaxNode } from 'web-tree-sitter';
import { loadLanguageParser } from './tree-sitter-loader.js';
import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultEdge, VaultSymbol, SymbolKind } from '../vault.interface.js';

function symbolId(path: string, qualified: string): string {
  return `typescript::${path}::${qualified}`;
}

function unresolved(qualified: string): string {
  return `typescript::unresolved::${qualified}`;
}

function leadingDoc(n: SyntaxNode): string | null {
  const prev = n.previousSibling;
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) return prev.text;
  return null;
}

function eachNamedChild(n: SyntaxNode, fn: (c: SyntaxNode) => void): void {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c) fn(c);
  }
}

function collectCallsInto(node: SyntaxNode, fromSym: string, out: VaultEdge[]): void {
  const stack: SyntaxNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        const name = fn.type === 'member_expression'
          ? fn.childForFieldName('property')?.text ?? fn.text
          : fn.text;
        out.push({
          fromSymbol: fromSym,
          toSymbol: unresolved(name),
          kind: 'calls',
          atLine: n.startPosition.row + 1,
        });
      }
    }
    eachNamedChild(n, (c) => stack.push(c));
  }
}

function collectClassBody(
  path: string,
  classNode: SyntaxNode,
  className: string,
  out: VaultSymbol[],
  edgesOut: VaultEdge[],
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  eachNamedChild(body, (child) => {
    if (child.type === 'method_definition' || child.type === 'method_signature') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) return;
      const methodName = nameNode.text;
      const qualified = `${className}.${methodName}`;
      out.push({
        symbolId: symbolId(path, qualified),
        path,
        kind: 'method',
        name: methodName,
        display: nameNode.text,
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        doc: leadingDoc(child),
      });
      collectCallsInto(child, symbolId(path, qualified), edgesOut);
    }
  });
}

function collectImports(path: string, root: SyntaxNode, edges: VaultEdge[]): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'import_statement') {
      const sourceNode = n.childForFieldName('source');
      const source = sourceNode?.text?.replace(/['"`]/g, '') ?? '';
      const names: string[] = [];
      eachNamedChild(n, (clause) => {
        if (clause.type !== 'import_clause') return;
        const inner: SyntaxNode[] = [clause];
        while (inner.length) {
          const x = inner.pop()!;
          if (x.type === 'identifier') names.push(x.text);
          eachNamedChild(x, (c) => inner.push(c));
        }
      });
      const fileSym = `typescript::${path}::<module>`;
      if (names.length === 0) {
        edges.push({ fromSymbol: fileSym, toSymbol: unresolved(source), kind: 'imports', atLine: n.startPosition.row + 1 });
      }
      for (const name of names) {
        edges.push({ fromSymbol: fileSym, toSymbol: unresolved(`${source}#${name}`), kind: 'imports', atLine: n.startPosition.row + 1 });
      }
    }
    eachNamedChild(n, (c) => stack.push(c));
  }
}

export class TypeScriptSymbolExtractor implements ISymbolExtractor {
  readonly lang = 'typescript' as const;

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const parser = await loadLanguageParser('typescript');
    const tree = parser.parse(input.content);
    const root = tree?.rootNode;
    if (!root) return { symbols: [], edges: [], wikilinks: [] };
    const symbols: VaultSymbol[] = [];
    const edges: VaultEdge[] = [];

    // File-level virtual symbol so file-level imports have a concrete from_symbol.
    symbols.push({
      symbolId: symbolId(input.path, '<module>'),
      path: input.path,
      kind: 'namespace',
      name: '<module>',
      display: input.path,
      startLine: 1,
      endLine: input.content.split('\n').length || 1,
      doc: null,
    });

    eachNamedChild(root, (node) => {
      const nameNode = node.childForFieldName('name');
      let kind: SymbolKind | null = null;
      if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') kind = 'class';
      else if (node.type === 'interface_declaration') kind = 'interface';
      else if (node.type === 'function_declaration') kind = 'function';
      // Handle `export class/function` wrapping
      if (!kind && node.type === 'export_statement') {
        eachNamedChild(node, (c) => {
          if (c.type === 'class_declaration' || c.type === 'abstract_class_declaration') {
            const cn = c.childForFieldName('name');
            if (!cn) return;
            symbols.push({
              symbolId: symbolId(input.path, cn.text), path: input.path, kind: 'class',
              name: cn.text, display: cn.text,
              startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1,
              doc: leadingDoc(node),
            });
            collectClassBody(input.path, c, cn.text, symbols, edges);
          } else if (c.type === 'function_declaration') {
            const fn = c.childForFieldName('name');
            if (!fn) return;
            symbols.push({
              symbolId: symbolId(input.path, fn.text), path: input.path, kind: 'function',
              name: fn.text, display: fn.text,
              startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1,
              doc: leadingDoc(node),
            });
            collectCallsInto(c, symbolId(input.path, fn.text), edges);
          } else if (c.type === 'interface_declaration') {
            const iface = c.childForFieldName('name');
            if (!iface) return;
            symbols.push({
              symbolId: symbolId(input.path, iface.text), path: input.path, kind: 'interface',
              name: iface.text, display: iface.text,
              startLine: c.startPosition.row + 1, endLine: c.endPosition.row + 1,
              doc: leadingDoc(node),
            });
            collectClassBody(input.path, c, iface.text, symbols, edges);
          }
        });
        return;
      }
      if (!kind || !nameNode) return;
      const name = nameNode.text;
      symbols.push({
        symbolId: symbolId(input.path, name),
        path: input.path,
        kind,
        name,
        display: nameNode.text,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        doc: leadingDoc(node),
      });
      if (kind === 'class' || kind === 'interface') {
        collectClassBody(input.path, node, name, symbols, edges);
      } else {
        collectCallsInto(node, symbolId(input.path, name), edges);
      }
    });

    collectImports(input.path, root, edges);
    return { symbols, edges, wikilinks: [] };
  }
}
