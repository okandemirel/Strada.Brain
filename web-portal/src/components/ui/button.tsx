import { forwardRef, type ButtonHTMLAttributes } from 'react'

type Variant = 'default' | 'outline' | 'ghost' | 'destructive'
type Size = 'default' | 'sm' | 'lg' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const variantClasses: Record<Variant, string> = {
  default: 'bg-accent text-bg hover:bg-accent-hover',
  outline: 'border border-border bg-transparent hover:bg-surface-hover text-text',
  ghost: 'hover:bg-surface-hover text-text',
  destructive: 'bg-error text-white hover:bg-error/80',
}

const sizeClasses: Record<Size, string> = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-11 px-6 text-base',
  icon: 'h-9 w-9',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
