import type { Node as SyntaxNode } from 'web-tree-sitter';
import { withParsedTree } from './tree-sitter-loader.js';
import type { ExtractInput, ExtractOutput, ISymbolExtractor } from './symbol-extractor.interface.js';
import type { VaultEdge, VaultSymbol } from '../vault.interface.js';

function symId(path: string, qualified: string): string {
  return `csharp::${path}::${qualified}`;
}
function unresolvedId(qualified: string): string {
  return `csharp::unresolved::${qualified}`;
}

/**
 * THE CALLABLE SIGNATURE IS PART OF A METHOD'S IDENTITY (plan 3.11 / audit
 * 05.F4 / D49, Codex #26).
 *
 * `Save(int)` and `Save(string)` used to collapse into one symbol
 * `Class.Save`: one doc, one span, one set of callers for two different
 * methods, and the graph bound every call to whichever body was indexed last.
 * Arity alone does not separate them either, so the parameter TYPES and the
 * generic arity go into the id.
 *
 * Returns e.g. `(int)`, `(string,int)`, ``1(T)` for `Save<T>(T value)`,
 * or `()` for a method with no parameters.
 */
export function callableSignature(node: SyntaxNode): string {
  const typeParams = node.childForFieldName('type_parameters');
  const generic = typeParams ? `${String.fromCharCode(96)}${Math.max(1, typeParams.namedChildCount)}` : '';
  const params = node.childForFieldName('parameters');
  if (!params) return `${generic}()`;
  // THE TYPES COME FROM THE SYNTAX, NEVER FROM THE TEXT.
  //
  // Reading the parameter list as text and splitting on commas was wrong in
  // both directions (Codex round 11 #18): a default value containing a comma
  // (`F(string s = "a,b", int n = 0)`) produced `F(string,b",int)`, and one
  // containing '<' swallowed the rest of the list — `F(string s = "a<b", int n)`
  // became `F(string)`, colliding with a real `F(string)` overload. A
  // parameter node's `type` field is exact: no name, no default, no attribute.
  //
  // The grammar also FLATTENS a variadic parameter — `params`, then the type,
  // then the name, straight off the parameter list — so both shapes are read
  // here, in order.
  const types: string[] = [];
  let modifiers: string[] = [];
  let looseType: string | undefined;
  const flushLoose = (): void => {
    if (looseType !== undefined) types.push([...modifiers, looseType].join(' '));
    modifiers = [];
    looseType = undefined;
  };
  for (let i = 0; i < params.childCount; i++) {
    const child = params.child(i);
    if (!child) continue;
    if (child.type === ',') {
      flushLoose();
      continue;
    }
    if (child.type === '(' || child.type === ')') continue;
    if (child.type === 'parameter') {
      const declaredType = child.childForFieldName('type');
      const own: string[] = [];
      for (let j = 0; j < child.childCount; j++) {
        const sub = child.child(j);
        // A modifier is a `modifier` node here, not an anonymous keyword.
        if (sub && (sub.type === "modifier" || !sub.isNamed) && PARAMETER_MODIFIERS.has(sub.text)) own.push(sub.text);
      }
      types.push([...modifiers, ...own, collapseType(declaredType?.text ?? '?')].join(' '));
      modifiers = [];
      looseType = undefined;
      continue;
    }
    if ((child.type === "modifier" || !child.isNamed) && PARAMETER_MODIFIERS.has(child.text)) {
      modifiers.push(child.text);
      continue;
    }
    // The flattened variadic shape: a type node, then its name.
    if (child.isNamed && child.type !== 'identifier') {
      looseType = collapseType(child.text);
      continue;
    }
  }
  flushLoose();
  return `${generic}(${types.join(',')})`;
}

/** A type as it identifies a callable: no incidental whitespace. */
function collapseType(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/\s*,\s*/gu, ',').trim();
}

const PARAMETER_MODIFIERS = new Set(['params', 'ref', 'out', 'in', 'this', 'scoped', 'readonly']);

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
    return withParsedTree('csharp', input.content, (root) => this.extractFromRoot(root, input));
  }

  private extractFromRoot(root: SyntaxNode | null, input: ExtractInput): ExtractOutput {
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
              // Overloads are DIFFERENT symbols (plan 3.11): the signature is
              // part of the id, the bare name stays searchable, and the
              // display carries the signature a person reads.
              const signature = callableSignature(mem);
              const mQualified = `${qualified}.${mName}${signature}`;
              symbols.push({
                symbolId: symId(input.path, mQualified),
                path: input.path, kind: 'method', name: mName, display: `${mName}${signature}`,
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
