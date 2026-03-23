import { useRef, useEffect } from 'react'
import { useMonitorStore } from '../../stores/monitor-store'

export default function ActivityFeed() {
  const activities = useMonitorStore((s) => s.activities)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activities.length])

  if (activities.length === 0) {
    return <div className="p-4 text-sm text-text-tertiary">No activity yet.</div>
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-3 text-xs">
      <div className="border-l-2 border-border ml-3 flex flex-col gap-2">
        {activities.map((entry, i) => (
          <div
            key={i}
            className="relative flex items-start gap-2 py-1 pr-2 pl-4 rounded hover:bg-surface-hover animate-[admin-fade-in_0.3s_ease]"
          >
            {/* Timeline dot on the border line */}
            <span className="absolute -left-[5px] top-2.5 w-2 h-2 rounded-full bg-accent shrink-0" />
            <span className="text-text-tertiary shrink-0 w-16">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span className="text-text-secondary">
              {entry.tool && (
                <>
                  <span className="bg-white/5 px-1.5 py-0.5 rounded font-mono text-[11px] text-text-secondary mr-1">
                    {entry.tool}
                  </span>
                </>
              )}
              {entry.detail}
            </span>
          </div>
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  )
}
