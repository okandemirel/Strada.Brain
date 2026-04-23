import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { getKindStyle, parseNodeText } from './node-style';

export interface GraphNodeData extends Record<string, unknown> {
  /** Backend canvas text: `**kind** name\n\n*file:line*` */
  label: string;
  /** CanvasNode.kind passthrough — null for file-level / unknown. */
  kind: string | null;
  /** Caller count normalized 0..1, used for visual weight. */
  weight: number;
}

function GraphNodeComponent({ data, selected }: NodeProps) {
  const { t } = useTranslation('vault');
  const nodeData = data as GraphNodeData;
  const parsed = parseNodeText(nodeData.label ?? '');
  const kind = nodeData.kind ?? parsed.kind;
  const style = getKindStyle(kind);
  const Icon = style.icon;
  const fileName = parsed.file ? parsed.file.split('/').pop() : null;
  const kindLabel = t(`filter.kind.${kind ?? 'unknown'}`, {
    defaultValue: kind ?? 'symbol',
  });

  return (
    <div
      className={cn(
        'relative rounded-lg border transition-all overflow-hidden',
        'bg-[var(--graph-node-surface)] hover:bg-[var(--graph-node-surface-hover)]',
        'border-[var(--graph-node-border)] hover:border-[var(--graph-node-border-hover)]',
        selected && 'ring-2 ring-[var(--graph-node-selected-ring)]',
      )}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: style.color,
        boxShadow: selected ? 'var(--graph-glow)' : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-[var(--graph-edge)] !border-0"
      />
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--graph-node-border)]">
        <Icon className="w-3 h-3 flex-shrink-0" style={{ color: style.color }} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">
          {kindLabel}
        </span>
      </div>
      <div className="px-2 py-1.5">
        <div className="text-xs font-medium truncate text-foreground">{parsed.name}</div>
        {fileName && parsed.line != null && (
          <div className="text-[10px] text-muted-foreground truncate">
            {fileName}:{parsed.line}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-[var(--graph-edge)] !border-0"
      />
    </div>
  );
}

export const GraphNode = memo(GraphNodeComponent);
GraphNode.displayName = 'GraphNode';
