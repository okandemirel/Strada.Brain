import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';

function GraphEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  selected,
  style,
  markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? 'var(--graph-edge-active)' : 'var(--graph-edge)',
          strokeWidth: selected ? 2 : 1.2,
          transition: 'stroke 120ms, stroke-width 120ms',
          ...style,
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="absolute pointer-events-none text-[10px] px-1.5 py-0.5 rounded bg-[var(--graph-panel-bg)] border border-[var(--graph-panel-border)] text-muted-foreground whitespace-nowrap"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {String(label)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const GraphEdge = memo(GraphEdgeComponent);
GraphEdge.displayName = 'GraphEdge';
