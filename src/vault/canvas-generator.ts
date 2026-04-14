import type { VaultSymbol, VaultEdge } from './vault.interface.js';

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

const NODE_W = 220;
const NODE_H = 60;
const COL_STRIDE = NODE_W + 40;
const ROW_STRIDE = NODE_H + 40;

function colorForFile(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return `#${(h & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function buildCanvas(input: { symbols: VaultSymbol[]; edges: VaultEdge[] }): Canvas {
  const byId = new Map(input.symbols.map((s) => [s.symbolId, s]));
  // Group symbols by file → file becomes a column, symbols rows inside the column.
  const byFile = new Map<string, VaultSymbol[]>();
  for (const s of input.symbols) {
    const arr = byFile.get(s.path) ?? [];
    arr.push(s);
    byFile.set(s.path, arr);
  }
  const files = [...byFile.keys()].sort();
  const nodes: CanvasNode[] = [];
  for (let col = 0; col < files.length; col++) {
    const file = files[col]!;
    const syms = byFile.get(file)!.slice().sort((a, b) => a.startLine - b.startLine);
    const color = colorForFile(file);
    for (let row = 0; row < syms.length; row++) {
      const s = syms[row]!;
      nodes.push({
        id: s.symbolId,
        type: 'text',
        text: `**${s.kind}** ${s.name}\n\n*${file}:${s.startLine}*`,
        x: col * COL_STRIDE,
        y: row * ROW_STRIDE,
        width: NODE_W,
        height: NODE_H,
        color,
        file,
        kind: s.kind,
      });
    }
  }
  const edges: CanvasEdge[] = [];
  let i = 0;
  for (const e of input.edges) {
    if (!byId.has(e.fromSymbol) || !byId.has(e.toSymbol)) continue;
    edges.push({
      id: `e${++i}`,
      fromNode: e.fromSymbol,
      toNode: e.toSymbol,
      label: e.kind,
    });
  }
  return { nodes, edges };
}
