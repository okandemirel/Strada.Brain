import { useEffect, useRef } from 'react'

interface MenuPosition {
  x: number
  y: number
}

interface ContextMenuAction {
  label: string
  icon?: string
  action: () => void
  danger?: boolean
  disabled?: boolean
  divider?: boolean
}

interface CanvasContextMenuProps {
  position: MenuPosition | null
  actions: ContextMenuAction[]
  onClose: () => void
}

export default function CanvasContextMenu({ position, actions, onClose }: CanvasContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!position) return
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [position, onClose])

  if (!position) return null

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[160px] rounded-lg border border-white/10 bg-[#0b1018]/95 py-1 backdrop-blur-xl shadow-2xl"
      style={{ left: position.x, top: position.y }}
    >
      {actions.map((item) => (
        <div key={item.label}>
          {item.divider && <div className="my-1 h-px bg-white/6" />}
          <button
            type="button"
            disabled={item.disabled}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[11px] transition-colors ${
              item.danger
                ? 'text-red-400 hover:bg-red-400/10 hover:text-red-300'
                : 'text-slate-400 hover:bg-white/[0.06] hover:text-white'
            } ${item.disabled ? 'opacity-30 pointer-events-none' : ''}`}
            onClick={() => {
              item.action()
              onClose()
            }}
          >
            {item.icon && <span className="w-3.5 text-center text-xs opacity-60">{item.icon}</span>}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}
