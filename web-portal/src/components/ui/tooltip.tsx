// Re-exports are intentional — wrapping Radix primitives for consistent styling
/* eslint-disable react-refresh/only-export-components */
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className = '', sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={`z-50 overflow-hidden rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text shadow-md data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 ${className}`}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = 'TooltipContent'
