import { useState } from 'react'
import type {
  McpInstallPlan,
  McpInstallTarget,
  McpRecommendation,
  StradaDepInstallSource,
  StradaDepPackage,
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
  depInstallStatus?: Partial<Record<StradaDepPackage, 'idle' | 'installing' | 'success' | 'error'>>
  depInstallError?: Partial<Record<StradaDepPackage, string | null>>
  installButtonLabel?: string
  onInstall: (target: McpInstallTarget) => void
  onInstallDep?: (pkg: StradaDepPackage) => void
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function formatSourceLabel(source?: StradaDepInstallSource | null): string | null {
  switch (source) {
    case 'package-directory':
      return 'Unity package'
    case 'manifest':
      return 'Manifest reference'
    case 'project-local':
      return 'This project'
    case 'configured-path':
      return 'Configured path'
    case 'sibling-checkout':
      return 'Sibling checkout'
    case 'global-install':
      return 'Global install'
    default:
      return null
  }
}

function formatMcpSourceCopy(source?: StradaDepInstallSource | null): string | null {
  switch (source) {
    case 'project-local':
      return 'from this project'
    case 'configured-path':
      return 'from the configured runtime path'
    case 'sibling-checkout':
      return 'from a sibling Strada.MCP checkout'
    case 'global-install':
      return 'from the global install'
    default:
      return null
  }
}

function formatDisplayPath(
  projectPath: string,
  path: string | null,
  source?: StradaDepInstallSource | null,
): string {
  if (!path) {
    return source === 'manifest' ? 'Packages/manifest.json' : 'Not detected in this project'
  }

  const normalizedProject = normalizePath(projectPath.trim()).replace(/\/+$/, '')
  const normalizedPath = normalizePath(path)
  if (
    normalizedProject.length > 0
    && (normalizedPath === normalizedProject || normalizedPath.startsWith(`${normalizedProject}/`))
  ) {
    return normalizedPath.slice(normalizedProject.length).replace(/^\/+/, '') || '.'
  }

  return normalizedPath
}

function DependencyStatusCard({
  projectPath,
  label,
  installed,
  path,
  version,
  source,
  installStatus,
  installError,
  onInstall,
}: {
  projectPath: string
  label: string
  installed: boolean
  path: string | null
  version?: string | null
  source?: StradaDepInstallSource | null
  installStatus?: 'idle' | 'installing' | 'success' | 'error'
  installError?: string | null
  onInstall?: () => void
}) {
  const sourceLabel = formatSourceLabel(source)
  const displayPath = formatDisplayPath(projectPath, path, source)

  return (
    <div className={`mcp-dependency-card ${installed ? 'is-installed' : 'is-missing'}`}>
      <div className="mcp-dependency-topline">
        <div className="mcp-dependency-label">{label}</div>
        <span className={`mcp-dependency-pill ${installed ? 'is-installed' : 'is-missing'}`}>
          {installed ? 'Installed' : 'Missing'}
        </span>
      </div>

      <div className="mcp-dependency-main">
        <div className="mcp-dependency-value">{installed ? (version ? `v${version}` : 'Detected') : 'Install required'}</div>
        {sourceLabel && (
          <div className="mcp-dependency-source">{sourceLabel}</div>
        )}
      </div>

      <div className="mcp-dependency-meta-label">
        {installed ? 'Location' : 'Status'}
      </div>
      <div className="mcp-dependency-path mono">{displayPath}</div>

      {!installed && onInstall && (
        <div className="mcp-dependency-install">
          {installStatus === 'installing' && (
            <span className="mcp-dependency-install-status working">Installing...</span>
          )}
          {installStatus === 'success' && (
            <span className="mcp-dependency-install-status success">Installed</span>
          )}
          {installStatus === 'error' && (
            <span className="mcp-dependency-install-status error">{installError ?? 'Install failed'}</span>
          )}
          {(!installStatus || installStatus === 'idle' || installStatus === 'error') && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={onInstall}
            >
              Install as git submodule
            </button>
          )}
        </div>
      )}
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
  depInstallStatus,
  depInstallError,
  installButtonLabel = 'Install Strada.MCP',
  onInstall,
  onInstallDep,
}: McpInstallPanelProps) {
  const [installTargetOverride, setInstallTargetOverride] = useState<McpInstallTarget | null>(null)
  const installTarget = installTargetOverride ?? mcpInstallPlan?.target ?? 'packages'
  const setInstallTarget = setInstallTargetOverride

  const activeTarget =
    INSTALL_TARGETS.find((option) => option.id === installTarget)
    ?? INSTALL_TARGETS[0]

  const visibleWarnings = Array.from(
    new Set([...dependencyWarnings, ...stradaDeps.warnings]),
  ).slice(0, 3)

  const detectedPackageCount = [
    stradaDeps.coreInstalled,
    stradaDeps.modulesInstalled,
    stradaDeps.mcpInstalled,
  ].filter(Boolean).length
  const showInstallFlow = !stradaDeps.mcpInstalled && mcpRecommendation
  const showInstallFeedback = mcpInstallStatus !== 'idle'
  const installButtonText = mcpInstallStatus === 'installing'
    ? 'Installing Strada.MCP...'
    : installButtonLabel
  const runtimeSourceLabel = formatSourceLabel(stradaDeps.mcpSource)
  const runtimeSourceCopy = formatMcpSourceCopy(stradaDeps.mcpSource)

  return (
    <section className={`mcp-panel ${stradaDeps.mcpInstalled ? 'is-installed' : 'is-missing'}`}>
      <div className="mcp-panel-header">
        <div className="mcp-panel-copy-group">
          <div className="mcp-panel-eyebrow">
            {stradaDeps.mcpInstalled ? 'Unity runtime connected to Brain' : 'Recommended Unity runtime upgrade'}
          </div>
          <div className="mcp-panel-title-row">
            <h3 className="mcp-panel-title">Strada.MCP</h3>
            {stradaDeps.mcpVersion && (
              <span className="mcp-version-chip">v{stradaDeps.mcpVersion}</span>
            )}
          </div>
          <p className="mcp-panel-copy">
            {stradaDeps.mcpInstalled
              ? `Detected${runtimeSourceCopy ? ` ${runtimeSourceCopy}` : ''}. Brain can use the live Unity runtime surface for this Unity project.`
              : (mcpRecommendation?.reason
                ?? 'Install Strada.MCP to unlock the live Unity runtime surface inside Strada.Brain.')}
          </p>
        </div>
        <div className="mcp-panel-runtime">
          <span className={`mcp-runtime-pill ${stradaDeps.mcpInstalled ? 'is-installed' : 'is-missing'}`}>
            {stradaDeps.mcpInstalled ? 'Runtime ready' : 'Runtime missing'}
          </span>
          <div className="mcp-runtime-caption">
            {detectedPackageCount}/3 packages detected
          </div>
        </div>
      </div>

      <div className="mcp-panel-snapshot">
        <div className="mcp-panel-stat">
          <span className="mcp-panel-stat-label">Detected packages</span>
          <span className="mcp-panel-stat-value">{detectedPackageCount}/3</span>
        </div>
        <div className="mcp-panel-stat">
          <span className="mcp-panel-stat-label">
            {stradaDeps.mcpInstalled ? 'Runtime source' : 'Recommended target'}
          </span>
          <span className="mcp-panel-stat-value">
            {stradaDeps.mcpInstalled
              ? (runtimeSourceLabel ?? 'Detected')
              : activeTarget.title}
          </span>
        </div>
      </div>

      <div className="mcp-dependency-grid">
        <DependencyStatusCard
          projectPath={projectPath}
          label="Strada.Core"
          installed={stradaDeps.coreInstalled}
          path={stradaDeps.corePath}
          version={stradaDeps.coreVersion}
          source={stradaDeps.coreSource}
          installStatus={depInstallStatus?.core}
          installError={depInstallError?.core}
          onInstall={onInstallDep ? () => onInstallDep('core') : undefined}
        />
        <DependencyStatusCard
          projectPath={projectPath}
          label="Strada.Modules"
          installed={stradaDeps.modulesInstalled}
          path={stradaDeps.modulesPath}
          version={stradaDeps.modulesVersion}
          source={stradaDeps.modulesSource}
          installStatus={depInstallStatus?.modules}
          installError={depInstallError?.modules}
          onInstall={onInstallDep ? () => onInstallDep('modules') : undefined}
        />
        <DependencyStatusCard
          projectPath={projectPath}
          label="Strada.MCP"
          installed={stradaDeps.mcpInstalled}
          path={stradaDeps.mcpPath}
          version={stradaDeps.mcpVersion}
          source={stradaDeps.mcpSource}
        />
      </div>

      {visibleWarnings.length > 0 && (
        <div className="mcp-inline-note warning">
          {visibleWarnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
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
            <span className="mcp-summary-value mono">{formatDisplayPath(projectPath, mcpInstallPlan.submodulePath)}</span>
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
