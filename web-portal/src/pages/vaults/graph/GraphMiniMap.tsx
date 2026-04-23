import { useTranslation } from 'react-i18next';
import { MiniMap, type Node } from '@xyflow/react';
import { getKindStyle } from './node-style';

function nodeColor(node: Node): string {
  const kind = (node.data as { kind?: string | null } | undefined)?.kind ?? null;
  return getKindStyle(kind).color;
}

export function GraphMiniMap() {
  const { t } = useTranslation('vault');
  return (
    <MiniMap
      position="bottom-right"
      pannable
      zoomable
      ariaLabel={t('graph.minimapLabel')}
      maskColor="var(--graph-minimap-mask)"
      style={{
        background: 'var(--graph-minimap-bg)',
        border: '1px solid var(--graph-panel-border)',
        borderRadius: 6,
      }}
      nodeColor={nodeColor}
      nodeStrokeColor={nodeColor}
      nodeStrokeWidth={0}
    />
  );
}
