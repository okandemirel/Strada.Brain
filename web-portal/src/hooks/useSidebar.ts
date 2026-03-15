import { useState, useCallback } from 'react'

const STORAGE_KEY = 'strada-sidebar-collapsed'

export function useSidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === '1'
  })

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  return { collapsed, toggle }
}
