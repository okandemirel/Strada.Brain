import type { ReactNode } from 'react'

/**
 * Shared empty-state for admin pages. Replaces the empty-state markup that was
 * duplicated across ~8 pages. Markup matches the previous inline block exactly
 * so converted pages render identically; `icon`/`action` are optional additions.
 * (Distinct from the chat-branded `components/EmptyState` and the vault
 * `VaultEmptyState`.)
 */
export function PageEmptyState({ icon, title, description, action }: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
      {icon && <div className="text-4xl">{icon}</div>}
      <h3 className="text-text text-lg font-semibold">{title}</h3>
      {description && <p className="text-sm max-w-[400px]">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
