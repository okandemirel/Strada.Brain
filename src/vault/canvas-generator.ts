import type { VaultSymbol, VaultEdge, VaultFile, VaultWikilink } from './vault.interface.js';

// JSON Canvas 1.0 spec: https://jsoncanvas.org/spec/1.0/
export interface CanvasNode {
  id: string;
  type: 'text';
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  file?: string;
  kind?: string;
  weight?: number;      // 0-1 normalized connection count
  group?: string;       // folder path or category
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// Obsidian-inspired color palette for different file types
const LANG_COLORS: Record<string, string> = {
  'csharp': '#6A5ACD',     // SlateBlue
  'typescript': '#3178C6', // TypeScript blue
  'markdown': '#10B981',   // Emerald
  'json': '#F59E0B',       // Amber
  'hlsl': '#EC4899',       // Pink
  'unknown': '#6B7280',    // Gray
};

// Apple-minimalist pastel palette for dark themes
const PASTEL_LANG_COLORS: Record<string, string> = {
  'csharp': '#8B7AB8',     // soft purple
  'typescript': '#5B8DB8', // soft blue
  'markdown': '#7AB88B',   // soft green
  'json': '#B8A87A',       // soft amber
  'hlsl': '#B87A9B',       // soft pink
  'unknown': '#888888',    // soft gray
};

// Size tiers based on content/connections (Obsidian-style)
function nodeSize(connections: number): { width: number; height: number } {
  if (connections >= 20) return { width: 280, height: 80 };
  if (connections >= 10) return { width: 240, height: 70 };
  if (connections >= 5) return { width: 200, height: 60 };
  if (connections >= 2) return { width: 180, height: 50 };
  return { width: 160, height: 40 };
}

/**
 * Build a rich Obsidian-quality graph canvas.
 *
 * Strategy:
 * 1. If symbols are few (< 500) and edges resolve → symbol-centric graph
 * 2. If many symbols OR edges don't resolve → file-centric graph (Obsidian-style)
 * 3. Wikilinks always added as edges
 * 4. Fallback → file-folder hierarchy edges
 */
export function buildCanvas(input: {
  symbols: VaultSymbol[];
  edges: VaultEdge[];
  files?: VaultFile[];
  wikilinks?: VaultWikilink[];
}): Canvas {
  const { symbols, edges, files = [], wikilinks = [] } = input;

  // Determine if we should use file-level or symbol-level graph.
  // If there are many symbols OR most edges are unresolved, use file-level.
  const symbolIds = new Set(symbols.map((s) => s.symbolId));
  const resolvedEdges = edges.filter(
    (e) => symbolIds.has(e.fromSymbol) && symbolIds.has(e.toSymbol),
  );
  const useFileGraph = symbols.length > 500 || resolvedEdges.length < edges.length * 0.3;

  // Count connections per node for sizing (use resolved edges + wikilinks)
  const connectionCounts = new Map<string, number>();
  const incrementCount = (id: string) => {
    connectionCounts.set(id, (connectionCounts.get(id) ?? 0) + 1);
  };

  if (useFileGraph) {
    // File-level connection counting from symbol edges
    const symbolToFile = new Map<string, string>();
    for (const s of symbols) symbolToFile.set(s.symbolId, s.path);

    for (const e of edges) {
      const fromFile = symbolToFile.get(e.fromSymbol);
      const toFile = symbolToFile.get(e.toSymbol);
      if (fromFile && toFile && fromFile !== toFile) {
        incrementCount(fromFile);
        incrementCount(toFile);
      }
    }
    for (const w of wikilinks) {
      if (w.resolved) {
        incrementCount(w.fromNote);
        incrementCount(w.target);
      }
    }
    return buildFileGraph(files, edges, wikilinks, symbols, connectionCounts);
  }

  // Symbol-level graph for small projects with resolved edges
  for (const e of resolvedEdges) {
    incrementCount(e.fromSymbol);
    incrementCount(e.toSymbol);
  }
  for (const w of wikilinks) {
    if (w.resolved) {
      incrementCount(w.fromNote);
      incrementCount(w.target);
    }
  }
  return buildSymbolGraph(symbols, resolvedEdges, wikilinks, connectionCounts);
}

function buildSymbolGraph(
  symbols: VaultSymbol[],
  edges: VaultEdge[],
  wikilinks: VaultWikilink[],
  connectionCounts: Map<string, number>,
): Canvas {
  const byId = new Map(symbols.map((s) => [s.symbolId, s]));
  const maxConnections = Math.max(1, ...connectionCounts.values());

  // Group by file for initial positioning
  const byFile = new Map<string, VaultSymbol[]>();
  for (const s of symbols) {
    const arr = byFile.get(s.path) ?? [];
    arr.push(s);
    byFile.set(s.path, arr);
  }

  const files = [...byFile.keys()].sort();
  const nodes: CanvasNode[] = [];

  for (let col = 0; col < files.length; col++) {
    const file = files[col]!;
    const syms = byFile.get(file)!.slice().sort((a, b) => a.startLine - b.startLine);
    const color = LANG_COLORS[syms[0]?.kind ?? 'unknown'] ?? LANG_COLORS.unknown;
    const group = file.split('/').slice(0, 2).join('/');

    for (let row = 0; row < syms.length; row++) {
      const s = syms[row]!;
      const connections = connectionCounts.get(s.symbolId) ?? 0;
      const size = nodeSize(connections);
      const weight = connections / maxConnections;

      nodes.push({
        id: s.symbolId,
        type: 'text',
        text: `**${s.kind}** ${s.name}\n\n*${file}:${s.startLine}*`,
        x: col * 320,
        y: row * 100,
        width: size.width,
        height: size.height,
        color,
        file,
        kind: s.kind,
        weight,
        group,
      });
    }
  }

  const canvasEdges: CanvasEdge[] = [];
  let i = 0;
  for (const e of edges) {
    canvasEdges.push({
      id: `e${++i}`,
      fromNode: e.fromSymbol,
      toNode: e.toSymbol,
      label: e.kind,
    });
  }
  for (const w of wikilinks) {
    if (w.resolved && byId.has(w.fromNote) && byId.has(w.target)) {
      canvasEdges.push({
        id: `wiki-${++i}`,
        fromNode: w.fromNote,
        toNode: w.target,
        label: 'wikilink',
      });
    }
  }

  return { nodes, edges: canvasEdges };
}

function buildFileGraph(
  files: VaultFile[],
  symbolEdges: VaultEdge[],
  wikilinks: VaultWikilink[],
  symbols: VaultSymbol[],
  connectionCounts: Map<string, number>,
): Canvas {
  const filePaths = new Set(files.map((f) => f.path));
  const symbolToFile = new Map<string, string>();
  for (const s of symbols) symbolToFile.set(s.symbolId, s.path);

  // Build file-level edges from symbol edges
  const fileEdgeMap = new Map<string, { from: string; to: string; kind: string; count: number }>();
  const addFileEdge = (from: string, to: string, kind: string) => {
    if (!filePaths.has(from) || !filePaths.has(to) || from === to) return;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    const existing = fileEdgeMap.get(key);
    if (existing) {
      existing.count++;
      if (!existing.kind.includes(kind)) existing.kind += `,${kind}`;
    } else {
      fileEdgeMap.set(key, { from, to, kind, count: 1 });
    }
  };

  for (const e of symbolEdges) {
    const fromFile = symbolToFile.get(e.fromSymbol);
    const toFile = symbolToFile.get(e.toSymbol);
    // Accept unresolved targets if we can map them to a file
    const toFileResolved = toFile ?? guessFileFromUnresolved(e.toSymbol, files);
    if (fromFile && toFileResolved && fromFile !== toFileResolved) {
      addFileEdge(fromFile, toFileResolved, e.kind);
    }
  }

  // Add wikilink edges at file level
  for (const w of wikilinks) {
    if (w.resolved && filePaths.has(w.fromNote) && filePaths.has(w.target)) {
      addFileEdge(w.fromNote, w.target, 'wikilink');
    }
  }

  const maxConnections = Math.max(1, ...connectionCounts.values());

  // Create nodes from files
  const nodes: CanvasNode[] = [];
  const dirColors = new Map<string, string>();
  let colorIdx = 0;
  const palette = Object.values(PASTEL_LANG_COLORS);

  function getDirColor(dir: string): string {
    if (!dirColors.has(dir)) {
      dirColors.set(dir, palette[colorIdx % palette.length]!);
      colorIdx++;
    }
    return dirColors.get(dir)!;
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const connections = connectionCounts.get(f.path) ?? 0;
    const size = nodeSize(connections);
    const dir = f.path.split('/').slice(0, -1).join('/') || '/';
    const color = PASTEL_LANG_COLORS[f.lang] ?? getDirColor(dir);
    const weight = connections / maxConnections;
    const group = dir;

    nodes.push({
      id: f.path,
      type: 'text',
      text: f.path.split('/').pop() ?? f.path,
      x: (i % 10) * 250,
      y: Math.floor(i / 10) * 120,
      width: size.width,
      height: size.height,
      color,
      file: f.path,
      kind: f.lang,
      weight,
      group,
    });
  }

  // Build edges from fileEdgeMap
  const edges: CanvasEdge[] = [];
  let edgeIdx = 0;
  for (const [, e] of fileEdgeMap) {
    edges.push({
      id: `f${++edgeIdx}`,
      fromNode: e.from,
      toNode: e.to,
      label: e.count > 1 ? `${e.kind} (${e.count})` : e.kind,
    });
  }

  return { nodes, edges };
}

/**
 * Best-effort guess for unresolved symbol targets.
 * If the unresolved name matches a file basename (without extension),
 * return that file's path.
 */
function guessFileFromUnresolved(unresolvedId: string, files: VaultFile[]): string | undefined {
  // unresolved IDs look like: "typescript::unresolved::someMethod" or "csharp::unresolved::SomeClass"
  const parts = unresolvedId.split('::');
  const name = parts.pop() ?? unresolvedId;
  // Try exact basename match (case-insensitive), stripping test/spec/d suffixes
  const lowerName = name.toLowerCase();
  for (const f of files) {
    const base = f.path.split('/').pop() ?? f.path;
    const baseNoExt = base
      .replace(/\.(test|spec)\.[^.]+$/, '')   // Foo.test.ts  → Foo
      .replace(/\.d\.ts$/, '')                // Foo.d.ts     → Foo
      .replace(/\.[^.]+$/, '');               // Foo.ts       → Foo
    if (baseNoExt.toLowerCase() === lowerName) return f.path;
  }
  return undefined;
}
