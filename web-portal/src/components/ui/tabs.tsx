import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

export const Tabs = TabsPrimitive.Root

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={`inline-flex items-center justify-center rounded-lg bg-bg-tertiary p-1 ${className}`}
    {...props}
  />
))
TabsList.displayName = 'TabsList'

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text data-[state=active]:bg-surface data-[state=active]:text-text ${className}`}
    {...props}
  />
))
TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={`mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    {...props}
  />
))
TabsContent.displayName = 'TabsContent'
