import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

// Set theme attribute before first render to prevent flash
const savedTheme = typeof window !== 'undefined'
  ? localStorage.getItem('strada-theme') ?? 'dark'
  : 'dark'
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', savedTheme)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem('strada-theme')
    return saved === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('strada-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggleTheme }
}
