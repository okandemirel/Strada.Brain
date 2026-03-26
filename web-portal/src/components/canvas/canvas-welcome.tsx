import { useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { TEMPLATES, type TemplateId } from './canvas-templates'

interface CanvasWelcomeProps {
  onSelect: (id: TemplateId) => void
  pendingShapeCount?: number
}

interface WelcomeSectionProps {
  className?: string
}

interface QuickStartsPanelProps {
  loading: boolean
  onSelect: (id: TemplateId) => void
  className?: string
}

const FEATURES = [
  ['Architecture boards', 'Map services, gameplay systems, and dependencies without losing spatial context.'],
  ['Review surfaces', 'Keep diffs, notes, and implementation tradeoffs visible while the agent works.'],
  ['Planning lanes', 'Use the canvas as a live staging area instead of another disposable chat answer.'],
] as const

const STUDIO_STATS = [
  ['Persistent canvas', 'Auto-saved per session'],
  ['Live handoff', 'Canvas mutations apply in place'],
  ['Resizable split', 'Your layout is remembered'],
] as const

function WelcomeIntro({ className = '' }: WelcomeSectionProps) {
  return (
    <section
      className={`relative overflow-hidden rounded-[34px] border border-white/8 bg-[#0b1018]/90 p-6 shadow-[0_24px_120px_rgba(0,0,0,0.36)] ${className}`.trim()}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.16),transparent_30%),radial-gradient(circle_at_80%_20%,rgba(52,211,153,0.12),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]" />
      <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:32px_32px]" />

      <div className="relative flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-text-secondary backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_12px_rgba(0,229,255,0.5)]" />
            Canvas Studio
          </div>
          <div className="rounded-full border border-emerald-400/15 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-medium text-emerald-300">
            Agent-ready surface
          </div>
        </div>

        <div className="mt-8 grid flex-1 gap-8 xl:grid-cols-[minmax(0,1fr)_220px]">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.34em] text-sky-300/85">
              Visual workspace
            </div>
            <h2 className="mt-4 max-w-2xl text-[clamp(2.5rem,4.8vw,4.9rem)] font-semibold leading-[0.92] tracking-[-0.05em] text-white">
              Make agent output feel like a designed surface.
            </h2>
            <p className="mt-5 max-w-2xl text-[15px] leading-7 text-text-secondary">
              Architecture maps, code review stacks, and planning boards should read like a control room, not a pile of dark widgets. Start with a strong frame, then let the agent keep drawing into it.
            </p>
          </div>

          <div className="grid gap-3 self-start xl:self-end">
            {STUDIO_STATS.map(([label, value]) => (
              <div
                key={label}
                className="rounded-[24px] border border-white/10 bg-black/20 px-4 py-4 backdrop-blur-xl"
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-text-tertiary">
                  {label}
                </div>
                <div className="mt-2 text-sm font-medium leading-6 text-text">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 grid gap-3 md:grid-cols-3">
          {FEATURES.map(([title, description], index) => (
            <div
              key={title}
              className={`rounded-[26px] border px-4 py-4 backdrop-blur-xl ${
                index === 0
                  ? 'border-sky-400/20 bg-sky-400/[0.08]'
                  : 'border-white/10 bg-white/[0.035]'
              }`}
            >
              <div className="text-sm font-semibold text-text">{title}</div>
              <div className="mt-2 text-xs leading-6 text-text-secondary">{description}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function QuickStartsPanel({ loading, onSelect, className = '' }: QuickStartsPanelProps) {
  const featuredTemplate = TEMPLATES.find((template) => template.id === 'blank') ?? TEMPLATES[0]
  const libraryTemplates = TEMPLATES.filter((template) => template.id !== featuredTemplate.id)

  return (
    <section
      className={`relative overflow-hidden rounded-[34px] border border-white/8 bg-[#0d1017]/95 p-5 shadow-[0_24px_120px_rgba(0,0,0,0.4)] ${className}`.trim()}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(0,229,255,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]" />

      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-text-tertiary">
              Starter Library
            </div>
            <h3 className="mt-3 max-w-md text-[28px] font-semibold tracking-[-0.04em] text-white">
              Pick a frame, then let the agent layer onto it.
            </h3>
            <p className="mt-3 max-w-lg text-sm leading-6 text-text-secondary">
              Templates give the canvas rhythm immediately. Blank mode stays available if you want total control.
            </p>
          </div>

          {loading && (
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-text-secondary">
              <div className="h-4 w-4 rounded-full border-2 border-accent/25 border-t-accent animate-spin" />
              Preparing
            </div>
          )}
        </div>

        <div className="mt-6 grid flex-1 gap-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <button
            type="button"
            disabled={loading}
            onClick={() => onSelect(featuredTemplate.id)}
            data-testid={`canvas-template-${featuredTemplate.id}`}
            className="group relative flex min-h-[280px] flex-col justify-between overflow-hidden rounded-[30px] border border-sky-400/15 bg-[linear-gradient(180deg,rgba(125,211,252,0.14),rgba(10,14,22,0.35))] p-6 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-300/30 hover:shadow-[0_24px_80px_rgba(14,165,233,0.12)] disabled:pointer-events-none disabled:opacity-50"
          >
            <div className="absolute inset-x-6 top-6 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
            <div className="relative">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/15 px-3 py-1 text-[11px] font-medium text-text-secondary">
                Featured start
              </div>
              <div className="mt-8 text-5xl text-white transition-transform duration-200 group-hover:scale-105">
                {featuredTemplate.icon}
              </div>
              <div className="mt-6 text-2xl font-semibold tracking-[-0.04em] text-white">
                {featuredTemplate.title}
              </div>
              <div className="mt-3 max-w-sm text-sm leading-6 text-text-secondary">
                {featuredTemplate.description}
              </div>
            </div>

            <div className="relative flex items-center justify-between gap-3 rounded-[22px] border border-white/10 bg-black/20 px-4 py-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-text-tertiary">
                  Suggested
                </div>
                <div className="mt-1 text-sm text-text">
                  Best if the agent will decide the structure live.
                </div>
              </div>
              <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-text">
                Launch
              </div>
            </div>
          </button>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2">
            {libraryTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={loading}
                onClick={() => onSelect(template.id)}
                data-testid={`canvas-template-${template.id}`}
                className="group relative flex min-h-[172px] flex-col items-start justify-between overflow-hidden rounded-[26px] border border-white/10 bg-white/[0.035] p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.05] hover:shadow-[0_18px_56px_rgba(0,0,0,0.22)] disabled:pointer-events-none disabled:opacity-50"
              >
                <div className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.12),transparent_36%)]" />
                <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-black/15 text-2xl text-white">
                  {template.icon}
                </div>
                <div className="relative">
                  <div className="text-base font-semibold tracking-[-0.03em] text-text">
                    {template.title}
                  </div>
                  <div className="mt-2 text-xs leading-6 text-text-secondary">
                    {template.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

export default function CanvasWelcome({
  onSelect,
  pendingShapeCount = 0,
}: CanvasWelcomeProps) {
  const [loading, setLoading] = useState(false)

  function handleClick(id: TemplateId): void {
    if (loading) return
    setLoading(true)
    onSelect(id)
  }

  const agentBannerVisible = pendingShapeCount > 0

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-auto bg-[#06090f] p-4 sm:p-6 lg:p-8"
      data-testid="canvas-welcome"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.08),transparent_22%),radial-gradient(circle_at_85%_10%,rgba(52,211,153,0.08),transparent_22%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:36px_36px]" />

      <div className="relative mx-auto flex w-full max-w-[1480px] flex-1 flex-col gap-6">
        {agentBannerVisible && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-sky-400/15 bg-sky-400/[0.08] px-4 py-3 shadow-[0_18px_60px_rgba(14,165,233,0.08)]">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-sky-300/80">
                Agent handoff
              </div>
              <div className="mt-1 text-sm text-text">
                Receiving {pendingShapeCount} visual block{pendingShapeCount === 1 ? '' : 's'} from the agent. The editor will open and keep applying new canvas mutations as they arrive.
              </div>
            </div>
            <div className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-text-secondary">
              Live sync armed
            </div>
          </div>
        )}

        <div className="grid flex-1 gap-6 lg:hidden">
          <WelcomeIntro />
          <QuickStartsPanel loading={loading} onSelect={handleClick} />
        </div>

        <div className="hidden flex-1 lg:block">
          <PanelGroup
            direction="horizontal"
            autoSaveId="strada-canvas-welcome-layout"
            className="h-full w-full"
          >
            <Panel defaultSize={47} minSize={34}>
              <WelcomeIntro className="h-full pr-3" />
            </Panel>
            <PanelResizeHandle
              className="group relative mx-1.5 w-3 cursor-col-resize"
              data-testid="canvas-welcome-resize-handle"
            >
              <div className="absolute inset-y-12 left-1/2 w-px -translate-x-1/2 rounded-full bg-gradient-to-b from-transparent via-white/10 to-transparent transition-colors group-hover:via-sky-300/50" />
              <div className="absolute left-1/2 top-1/2 h-14 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-white/[0.05] shadow-[0_0_24px_rgba(0,0,0,0.22)] transition-all group-hover:border-sky-300/30 group-hover:bg-sky-300/10" />
            </PanelResizeHandle>
            <Panel defaultSize={53} minSize={30}>
              <QuickStartsPanel loading={loading} onSelect={handleClick} className="h-full pl-3" />
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </div>
  )
}
