import { useState, useEffect, useCallback, useMemo, type RefObject } from 'react'

interface UseVirtualScrollOptions {
  itemCount: number
  itemHeight: number
  containerRef: RefObject<HTMLElement | null>
  overscan?: number
}

interface VirtualScrollResult {
  startIndex: number
  endIndex: number
  totalHeight: number
  offsetTop: number
}

export function useVirtualScroll({
  itemCount,
  itemHeight,
  containerRef,
  overscan = 5,
}: UseVirtualScrollOptions): VirtualScrollResult {
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (el) {
      setScrollTop(el.scrollTop)
    }
  }, [containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    setContainerHeight(el.clientHeight)
    setScrollTop(el.scrollTop)

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height)
      }
    })
    resizeObserver.observe(el)

    el.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      el.removeEventListener('scroll', handleScroll)
      resizeObserver.disconnect()
    }
  }, [containerRef, handleScroll])

  return useMemo(() => {
    const totalHeight = itemCount * itemHeight

    if (itemCount === 0 || containerHeight === 0) {
      return { startIndex: 0, endIndex: 0, totalHeight, offsetTop: 0 }
    }

    const rawStart = Math.floor(scrollTop / itemHeight)
    const visibleCount = Math.ceil(containerHeight / itemHeight)
    const rawEnd = rawStart + visibleCount

    const startIndex = Math.max(0, rawStart - overscan)
    const endIndex = Math.min(itemCount, rawEnd + overscan)
    const offsetTop = startIndex * itemHeight

    return { startIndex, endIndex, totalHeight, offsetTop }
  }, [itemCount, itemHeight, scrollTop, containerHeight, overscan])
}
