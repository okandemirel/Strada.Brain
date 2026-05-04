import type { VaultSymbol, VaultEdge, VaultFile } from './vault.interface.js';

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
  'csharp': '#6A5ACD',    // SlateBlue
  'typescript': '#3178C6', // TypeScript blue
  'markdown': '#10B981',   // Emerald
  'json': '#F59E0B',       // Amber
  'hlsl': '#EC4899',       // Pink
  'unknown': '#6B7280',    // Gray
};

// Size tiers based on content/connections (Obsidian-style)
function nodeSize(connections: number): { width: number; height: number } {
  if (connections >= 10) return { width: 280, height: 80 };
  if (connections >= 5) return { width: 240, height: 70 };
  if (connections >= 2) return { width: 200, height: 60 };
  return { width: 160, height: 50 };
}

/**
 * Build a rich Obsidian-quality graph canvas.
 * 
 * Strategy:
 * 1. If symbols exist → symbol-centric graph (detailed code view)
 * 2. If no symbols but files exist → file-centric graph (Obsidian-style vault view)
 * 3. If wikilinks exist → use them as edges (Obsidian-style backlinks)
 * 4. If edges exist → use them
 * 5. Fallback → file-folder hierarchy edges
 */
export function buildCanvas(input: {
  symbols: VaultSymbol[];
  edges: VaultEdge[];
  files?: VaultFile[];
}): Canvas {
  const { symbols, edges, files = [] } = input;

  // Count connections per node for sizing
  const connectionCounts = new Map<string, number>();
  const incrementCount = (id: string) => {
    connectionCounts.set(id, (connectionCounts.get(id) ?? 0) + 1);
  };

  for (const e of edges) {
    incrementCount(e.fromSymbol);
    incrementCount(e.toSymbol);
  }

  // If we have symbols, create a symbol-centric graph (code structure view)
  if (symbols.length > 0) {
    return buildSymbolGraph(symbols, edges, connectionCounts);
  }

  // Otherwise, create an Obsidian-style file graph (vault view)
  return buildFileGraph(files, connectionCounts);
}

function buildSymbolGraph(
  symbols: VaultSymbol[], 
  edges: VaultEdge[],
  connectionCounts: Map<string, number>
): Canvas {
  const byId = new Map(symbols.map((s) => [s.symbolId, s]));
  
  // Calculate max connections for normalization
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
  
  // Position symbols in a grid grouped by file
  for (let col = 0; col < files.length; col++) {
    const file = files[col]!;
    const syms = byFile.get(file)!.slice().sort((a, b) => a.startLine - b.startLine);
    const color = LANG_COLORS[syms[0]?.kind ?? 'unknown'] ?? LANG_COLORS.unknown;
    const group = file.split('/').slice(0, 2).join('/'); // e.g., "src/agents"
    
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
    if (!byId.has(e.fromSymbol) || !byId.has(e.toSymbol)) continue;
    canvasEdges.push({
      id: `e${++i}`,
      fromNode: e.fromSymbol,
      toNode: e.toSymbol,
      label: e.kind,
    });
  }
  
  return { nodes, edges: canvasEdges };
}

function buildFileGraph(
  files: VaultFile[],
  connectionCounts: Map<string, number>
): Canvas {
  // Create nodes from files
  const nodes: CanvasNode[] = [];

  // Calculate max connections for normalization
  const maxConnections = Math.max(1, ...connectionCounts.values());

  // Group files by directory for color coding
  const dirColors = new Map<string, string>();
  let colorIdx = 0;
  const palette = Object.values(LANG_COLORS);

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
    const color = LANG_COLORS[f.lang] ?? getDirColor(dir);
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

  // Create directory-based edges (files in same dir are connected)
  const edges: CanvasEdge[] = [];
  let edgeIdx = 0;
  const dirGroups = new Map<string, string[]>();

  for (const f of files) {
    const dir = f.path.split('/').slice(0, -1).join('/') || '/';
    const arr = dirGroups.get(dir) ?? [];
    arr.push(f.path);
    dirGroups.set(dir, arr);
  }

  for (const [, paths] of dirGroups) {
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        edges.push({
          id: `d${++edgeIdx}`,
          fromNode: paths[i]!,
          toNode: paths[j]!,
          label: 'folder',
        });
      }
    }
  }

  return { nodes, edges };
}
