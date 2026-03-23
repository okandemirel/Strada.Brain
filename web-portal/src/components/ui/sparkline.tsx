import { memo } from 'react'
import { cn } from '@/lib/utils'

export const Sparkline = memo(function Sparkline({ data, className }: { data: number[]; className?: string }) {
  if (!data || data.length < 2) return null
  const max = data.reduce((m, v) => (v > m ? v : m), -Infinity)
  const min = data.reduce((m, v) => (v < m ? v : m), Infinity)
  const range = max - min || 1
  const w = 80
  const h = 24
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(' ')
  return (
    <svg width={w} height={h} className={cn('inline-block', className)} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={points} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
})
