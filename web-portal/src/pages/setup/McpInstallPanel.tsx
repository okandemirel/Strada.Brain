import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  compact?: boolean
  onInstall: (target: McpInstallTarget) => void
  onInstallDep?: (pkg: StradaDepPackage) => void
}

interface InstallTargetOption {
  id: McpInstallTarget
  titleKey: string
  eyebrowKey: string
  descriptionKey: string
  previewSuffix: string
  manifestDependency: string
}

const INSTALL_TARGETS: InstallTargetOption[] = [
  {
    id: 'packages',
    titleKey: 'mcp.target.packages.title',
    eyebrowKey: 'mcp.target.packages.eyebrow',
    descriptionKey: 'mcp.target.packages.description',
    previewSuffix: 'Packages/Submodules/Strada.MCP',
    manifestDependency: 'file:Submodules/Strada.MCP/unity-package/com.strada.mcp',
  },
  {
    id: 'assets',
    titleKey: 'mcp.target.assets.title',
    eyebrowKey: 'mcp.target.assets.eyebrow',
    descriptionKey: 'mcp.target.assets.description',
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

const SOURCE_LABEL_KEYS: Record<string, string> = {
  'package-directory': 'mcp.source.packageDirectory',
  'manifest': 'mcp.source.manifest',
  'project-local': 'mcp.source.projectLocal',
  'configured-path': 'mcp.source.configuredPath',
  'sibling-checkout': 'mcp.source.siblingCheckout',
  'global-install': 'mcp.source.globalInstall',
}

const SOURCE_COPY_KEYS: Record<string, string> = {
  'project-local': 'mcp.sourceCopy.projectLocal',
  'configured-path': 'mcp.sourceCopy.configuredPath',
  'sibling-checkout': 'mcp.sourceCopy.siblingCheckout',
  'global-install': 'mcp.sourceCopy.globalInstall',
}

function formatDisplayPath(
  projectPath: string,
  path: string | null,
  source: StradaDepInstallSource | null | undefined,
  t: (key: string) => string,
): string {
  if (!path) {
    return source === 'manifest' ? t('mcp.dependency.manifest') : t('mcp.dependency.notDetected')
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
  installButtonLabel,
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
  installButtonLabel?: string
  onInstall?: () => void
}) {
  const { t } = useTranslation('setup')
  const sourceLabelKey = source ? SOURCE_LABEL_KEYS[source] : null
  const sourceLabel = sourceLabelKey ? t(sourceLabelKey) : null
  const displayPath = formatDisplayPath(projectPath, path, source, t)

  return (
    <div className={`mcp-dependency-card ${installed ? 'is-installed' : 'is-missing'}`}>
      <div className="mcp-dependency-topline">
        <div className="mcp-dependency-label">{label}</div>
        <span className={`mcp-dependency-pill ${installed ? 'is-installed' : 'is-missing'}`}>
          {installed ? t('mcp.dependency.installed') : t('mcp.dependency.missing')}
        </span>
      </div>

      <div className="mcp-dependency-main">
        <div className="mcp-dependency-value">{installed ? (version ? `v${version}` : t('mcp.dependency.detected')) : t('mcp.dependency.installRequired')}</div>
        {sourceLabel && (
          <div className="mcp-dependency-source">{sourceLabel}</div>
        )}
      </div>

      <div className="mcp-dependency-meta-label">
        {installed ? t('mcp.dependency.location') : t('mcp.dependency.status')}
      </div>
      <div className="mcp-dependency-path mono" title={displayPath}>{displayPath}</div>

      {!installed && onInstall && (
        <div className="mcp-dependency-install">
          {installStatus === 'installing' && (
            <span className="mcp-dependency-install-status working">{t('mcp.dependency.installing')}</span>
          )}
          {installStatus === 'success' && (
            <span className="mcp-dependency-install-status success">{t('mcp.dependency.installedSuccessfully')}</span>
          )}
          {installStatus === 'error' && (
            <span className="mcp-dependency-install-status error">{installError ?? t('mcp.dependency.installFailed')}</span>
          )}
          {(!installStatus || installStatus === 'idle' || installStatus === 'error') && (
            <button
              type="button"
              className="btn btn-secondary mcp-card-action"
              onClick={onInstall}
            >
              {installButtonLabel ?? t('mcp.dependency.installButton')}
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
  installButtonLabel = 'Install',
  compact = false,
  onInstall,
  onInstallDep,
}: McpInstallPanelProps) {
  const { t } = useTranslation('setup')
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
  const runtimeSourceLabelKey = stradaDeps.mcpSource ? SOURCE_LABEL_KEYS[stradaDeps.mcpSource] : null
  const runtimeSourceLabel = runtimeSourceLabelKey ? t(runtimeSourceLabelKey) : null
  const runtimeSourceCopyKey = stradaDeps.mcpSource ? SOURCE_COPY_KEYS[stradaDeps.mcpSource] : null
  const runtimeSourceCopy = runtimeSourceCopyKey ? t(runtimeSourceCopyKey) : null

  return (
    <section className={`mcp-panel ${stradaDeps.mcpInstalled ? 'is-installed' : 'is-missing'}`}>
      <div className="mcp-panel-header">
        <div className="mcp-panel-copy-group">
          <div className="mcp-panel-eyebrow">
            {stradaDeps.mcpInstalled ? t('mcp.eyebrow.installed') : t('mcp.eyebrow.missing')}
          </div>
          <div className="mcp-panel-title-row">
            <h3 className="mcp-panel-title">{t('mcp.title')}</h3>
            {stradaDeps.mcpVersion && (
              <span className="mcp-version-chip">v{stradaDeps.mcpVersion}</span>
            )}
          </div>
          <p className="mcp-panel-copy">
            {stradaDeps.mcpInstalled
              ? t('mcp.copy.installed', { source: runtimeSourceCopy ? ` ${runtimeSourceCopy}` : '' })
              : (mcpRecommendation?.reason
                ?? t('mcp.copy.missing.fallback'))}
          </p>
        </div>
        <div className="mcp-panel-runtime">
          <span className={`mcp-runtime-pill ${stradaDeps.mcpInstalled ? 'is-installed' : 'is-missing'}`}>
            {stradaDeps.mcpInstalled ? t('mcp.runtime.installed') : t('mcp.runtime.missing')}
          </span>
          <div className="mcp-runtime-caption">
            {t('mcp.runtime.caption', { count: detectedPackageCount })}
          </div>
        </div>
      </div>

      {!compact && (
        <div className="mcp-panel-snapshot">
          <div className="mcp-panel-stat">
            <span className="mcp-panel-stat-label">{t('mcp.snapshot.detectedPackages')}</span>
            <span className="mcp-panel-stat-value">{t('mcp.snapshot.detectedPackagesValue', { count: detectedPackageCount })}</span>
          </div>
          <div className="mcp-panel-stat">
            <span className="mcp-panel-stat-label">
              {stradaDeps.mcpInstalled ? t('mcp.snapshot.runtimeSource') : t('mcp.snapshot.recommendedTarget')}
            </span>
            <span className="mcp-panel-stat-value">
              {stradaDeps.mcpInstalled
                ? (runtimeSourceLabel ?? t('mcp.dependency.detected'))
                : t(activeTarget.titleKey)}
            </span>
          </div>
        </div>
      )}

      <div className="mcp-dependency-grid">
        <DependencyStatusCard
          projectPath={projectPath}
          label={t('mcp.labels.stradaCore')}
          installed={stradaDeps.coreInstalled}
          path={stradaDeps.corePath}
          version={stradaDeps.coreVersion}
          source={stradaDeps.coreSource}
          installStatus={depInstallStatus?.core}
          installError={depInstallError?.core}
          installButtonLabel={installButtonLabel}
          onInstall={onInstallDep ? () => onInstallDep('core') : undefined}
        />
        <DependencyStatusCard
          projectPath={projectPath}
          label={t('mcp.labels.stradaModules')}
          installed={stradaDeps.modulesInstalled}
          path={stradaDeps.modulesPath}
          version={stradaDeps.modulesVersion}
          source={stradaDeps.modulesSource}
          installStatus={depInstallStatus?.modules}
          installError={depInstallError?.modules}
          installButtonLabel={installButtonLabel}
          onInstall={onInstallDep ? () => onInstallDep('modules') : undefined}
        />
        <DependencyStatusCard
          projectPath={projectPath}
          label={t('mcp.labels.stradaMcp')}
          installed={stradaDeps.mcpInstalled}
          path={stradaDeps.mcpPath}
          version={stradaDeps.mcpVersion}
          source={stradaDeps.mcpSource}
          installStatus={mcpInstallStatus}
          installError={mcpInstallError}
          installButtonLabel={installButtonLabel}
          onInstall={showInstallFlow ? () => onInstall(installTarget) : undefined}
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
          {!compact && (
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
                  <div className="mcp-guidance-title">{t('mcp.guidance.whatBrainWillDo')}</div>
                  <ul className="mcp-checklist">
                    <li>{t('mcp.guidance.step1')}</li>
                    <li>{t('mcp.guidance.step2')}</li>
                    <li>{t('mcp.guidance.step3')}</li>
                  </ul>
                </div>
                <div className="mcp-guidance-card">
                  <div className="mcp-guidance-title">{t('mcp.guidance.discovery')}</div>
                  <p>{mcpRecommendation.discoveryHint ?? t('mcp.guidance.discoveryDefault')}</p>
                  <div className="mcp-guidance-title secondary">{t('mcp.guidance.installNote')}</div>
                  <p>{mcpRecommendation.installHint ?? t('mcp.guidance.installNoteDefault')}</p>
                </div>
              </div>
            </>
          )}

          <div className="mcp-target-grid" role="radiogroup" aria-label={t('mcp.target.ariaLabel')}>
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
                      <div className="mcp-target-eyebrow">{t(option.eyebrowKey)}</div>
                      <div className="mcp-target-title">{t(option.titleKey)}</div>
                    </div>
                    {option.id === 'packages' && (
                      <span className="mcp-target-badge">{t('mcp.target.packages.badge')}</span>
                    )}
                  </div>
                  <p className="mcp-target-copy">{t(option.descriptionKey)}</p>
                  <div className="mcp-target-preview mono">
                    {normalizeJoin(projectPath, option.previewSuffix)}
                  </div>
                  <div className="mcp-target-preview-label">{t('mcp.target.manifestDependency')}</div>
                  <div className="mcp-target-preview mono">{option.manifestDependency}</div>
                </button>
              )
            })}
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
              {t('mcp.install.preparing', { path: normalizeJoin(projectPath, activeTarget.previewSuffix) })}
            </div>
          )}
          {mcpInstallStatus === 'success' && (
            <div>{mcpInstallMessage ?? t('mcp.install.success')}</div>
          )}
          {mcpInstallStatus === 'error' && (
            <div>{mcpInstallError ?? t('mcp.install.error')}</div>
          )}
        </div>
      )}

      {mcpInstallPlan && (
        <div className="mcp-install-summary">
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">{t('mcp.install.summary.installedInto')}</span>
            <span className="mcp-summary-value mono">{formatDisplayPath(projectPath, mcpInstallPlan.submodulePath, null, t)}</span>
          </div>
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">{t('mcp.install.summary.unityPackage')}</span>
            <span className="mcp-summary-value mono">{mcpInstallPlan.manifestDependency}</span>
          </div>
          <div className="mcp-summary-item">
            <span className="mcp-summary-label">{t('mcp.install.summary.runtimeBootstrap')}</span>
            <span className="mcp-summary-value">{mcpInstallPlan.npmInstallRan ? t('mcp.install.summary.npmCompleted') : t('mcp.install.summary.pending')}</span>
          </div>
        </div>
      )}
    </section>
  )
}
