import type { BrowseEntry } from '../../types/setup'

interface DirectoryBrowserProps {
  isOpen: boolean
  currentPath: string
  entries: BrowseEntry[]
  isUnityProject: boolean
  loading: boolean
  error: string | null
  browseTo: (path: string) => void
  onSelect: () => void
  onClose: () => void
}

function Breadcrumbs({
  path,
  onNavigate,
}: {
  path: string
  onNavigate: (path: string) => void
}) {
  if (!path) return null

  const separator = path.includes('\\') ? '\\' : '/'
  const segments = path.split(separator).filter(Boolean)

  return (
    <div className="browser-breadcrumbs">
      <button
        className="breadcrumb-segment"
        onClick={() => onNavigate(separator)}
      >
        {separator}
      </button>
      {segments.map((segment, i) => {
        const segmentPath = separator + segments.slice(0, i + 1).join(separator)
        return (
          <span key={segmentPath} className="breadcrumb-item">
            <span className="breadcrumb-separator">/</span>
            <button
              className="breadcrumb-segment"
              onClick={() => onNavigate(segmentPath)}
            >
              {segment}
            </button>
          </span>
        )
      })}
    </div>
  )
}

export default function DirectoryBrowser({
  isOpen,
  currentPath,
  entries,
  isUnityProject,
  loading,
  error,
  browseTo,
  onSelect,
  onClose,
}: DirectoryBrowserProps) {
  if (!isOpen) return null

  const separator = currentPath.includes('\\') ? '\\' : '/'

  const handleEntryClick = (entry: BrowseEntry) => {
    const nextPath = currentPath.endsWith(separator)
      ? `${currentPath}${entry.name}`
      : `${currentPath}${separator}${entry.name}`
    browseTo(nextPath)
  }

  const handleParent = () => {
    const lastSep = currentPath.lastIndexOf(separator)
    if (lastSep > 0) {
      browseTo(currentPath.slice(0, lastSep))
    } else {
      browseTo(separator)
    }
  }

  return (
    <div className="browser-overlay" onClick={onClose}>
      <div className="browser-modal" onClick={(e) => e.stopPropagation()}>
        <div className="browser-header">
          <h3>Browse Directory</h3>
          {isUnityProject && (
            <span className="unity-badge">Unity Project</span>
          )}
        </div>

        <Breadcrumbs path={currentPath} onNavigate={browseTo} />

        <div className="browser-entries">
          {loading && <div className="browser-loading">Loading...</div>}

          {error && <div className="browser-error">{error}</div>}

          {!loading && !error && (
            <>
              {currentPath && currentPath !== separator && (
                <button className="browser-entry parent" onClick={handleParent}>
                  ..
                </button>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.name}
                  className="browser-entry"
                  onClick={() => handleEntryClick(entry)}
                >
                  {entry.name}
                </button>
              ))}
              {entries.length === 0 && !currentPath && (
                <div className="browser-empty">No entries found</div>
              )}
            </>
          )}
        </div>

        <div className="browser-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSelect}>
            Select
          </button>
        </div>
      </div>
    </div>
  )
}
