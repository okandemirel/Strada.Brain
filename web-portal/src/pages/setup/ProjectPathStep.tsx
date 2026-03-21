import { useState } from 'react'
import type { McpInstallTarget, McpRecommendation, StradaDepsStatus } from '../../types/setup'

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
  validatePath,
  installMcp,
  openBrowser,
  onNext,
  onBack,
}: ProjectPathStepProps) {
  const [installTarget, setInstallTarget] = useState<McpInstallTarget>('packages')

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
            {mcpInstallMessage && (
              <div style={{ marginTop: 8 }}>{mcpInstallMessage}</div>
            )}
            {mcpInstallError && (
              <div style={{ marginTop: 8 }}>{mcpInstallError}</div>
            )}
            {!pathStradaDeps.mcpInstalled && pathMcpRecommendation && (
              <>
                <div style={{ marginTop: 8 }}><strong>MCP recommendation</strong></div>
                <div>{pathMcpRecommendation.reason}</div>
                <div>{pathMcpRecommendation.featureList.join(' • ')}</div>
                {pathMcpRecommendation.discoveryHint && (
                  <div>{pathMcpRecommendation.discoveryHint}</div>
                )}
                {pathMcpRecommendation.installHint && (
                  <div style={{ marginTop: 6 }}>{pathMcpRecommendation.installHint}</div>
                )}
                <div style={{ marginTop: 12 }}><strong>Install Strada.MCP now</strong></div>
                <div style={{ marginTop: 6 }}>
                  Brain will add Strada.MCP as a git submodule, point Unity at `com.strada.mcp`, and run `npm install` in the checkout so the MCP runtime is ready.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label htmlFor="mcp-install-target"><strong>Location</strong></label>
                  <select
                    id="mcp-install-target"
                    value={installTarget}
                    onChange={(e) => setInstallTarget(e.target.value as McpInstallTarget)}
                  >
                    <option value="packages">Packages/Submodules/Strada.MCP</option>
                    <option value="assets">Assets/Strada.MCP</option>
                  </select>
                  <button
                    className="btn btn-secondary"
                    disabled={mcpInstallStatus === 'installing'}
                    onClick={() => {
                      void installMcp(installTarget)
                    }}
                  >
                    {mcpInstallStatus === 'installing' ? 'Installing...' : 'Install MCP'}
                  </button>
                </div>
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
