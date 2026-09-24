// Lazy WASM loader for tree-sitter grammars. Caches Parser + Language instances.
// Runs in Node (web-tree-sitter ships a Node-compatible build).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Parser as TSParser, Language as TSLanguage, Node as TSNode, Tree as TSTree } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export type TreeSitterLang = 'typescript' | 'csharp';

let parserModulePromise: Promise<typeof import('web-tree-sitter')> | null = null;
const langCache = new Map<TreeSitterLang, TSLanguage>();

// Phase2-review I4: cache language (expensive WASM load) but hand out a FRESH Parser per call.
// web-tree-sitter's Parser instances are stateful — sharing one between concurrent `extract()`
// calls corrupts parse trees. Grammar loading is amortised via `langCache` so fresh parsers
// are cheap (constructor only).
const WASM_PATHS: Record<TreeSitterLang, () => string> = {
  typescript: () => join(dirname(require.resolve('tree-sitter-typescript/package.json')), 'tree-sitter-typescript.wasm'),
  csharp:     () => join(dirname(require.resolve('tree-sitter-c-sharp/package.json')), 'tree-sitter-c_sharp.wasm'),
};

async function getModule(): Promise<typeof import('web-tree-sitter')> {
  if (!parserModulePromise) {
    parserModulePromise = (async () => {
      const mod = await import('web-tree-sitter');
      await mod.Parser.init();
      return mod;
    })();
  }
  return parserModulePromise;
}

async function getLang(lang: TreeSitterLang): Promise<TSLanguage> {
  const cached = langCache.get(lang);
  if (cached) return cached;
  const mod = await getModule();
  const wasmPath = WASM_PATHS[lang]();
  const loaded = await mod.Language.load(wasmPath);
  langCache.set(lang, loaded);
  return loaded;
}

export async function loadLanguageParser(lang: TreeSitterLang): Promise<TSParser> {
  const mod = await getModule();
  const parser = new mod.Parser();
  const language = await getLang(lang);
  parser.setLanguage(language);
  return parser;
}

/**
 * Parse `content` with a fresh parser, hand the root node to `visit`, then free
 * the tree and the parser.
 *
 * Both live in the WASM heap and web-tree-sitter registers no finalizer, so
 * only delete() releases them. Without it every extraction leaked its parser
 * and tree (measured: ~1.3 MB per parse of a 62 KB file), and WASM memory
 * never shrinks. `visit` must copy out what it needs: nodes are invalid once
 * it returns.
 */
export async function withParsedTree<T>(
  lang: TreeSitterLang,
  content: string,
  visit: (root: TSNode | null) => T,
): Promise<T> {
  const parser = await loadLanguageParser(lang);
  let tree: TSTree | null = null;
  try {
    tree = parser.parse(content);
    return visit(tree?.rootNode ?? null);
  } finally {
    tree?.delete();
    parser.delete();
  }
}

export function resetForTests(): void {
  parserModulePromise = null;
  langCache.clear();
}
