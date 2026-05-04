import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  connectionCounts: Map<string, number>;
}

export function GraphStatsOverlay({ nodeCount, edgeCount, fileCount, connectionCounts }: Props) {
  const { t } = useTranslation('vault');

  const isolatedCount = useMemo(() => {
    // Nodes without any connections are not in connectionCounts map
    return Math.max(0, nodeCount - connectionCounts.size);
  }, [nodeCount, connectionCounts]);

  const hubInfo = useMemo(() => {
    let maxId = '';
    let maxCount = 0;
    for (const [id, count] of connectionCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxId = id;
      }
    }
    return { id: maxId, count: maxCount };
  }, [connectionCounts]);

  return (
    <div className="absolute bottom-3 left-3 z-10 pointer-events-none select-none">
      <div className="text-[10px] text-muted-foreground/50 leading-relaxed">
        <div>
          {nodeCount} {t('stats.nodes', { count: nodeCount, defaultValue: 'nodes' })} · {edgeCount}{' '}
          {t('stats.edges', { count: edgeCount, defaultValue: 'edges' })}
        </div>
        {fileCount > 0 && (
          <div>
            {fileCount} {t('stats.files', { count: fileCount, defaultValue: 'files' })}
          </div>
        )}
        {isolatedCount > 0 && (
          <div>
            {isolatedCount} {t('stats.isolated', { count: isolatedCount, defaultValue: 'isolated' })}
          </div>
        )}
        {hubInfo.count > 0 && (
          <div className="truncate max-w-[200px]" title={hubInfo.id}>
            {t('stats.topHub', { defaultValue: 'Top hub' })}: {hubInfo.id} ({hubInfo.count})
          </div>
        )}
      </div>
    </div>
  );
}
