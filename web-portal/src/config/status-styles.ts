export const SEVERITY_DOT: Record<string, string> = {
  success: 'bg-success shadow-[0_0_6px_var(--color-success)]',
  warning: 'bg-warning shadow-[0_0_6px_var(--color-warning)]',
  error: 'bg-error shadow-[0_0_6px_var(--color-error)]',
  info: 'bg-accent shadow-[0_0_6px_var(--color-accent)]',
  neutral: 'bg-text-tertiary',
}

export const SEVERITY_BADGE: Record<string, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
  info: 'bg-accent/10 text-accent',
  neutral: 'bg-white/5 text-text-tertiary',
}
