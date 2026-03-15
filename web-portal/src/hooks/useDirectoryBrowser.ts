import { useState, useCallback } from 'react'
import type { BrowseEntry } from '../types/setup'

export function useDirectoryBrowser() {
  const [isOpen, setIsOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [isUnityProject, setIsUnityProject] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browseTo = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/setup/browse?path=${encodeURIComponent(path)}`)
      const data = await res.json()
      if (data.error) {
        setError(data.error)
        setEntries([])
        setIsUnityProject(false)
      } else {
        setCurrentPath(data.path ?? path)
        setEntries(data.entries ?? [])
        setIsUnityProject(data.isUnityProject ?? false)
      }
    } catch {
      setError('Failed to browse directory')
      setEntries([])
      setIsUnityProject(false)
    } finally {
      setLoading(false)
    }
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
    browseTo('')
  }, [browseTo])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const selectFolder = useCallback((): string => {
    setIsOpen(false)
    return currentPath
  }, [currentPath])

  return {
    // State
    isOpen,
    currentPath,
    entries,
    isUnityProject,
    loading,
    error,

    // Methods
    open,
    close,
    browseTo,
    selectFolder,
  }
}
