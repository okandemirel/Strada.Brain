import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Kind of vault empty/transient state being rendered.
 *
 *   - `loading`  — request in flight (shows an animated placeholder).
 *   - `no-vault` — no vault selected; prompt the user to pick one.
 *   - `no-match` — query/filter returned zero results.
 *   - `empty`    — vault has no data yet (e.g. tree not indexed).
 *   - `error`    — request failed; optionally shows a retry button.
 */
export type VaultEmptyStateKind =
  | 'loading'
  | 'no-vault'
  | 'no-match'
  | 'empty'
  | 'error';

export interface VaultEmptyStateProps {
  kind: VaultEmptyStateKind;
  /** Primary label already translated by the caller. */
  label: string;
  /** Optional secondary hint (smaller, less prominent). */
  hint?: string;
  /** Icon slot — usually a `lucide-react` icon; rendered at 18x18. */
  icon?: ReactNode;
  /** Error-state retry affordance. Rendered only when `kind === 'error'`. */
  onRetry?: () => void;
  /** Text for the retry button (caller-translated). */
  retryLabel?: string;
  /**
   * Layout mode. `full` fills the available space (h-full flex center), while
   * `inline` keeps its original flow — useful inside tight list panels.
   */
  variant?: 'full' | 'inline';
  className?: string;
}

/**
 * Reusable empty / loading / error placeholder shared by vault panes.
 *
 * Replaces five near-identical snippets that previously lived in
 * `FileTreeSidebar`, `VaultSearchTab`, `RightPanel`, and `VaultStatusBar`.
 * Consolidating them lets QA tune the visual treatment in one place.
 */
export function VaultEmptyState({
  kind,
  label,
  hint,
  icon,
  onRetry,
  retryLabel,
  variant = 'full',
  className,
}: VaultEmptyStateProps): React.ReactElement {
  const isLoading = kind === 'loading';
  const isError = kind === 'error';

  const container =
    variant === 'inline'
      ? 'px-3 py-2 text-xs text-[var(--color-text-tertiary)]'
      : 'h-full flex flex-col items-center justify-center gap-1 p-6 text-center';

  if (variant === 'inline') {
    return (
      <div
        className={cn(container, isLoading && 'animate-pulse', className)}
        role={isError ? 'alert' : undefined}
      >
        {label}
      </div>
    );
  }

  return (
    <div className={cn(container, className)} role={isError ? 'alert' : undefined}>
      {icon && (
        <div className="mb-1 text-[var(--color-text-tertiary)] opacity-80">
          {icon}
        </div>
      )}
      <div
        className={cn(
          'text-xs font-medium',
          isError
            ? 'text-[var(--color-error)]'
            : 'text-[var(--color-text-secondary)]',
          isLoading && 'animate-pulse',
        )}
      >
        {label}
      </div>
      {hint && (
        <div className="text-[10px] text-[var(--color-text-tertiary)]">
          {hint}
        </div>
      )}
      {isError && onRetry && retryLabel && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded',
            'border border-[var(--color-border-subtle)] text-[10px]',
            'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
          )}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export default VaultEmptyState;
