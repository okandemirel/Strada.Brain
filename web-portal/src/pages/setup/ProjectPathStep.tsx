import type { McpInstallPlan, McpInstallTarget, McpRecommendation, StradaDepsStatus } from '../../types/setup'
import McpInstallPanel from './McpInstallPanel'

interface ProjectPathStepProps {
  projectPath: string
  setProjectPath: (path: string) => void
  pathValid: boolean | null
  pathError: string | null
  pathIsUnityProject: boolean
  pathStradaDeps: StradaDepsStatus | null
  pathDependencyWarnings: string[]
  pathMcpRecommendation: McpRecommendation | null
  mcpInstallStatus: 'idle' | 'installing' | 'success' | 'error'
  mcpInstallError: string | null
  mcpInstallMessage: string | null
  mcpInstallPlan: McpInstallPlan | null
  validatePath: () => Promise<void>
  installMcp: (target: McpInstallTarget) => Promise<boolean>
  openBrowser: () => void
  onNext: () => void
  onBack: () => void
}

export default function ProjectPathStep({
  projectPath,
  setProjectPath,
  pathValid,
  pathError,
  pathIsUnityProject,
  pathStradaDeps,
  pathDependencyWarnings,
  pathMcpRecommendation,
  mcpInstallStatus,
  mcpInstallError,
  mcpInstallMessage,
  mcpInstallPlan,
  validatePath,
  installMcp,
  openBrowser,
  onNext,
  onBack,
}: ProjectPathStepProps) {
  return (
    <div className="step">
      <h2>Unity Project</h2>
      <p className="step-subtitle">
        Point Strada.Brain to your Unity project directory.
      </p>

      <div className="path-input-group">
        <div className="path-input-row">
          <input
            type="text"
            className="path-input"
            placeholder="/path/to/your/UnityProject"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
          />
          <button className="btn btn-secondary" onClick={openBrowser}>
            Browse
          </button>
          <button className="btn btn-secondary" onClick={validatePath}>
            Validate
          </button>
        </div>

        {pathValid !== null && (
          <div className={`path-status ${pathValid ? 'valid' : 'invalid'}`}>
            {pathValid ? 'Valid Unity project path' : (pathError ?? 'Invalid path')}
          </div>
        )}

        {pathValid && pathIsUnityProject && pathStradaDeps && (
          <McpInstallPanel
            projectPath={projectPath}
            stradaDeps={pathStradaDeps}
            dependencyWarnings={pathDependencyWarnings}
            mcpRecommendation={pathMcpRecommendation}
            mcpInstallStatus={mcpInstallStatus}
            mcpInstallError={mcpInstallError}
            mcpInstallMessage={mcpInstallMessage}
            mcpInstallPlan={mcpInstallPlan}
            onInstall={(target) => {
              void installMcp(target)
            }}
          />
        )}
      </div>

      <div className="step-actions">
        <button className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          Next
        </button>
      </div>
    </div>
  )
}
