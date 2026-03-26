import type { McpInstallPlan, McpInstallTarget, McpRecommendation, StradaDepPackage, StradaDepsStatus } from '../../types/setup'
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
  depInstallStatus: Partial<Record<StradaDepPackage, 'idle' | 'installing' | 'success' | 'error'>>
  depInstallError: Partial<Record<StradaDepPackage, string | null>>
  validatePath: () => Promise<void>
  installMcp: (target: McpInstallTarget) => Promise<boolean>
  installDep: (pkg: StradaDepPackage, overridePath?: string) => Promise<boolean>
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
  depInstallStatus,
  depInstallError,
  validatePath,
  installMcp,
  installDep,
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
          <div className={`path-status ${pathValid ? (pathIsUnityProject ? 'valid' : 'warning') : 'invalid'}`}>
            {pathValid
              ? (pathIsUnityProject
                  ? 'Valid Unity project path'
                  : 'Valid path, but this is not a Unity project (Assets/ and ProjectSettings/ not found)')
              : (pathError ?? 'Invalid path')}
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
            depInstallStatus={depInstallStatus}
            depInstallError={depInstallError}
            onInstall={(target) => {
              void installMcp(target)
            }}
            onInstallDep={(pkg) => {
              void installDep(pkg)
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
