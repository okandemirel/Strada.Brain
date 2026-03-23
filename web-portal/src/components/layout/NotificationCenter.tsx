import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { ScrollArea } from '../ui/scroll-area'
import { Badge } from '../ui/badge'
import { Separator } from '../ui/separator'
import { X } from 'lucide-react'

interface NotificationCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function NotificationCenter({ open, onOpenChange }: NotificationCenterProps) {
  const notifications = useWorkspaceStore((s) => s.notifications)
  const dismissNotification = useWorkspaceStore((s) => s.dismissNotification)

  const today = new Date().setHours(0, 0, 0, 0)
  const todayItems = [...notifications].filter((n) => n.timestamp >= today).reverse()
  const olderItems = [...notifications].filter((n) => n.timestamp < today).reverse()

  const severityDot: Record<string, string> = {
    error: 'bg-error',
    warning: 'bg-warning',
    info: 'bg-accent',
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 bg-bg-secondary/90 backdrop-blur-xl border-white/10 p-0">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="flex items-center gap-2 text-base">
            Notifications
            {notifications.length > 0 && <Badge variant="secondary">{notifications.length}</Badge>}
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-5rem)]">
          {notifications.length === 0 ? (
            <div className="text-center text-sm text-text-tertiary py-16">No notifications</div>
          ) : (
            <div className="px-2">
              {todayItems.length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide px-2 py-1.5">Today</div>
                  {todayItems.map((n) => (
                    <div key={n.id} className="flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-bg-tertiary transition-colors group">
                      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[n.severity] ?? 'bg-accent'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-text truncate">{n.title}</div>
                        <div className="text-[11px] text-text-secondary truncate">{n.message}</div>
                      </div>
                      <button
                        onClick={() => dismissNotification(n.id)}
                        className="shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 text-text-tertiary transition-opacity cursor-pointer bg-transparent border-none p-0.5"
                        aria-label="Dismiss"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {olderItems.length > 0 && (
                <>
                  {todayItems.length > 0 && <Separator className="my-1" />}
                  <div>
                    <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide px-2 py-1.5">Earlier</div>
                    {olderItems.map((n) => (
                      <div key={n.id} className="flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-bg-tertiary transition-colors group">
                        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[n.severity] ?? 'bg-accent'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-text truncate">{n.title}</div>
                          <div className="text-[11px] text-text-secondary truncate">{n.message}</div>
                        </div>
                        <button
                          onClick={() => dismissNotification(n.id)}
                          className="shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 text-text-tertiary transition-opacity cursor-pointer bg-transparent border-none p-0.5"
                          aria-label="Dismiss"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
