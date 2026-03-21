import { useEffect, useState } from 'react'
import type {
  McpInstallPlan,
  McpInstallTarget,
  McpRecommendation,
  StradaDepsStatus,
} from '../../types/setup'

interface McpInstallPanelProps {
  projectPath: string
  stradaDeps: StradaDepsStatus
  dependencyWarnings: string[]
  mcpRecommendation: McpRecommendation | null
  mcpInstallStatus: 'idle' | 'installing' | 'success' | 'error'
  mcpInstallError: string | null
  mcpInstallMessage: string | null
  mcpInstallPlan: McpInstallPlan | null
  installButtonLabel?: string
  onInstall: (target: McpInstallTarget) => void
}

interface InstallTargetOption {
  id: McpInstallTarget
  title: string
  eyebrow: string
  description: string
  previewSuffix: string
  manifestDependency: string
}

const INSTALL_TARGETS: InstallTargetOption[] = [
  {
    id: 'packages',
    title: 'Packages/Submodules',
    eyebrow: 'Recommended',
    description: 'Keeps the checkout under Unity Packages and makes the package reference feel native.',
    previewSuffix: 'Packages/Submodules/Strada.MCP',
    manifestDependency: 'file:Submodules/Strada.MCP/unity-package/com.strada.mcp',
  },
  {
    id: 'assets',
    title: 'Assets',
    eyebrow: 'Alternative',
    description: 'Places the checkout under Assets if your project convention keeps integrations there.',
    previewSuffix: 'Assets/Strada.MCP',
    manifestDependency: 'file:../Assets/Strada.MCP/unity-package/com.strada.mcp',
  },
]

function normalizeJoin(rootPath: string, suffix: string): string {
  const trimmedRoot = rootPath.trim().replace(/[\\/]+$/, '')
  if (!trimmedRoot) return suffix
  return `${trimmedRoot}/${suffix}`.replace(/\\/g, '/')
}

function DependencyStatusCard({
  label,
  installed,
  path,
}: {
  label: string
  installed: boolean
  path: string | null
}) {
  return (
    <div className={`mcp-dependency-card ${installed ? 'is-installed' : 'is-missing'}`}>
      <div className="mcp-dependency-label">{label}</div>
      <div className="mcp-dependency-value">{installed ? 'Installed' : 'Missing'}</div>
      <div className="mcp-dependency-path mono">{path ?? 'Not detected in this project'}</div>
    </div>
  )
}

export default function McpInstallPanel({
  projectPath,
  stradaDeps,
  dependencyWarnings,
  mcpRecommendation,
  mcpInstallStatus,
  mcpInstallError,
  mcpInstallMessage,
  mcpInstallPlan,
  installButtonLabel = 'Install Strada.MCP',
  onInstall,
}: McpInstallPanelProps) {
  const [installTarget, setInstallTarget] = useState<McpInstallTarget>(mcpInstallPlan?.target ?? 'packages')

  useEffect(() => {
    if (mcpInstallPlan?.target) {
      setInstallTarget(mcpInstallPlan.target)
    }
  }, [mcpInstallPlan])

  const activeTarget =
    INSTALL_TARGETS.find((option) => option.id === installTarget)
    ?? INSTALL_TARGETS[0]

  const visibleWarnings = Array.from(
    new Set([...dependencyWarnings, ...stradaDeps.warnings]),
  ).slice(0, 3)

  const showInstallFlow = !stradaDeps.mcpInstalled && mcpRecommendation
  const showInstallFeedback = mcpInstallStatus !== 'idle'
  const installButtonText = mcpInstallStatus === 'installing'
    ? 'Installing Strada.MCP...'
    : installButtonLabel

  return (
    <section className={`mcp-panel ${stradaDeps.mcpInstalled ? 'is-installed' : 'is-missing'}`}>
      <div className="mcp-panel-header">
        <div>
          <div className="mcp-panel-eyebrow">
            {stradaDeps.mcpInstalled ? 'Unity runtime connected to Brain' : 'Recommended Unity runtime upgrade'}
          </div>
          <h3 className="mcp-panel-title">Strada.MCP</h3>
          <p className="mcp-panel-copy">
            {stradaDeps.mcpInstalled
              ? `Detected${stradaDeps.mcpVersion ? ` (v${stradaDeps.mcpVersion})` : ''}. Brain can use the live Unity runtime surface from this project.`
              : (mcpRecommendation?.reason
                ?? 'Install Strada.MCP to unlock the live Unity runtime surface inside Strada.Brain.')}
          </p>
        </div>
        <span className={`mcp-runtime-pill ${stradaDeps.mcpInstalled ? 'is-installed' : 'is-missing'}`}>
          {stradaDeps.mcpInstalled ? 'Runtime ready' : 'Runtime missing'}
        </span>
      </div>

      <div className="mcp-dependency-grid">
        <DependencyStatusCard
          label="Strada.Core"
          installed={stradaDeps.coreInstalled}
          path={stradaDeps.corePath}
        />
        <DependencyStatusCard
          label="Strada.Modules"
          installed={stradaDeps.modulesInstalled}
          path={stradaDeps.modulesPath}
        />
        <DependencyStatusCard
          label="Strada.MCP"
          installed={stradaDeps.mcpInstalled}
          path={stradaDeps.mcpPath}
        />
      </div>

      {visibleWarnings.length > 0 && (
        <div className="mcp-inline-note warning">
          {visibleWarnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      {stradaDeps.mcpInstalled && stradaDeps.mcpPath && (
        <div className="mcp-install-summary">
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">Detected path</span>
            <span className="mcp-summary-value mono">{stradaDeps.mcpPath}</span>
          </div>
          {stradaDeps.mcpVersion && (
            <div className="mcp-summary-item">
              <span className="mcp-summary-label">Version</span>
              <span className="mcp-summary-value">{stradaDeps.mcpVersion}</span>
            </div>
          )}
        </div>
      )}

      {showInstallFlow && (
        <>
          <div className="mcp-feature-list">
            {mcpRecommendation.featureList.slice(0, 4).map((feature) => (
              <div key={feature} className="mcp-feature-chip">
                {feature}
              </div>
            ))}
          </div>

          <div className="mcp-guidance-grid">
            <div className="mcp-guidance-card">
              <div className="mcp-guidance-title">What Brain will do</div>
              <ul className="mcp-checklist">
                <li>Add Strada.MCP as a git submodule inside the Unity project.</li>
                <li>Wire `com.strada.mcp` into `Packages/manifest.json`.</li>
                <li>Run `npm install` so Brain can load the runtime immediately.</li>
              </ul>
            </div>
            <div className="mcp-guidance-card">
              <div className="mcp-guidance-title">Discovery</div>
              <p>{mcpRecommendation.discoveryHint ?? 'Brain auto-detects sibling and project-local Strada.MCP installs.'}</p>
              <div className="mcp-guidance-title secondary">Install note</div>
              <p>{mcpRecommendation.installHint ?? 'Choose where the checkout should live inside the project.'}</p>
            </div>
          </div>

          <div className="mcp-target-grid" role="radiogroup" aria-label="Strada.MCP install target">
            {INSTALL_TARGETS.map((option) => {
              const selected = option.id === installTarget
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`mcp-target-card ${selected ? 'selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => setInstallTarget(option.id)}
                >
                  <div className="mcp-target-header">
                    <div>
                      <div className="mcp-target-eyebrow">{option.eyebrow}</div>
                      <div className="mcp-target-title">{option.title}</div>
                    </div>
                    {option.id === 'packages' && (
                      <span className="mcp-target-badge">Best default</span>
                    )}
                  </div>
                  <p className="mcp-target-copy">{option.description}</p>
                  <div className="mcp-target-preview mono">
                    {normalizeJoin(projectPath, option.previewSuffix)}
                  </div>
                  <div className="mcp-target-preview-label">Manifest dependency</div>
                  <div className="mcp-target-preview mono">{option.manifestDependency}</div>
                </button>
              )
            })}
          </div>

          <div className="mcp-install-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={mcpInstallStatus === 'installing' || projectPath.trim().length === 0}
              onClick={() => onInstall(installTarget)}
            >
              {installButtonText}
            </button>
          </div>
        </>
      )}

      {showInstallFeedback && (
        <div
          className={`mcp-install-feedback ${mcpInstallStatus === 'error'
            ? 'error'
            : mcpInstallStatus === 'success'
              ? 'success'
              : mcpInstallStatus === 'installing'
                ? 'working'
                : ''}`}
          aria-live="polite"
        >
          {mcpInstallStatus === 'installing' && (
            <div>
              Preparing <span className="mono">{normalizeJoin(projectPath, activeTarget.previewSuffix)}</span> and bootstrapping the runtime.
            </div>
          )}
          {mcpInstallStatus === 'success' && (
            <div>{mcpInstallMessage ?? 'Strada.MCP installed successfully.'}</div>
          )}
          {mcpInstallStatus === 'error' && (
            <div>{mcpInstallError ?? 'Strada.MCP install failed.'}</div>
          )}
        </div>
      )}

      {mcpInstallPlan && (
        <div className="mcp-install-summary">
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">Installed into</span>
            <span className="mcp-summary-value mono">{mcpInstallPlan.submodulePath}</span>
          </div>
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">Unity package</span>
            <span className="mcp-summary-value mono">{mcpInstallPlan.manifestDependency}</span>
          </div>
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">Runtime bootstrap</span>
            <span className="mcp-summary-value">{mcpInstallPlan.npmInstallRan ? 'npm install completed' : 'Pending'}</span>
          </div>
        </div>
      )}
    </section>
  )
}
