import type { BrowseEntry, McpRecommendation, StradaDepsStatus } from '../../types/setup'

interface DirectoryBrowserProps {
  isOpen: boolean
  currentPath: string
  entries: BrowseEntry[]
  isUnityProject: boolean
  stradaDeps: StradaDepsStatus | null
  dependencyWarnings: string[]
  mcpRecommendation: McpRecommendation | null
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
  stradaDeps,
  dependencyWarnings,
  mcpRecommendation,
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
          {!loading && !error && isUnityProject && stradaDeps && (
            <div className="browser-empty" style={{ textAlign: 'left' }}>
              <strong>Dependencies</strong>
              <div>Core: {stradaDeps.coreInstalled ? 'installed' : 'missing'}</div>
              <div>Modules: {stradaDeps.modulesInstalled ? 'installed' : 'missing'}</div>
              <div>MCP: {stradaDeps.mcpInstalled ? 'installed' : 'missing'}</div>
              {dependencyWarnings.slice(0, 2).map((warning) => (
                <div key={warning} className="browser-error" style={{ marginTop: 8 }}>
                  {warning}
                </div>
              ))}
              {!stradaDeps.mcpInstalled && mcpRecommendation && (
                <div style={{ marginTop: 8 }}>
                  <strong>MCP recommendation</strong>
                  <div>{mcpRecommendation.reason}</div>
                  <div>{mcpRecommendation.featureList.join(' • ')}</div>
                  {mcpRecommendation.discoveryHint && (
                    <div>{mcpRecommendation.discoveryHint}</div>
                  )}
                </div>
              )}
            </div>
          )}
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
