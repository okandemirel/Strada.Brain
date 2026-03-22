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
    <div className="flex flex-col h-full overflow-y-auto p-3 space-y-1.5 text-xs">
      {activities.map((entry, i) => (
        <div key={i} className="flex items-start gap-2 py-1 px-2 rounded hover:bg-surface-hover">
          <span className="text-text-tertiary shrink-0 w-16">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
          <span className="text-text-secondary">{entry.detail}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
