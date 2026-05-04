import type { GraphNode } from './graph-types';

interface Props {
  node: GraphNode;
  x: number;
  y: number;
  connectionCount: number;
}

export function GraphNodeTooltip({ node, x, y, connectionCount }: Props) {
  const fileName = node.file ? node.file.split('/').pop() ?? node.file : null;

  return (
    <div
      className="absolute z-50 pointer-events-none px-3 py-2 rounded-lg bg-[#1a1a1a]/95 backdrop-blur-md
                 border border-white/10 shadow-xl text-xs"
      style={{ left: x + 12, top: y - 12, maxWidth: 240 }}
    >
      <div className="font-medium text-white/80 truncate">{node.label}</div>
      {node.kind && (
        <div className="text-white/40 mt-0.5 capitalize">{node.kind}</div>
      )}
      {fileName && (
        <div className="text-white/30 mt-0.5 truncate font-mono text-[10px]">
          {fileName}
          {node.line ? `:${node.line}` : ''}
        </div>
      )}
      <div className="text-white/30 mt-1 text-[10px]">
        {connectionCount} connection{connectionCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}
