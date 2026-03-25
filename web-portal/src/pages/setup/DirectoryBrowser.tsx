import type {
  BrowseEntry,
  McpInstallPlan,
  McpInstallTarget,
  McpRecommendation,
  StradaDepPackage,
  StradaDepsStatus,
} from '../../types/setup'
import McpInstallPanel from './McpInstallPanel'

interface DirectoryBrowserProps {
  isOpen: boolean
  currentPath: string
  entries: BrowseEntry[]
  isUnityProject: boolean
  stradaDeps: StradaDepsStatus | null
  dependencyWarnings: string[]
  mcpRecommendation: McpRecommendation | null
  mcpInstallStatus: 'idle' | 'installing' | 'success' | 'error'
  mcpInstallError: string | null
  mcpInstallMessage: string | null
  mcpInstallPlan: McpInstallPlan | null
  depInstallStatus?: Partial<Record<StradaDepPackage, 'idle' | 'installing' | 'success' | 'error'>>
  depInstallError?: Partial<Record<StradaDepPackage, string | null>>
  loading: boolean
  error: string | null
  browseTo: (path: string) => void
  installMcp: (target: McpInstallTarget, overridePath?: string) => Promise<boolean>
  installDep?: (pkg: StradaDepPackage) => Promise<boolean>
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
  mcpInstallStatus,
  mcpInstallError,
  mcpInstallMessage,
  mcpInstallPlan,
  depInstallStatus,
  depInstallError,
  loading,
  error,
  browseTo,
  installMcp,
  installDep,
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

        <div className="browser-scroll-region">
          <Breadcrumbs path={currentPath} onNavigate={browseTo} />

          {!loading && !error && isUnityProject && stradaDeps && (
            <div className="browser-context-panel">
              <McpInstallPanel
                projectPath={currentPath}
                stradaDeps={stradaDeps}
                dependencyWarnings={dependencyWarnings}
                mcpRecommendation={mcpRecommendation}
                mcpInstallStatus={mcpInstallStatus}
                mcpInstallError={mcpInstallError}
                mcpInstallMessage={mcpInstallMessage}
                mcpInstallPlan={mcpInstallPlan}
                depInstallStatus={depInstallStatus}
                depInstallError={depInstallError}
                installButtonLabel="Install into this project"
                onInstall={(target) => {
                  void installMcp(target, currentPath).then((installed) => {
                    if (installed) {
                      browseTo(currentPath)
                    }
                  })
                }}
                onInstallDep={installDep ? (pkg) => {
                  void installDep(pkg).then((installed) => {
                    if (installed) {
                      browseTo(currentPath)
                    }
                  })
                } : undefined}
              />
            </div>
          )}

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
