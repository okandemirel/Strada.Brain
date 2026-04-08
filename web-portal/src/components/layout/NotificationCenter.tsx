import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { ScrollArea } from '../ui/scroll-area'
import { Badge } from '../ui/badge'
import { Separator } from '../ui/separator'
import { X } from 'lucide-react'
import { SEVERITY_DOT } from '../../config/status-styles'

interface NotificationCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface NotificationEntry {
  id: string
  title: string
  message: string
  severity: string
  timestamp: number
}

const SWIPE_THRESHOLD = 80

function NotificationItem({ n, onDismiss }: { n: NotificationEntry; onDismiss: (id: string) => void }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [offsetX, setOffsetX] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const offsetXRef = useRef(0)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0]!.clientX
    draggingRef.current = true
    setIsDragging(true)
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!draggingRef.current) return
    const dx = e.touches[0]!.clientX - startXRef.current
    const clamped = Math.max(dx, -200)
    offsetXRef.current = clamped
    setOffsetX(clamped)
  }, [])

  const onTouchEnd = useCallback(() => {
    draggingRef.current = false
    setIsDragging(false)
    if (offsetXRef.current < -SWIPE_THRESHOLD) {
      onDismiss(n.id)
    } else {
      offsetXRef.current = 0
      setOffsetX(0)
    }
  }, [onDismiss, n.id])

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Swipe dismiss background */}
      {offsetX < 0 && (
        <div className="absolute inset-0 flex items-center justify-end pr-4 bg-error/20 rounded-lg">
          <X size={16} className="text-error" />
        </div>
      )}
      <div
        className="flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-bg-tertiary transition-colors group cursor-pointer bg-bg-secondary/80"
        style={{ transform: `translateX(${offsetX}px)`, transition: isDragging ? 'none' : 'transform 0.2s ease-out' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_DOT[n.severity] ?? SEVERITY_DOT.info}`} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-text truncate">{n.title}</div>
          <div className={`text-[11px] text-text-secondary ${expanded ? '' : 'line-clamp-2'}`}>{n.message}</div>
          {n.message.length > 80 && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              className="text-[10px] text-accent/70 hover:text-accent mt-0.5 bg-transparent border-none p-0 cursor-pointer"
            >
              {expanded ? t('notifications.showLess', 'Show less') : t('notifications.showMore', 'Show more')}
            </button>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(n.id) }}
          className="shrink-0 opacity-70 hover:opacity-100 text-text-tertiary transition-opacity cursor-pointer bg-transparent border-none p-0.5"
          aria-label={t('notifications.dismiss')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

export default function NotificationCenter({ open, onOpenChange }: NotificationCenterProps) {
  const { t } = useTranslation()
  const notifications = useWorkspaceStore((s) => s.notifications)
  const dismissNotification = useWorkspaceStore((s) => s.dismissNotification)

  const today = new Date().setHours(0, 0, 0, 0)
  const todayItems = [...notifications].filter((n) => n.timestamp >= today).reverse()
  const olderItems = [...notifications].filter((n) => n.timestamp < today).reverse()

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 bg-bg-secondary/90 backdrop-blur-xl border-white/10 p-0">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="flex items-center gap-2 text-base">
            {t('notifications.title')}
            {notifications.length > 0 && <Badge variant="secondary">{notifications.length}</Badge>}
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-5rem)]">
          {notifications.length === 0 ? (
            <div className="text-center text-sm text-text-tertiary py-16">{t('notifications.empty')}</div>
          ) : (
            <div className="px-2">
              {todayItems.length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide px-2 py-1.5">{t('notifications.today')}</div>
                  {todayItems.map((n) => (
                    <NotificationItem key={n.id} n={n} onDismiss={dismissNotification} />
                  ))}
                </div>
              )}
              {olderItems.length > 0 && (
                <>
                  {todayItems.length > 0 && <Separator className="my-1" />}
                  <div>
                    <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide px-2 py-1.5">{t('notifications.earlier')}</div>
                    {olderItems.map((n) => (
                      <NotificationItem key={n.id} n={n} onDismiss={dismissNotification} />
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
