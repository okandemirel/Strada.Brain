import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/shallow'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import {
  buildRootGroups,
  selectActiveRootLabel,
  selectRootCount,
  useMonitorStore,
} from '../../stores/monitor-store'

/** Truncate a label to keep the trigger compact. */
function truncate(value: string, max = 28): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Root-switcher for the monitor: lists recent request-roots grouped by their
 * conversation, with a human-readable label per root. Clicking a root makes it
 * the active root (its DAG + Kanban become visible). Renders NOTHING when there
 * is one root or fewer, so a single-request session is byte-identical to before
 * (no clutter in the header).
 */
export default function RootSwitcher() {
  const { t } = useTranslation('monitor')
  const rootCount = useMonitorStore(selectRootCount)
  const activeLabel = useMonitorStore(selectActiveRootLabel)
  const setActiveRootId = useMonitorStore((s) => s.setActiveRootId)
  // Subscribe to the RAW inputs with shallow equality, then derive the grouped
  // structure with useMemo. Subscribing to a freshly-allocated array directly
  // would re-render on every store change (new reference each call), so we keep
  // the allocation inside the component instead.
  const rootsById = useMonitorStore(useShallow((s) => s.rootsById))
  const activeRootId = useMonitorStore((s) => s.activeRootId)
  const groups = useMemo(
    () => buildRootGroups(rootsById, activeRootId),
    [rootsById, activeRootId],
  )

  // Single-request UX: hide entirely when there's nothing to switch between.
  if (rootCount <= 1) return null

  const showGroupHeaders = groups.length > 1
  const triggerLabel = activeLabel ? truncate(activeLabel) : t('panel.rootSwitcherSelect')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('panel.rootSwitcher')}
          title={activeLabel ?? t('panel.rootSwitcher')}
          className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-[280px] overflow-y-auto">
        {groups.map((group, groupIndex) => (
          <div key={group.conversationId}>
            {groupIndex > 0 && <DropdownMenuSeparator />}
            {showGroupHeaders && (
              <DropdownMenuLabel className="truncate">
                {t('panel.rootSwitcherConversation')}
              </DropdownMenuLabel>
            )}
            {group.roots.map((root) => (
              <DropdownMenuItem
                key={root.rootId}
                onSelect={() => setActiveRootId(root.rootId)}
                className={root.isActive ? 'bg-white/8 text-text' : ''}
              >
                <span
                  className={`mr-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    root.isActive ? 'bg-accent' : 'bg-transparent'
                  }`}
                  aria-hidden
                />
                <span className="truncate">{root.label}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
