import type { McpRecommendation, StradaDepsStatus } from '../../types/setup'

interface ProjectPathStepProps {
  projectPath: string
  setProjectPath: (path: string) => void
  pathValid: boolean | null
  pathError: string | null
  pathIsUnityProject: boolean
  pathStradaDeps: StradaDepsStatus | null
  pathDependencyWarnings: string[]
  pathMcpRecommendation: McpRecommendation | null
  validatePath: () => Promise<void>
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
  validatePath,
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
          <div className="path-status valid" style={{ marginTop: 12, display: 'block' }}>
            <div><strong>Unity project detected</strong></div>
            <div>Core: {pathStradaDeps.coreInstalled ? 'installed' : 'missing'}</div>
            <div>Modules: {pathStradaDeps.modulesInstalled ? 'installed' : 'missing'}</div>
            <div>MCP: {pathStradaDeps.mcpInstalled ? 'installed' : 'missing'}</div>
            {pathDependencyWarnings.map((warning) => (
              <div key={warning} style={{ marginTop: 6 }}>{warning}</div>
            ))}
            {!pathStradaDeps.mcpInstalled && pathMcpRecommendation && (
              <>
                <div style={{ marginTop: 8 }}><strong>MCP recommendation</strong></div>
                <div>{pathMcpRecommendation.reason}</div>
                <div>{pathMcpRecommendation.featureList.join(' • ')}</div>
                {pathMcpRecommendation.discoveryHint && (
                  <div>{pathMcpRecommendation.discoveryHint}</div>
                )}
              </>
            )}
          </div>
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
