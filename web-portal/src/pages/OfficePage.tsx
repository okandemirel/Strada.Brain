import { Suspense, lazy, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { OFFICE_STATIONS } from '../office/office-stations'
import { isOffice3DEnabled } from '../office/webgl'

// Lazy-load the 3D scene so its react-three-fiber / three.js bundle is only
// fetched (and only evaluated) when WebGL is actually usable. In jsdom the
// page never reaches this import because isOffice3DEnabled() is false / mocked.
const OfficeScene = lazy(() =>
  import('../office/OfficeScene').then((m) => ({ default: m.OfficeScene })),
)

function SceneFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-text-tertiary text-sm">
      Loading office...
    </div>
  )
}

const TOGGLE_CLASS =
  'shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-hover hover:text-text cursor-pointer focus:outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-accent-glow)]'

/**
 * 2D card fallback — the accessible, keyboard-navigable, unit-tested path. Each
 * station is a <button> that navigates to its admin route. Shown whenever WebGL
 * is unavailable, the user prefers reduced motion, OR the user toggles to it
 * (so keyboard / screen-reader users are never stuck in the 3D-only view).
 */
function OfficeFallback({ onSwitchTo3D }: { onSwitchTo3D?: () => void }) {
  const navigate = useNavigate()

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h2 className="text-[22px] font-bold tracking-tight text-text">Virtual Office</h2>
        {onSwitchTo3D && (
          <button type="button" onClick={onSwitchTo3D} className={TOGGLE_CLASS}>
            🧊 3D view
          </button>
        )}
      </div>
      <p className="text-sm text-text-secondary mb-6">
        Pick a station to jump to that part of the workspace.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {OFFICE_STATIONS.map((station) => (
          <button
            key={station.id}
            type="button"
            onClick={() => navigate(station.route)}
            className="text-left bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 transition-all duration-200 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)] cursor-pointer focus:outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-accent-glow)]"
          >
            <div className="flex items-center gap-2.5 mb-1.5">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-xl text-lg shrink-0"
                style={{ background: `${station.color}22`, border: `1px solid ${station.color}` }}
                aria-hidden="true"
              >
                {station.emoji}
              </span>
              <span className="text-sm font-semibold text-text">{station.label}</span>
            </div>
            <div className="text-xs text-text-secondary leading-snug">{station.description}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function OfficePage() {
  // Computed once per mount. WebGL support / reduced-motion don't change
  // mid-session in a way that warrants re-evaluating on every render.
  const canUse3D = useMemo(() => isOffice3DEnabled(), [])
  const [forceList, setForceList] = useState(false)
  const show3D = canUse3D && !forceList

  if (!show3D) {
    // Offer the "3D view" switch only when 3D is actually usable, so users who
    // toggled to the list (or who have WebGL) can return; never offer it when
    // WebGL is unavailable (it would lead to a blank/broken scene).
    return <OfficeFallback onSwitchTo3D={canUse3D ? () => setForceList(false) : undefined} />
  }

  return (
    <div className="relative h-full w-full animate-[admin-fade-in_0.3s_ease]">
      <button
        type="button"
        onClick={() => setForceList(true)}
        className={`absolute top-3 right-3 z-10 ${TOGGLE_CLASS}`}
      >
        List view
      </button>
      <Suspense fallback={<SceneFallback />}>
        <OfficeScene />
      </Suspense>
    </div>
  )
}
