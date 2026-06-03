import { useTranslation } from 'react-i18next'
import type { OpencodePlatform } from '../../types/setup-constants'

interface OpencodePlatformToggleProps {
  value: OpencodePlatform
  onChange: (platform: OpencodePlatform) => void
}

const PLATFORMS: Array<{ id: OpencodePlatform; labelKey: string; fallbackLabel: string }> = [
  { id: 'zen', labelKey: 'providers.opencode.platform.zen', fallbackLabel: 'Zen' },
  { id: 'go', labelKey: 'providers.opencode.platform.go', fallbackLabel: 'Go' },
]

/**
 * Small segmented control letting the user pick which OpenCode hosted platform
 * (Zen or Go) Strada should target. Changing the platform re-probes OpenCode's
 * live models at the chosen base URL upstream.
 */
export default function OpencodePlatformToggle({ value, onChange }: OpencodePlatformToggleProps) {
  const { t } = useTranslation('setup')
  return (
    <div className="provider-choice-group">
      <div className="provider-field-label">
        {t('providers.opencode.platform.label', { defaultValue: 'OpenCode Platform' })}
      </div>
      <div className="opencode-platform-toggle" role="group">
        {PLATFORMS.map((platform) => {
          const selected = value === platform.id
          return (
            <button
              type="button"
              key={platform.id}
              className={`provider-choice-card${selected ? ' selected' : ''}`}
              aria-pressed={selected}
              onClick={() => onChange(platform.id)}
            >
              <span className="provider-choice-title">
                {t(platform.labelKey, { defaultValue: platform.fallbackLabel })}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
