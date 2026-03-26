import { useState } from 'react'
import { TEMPLATES, type TemplateId } from './canvas-templates'

interface CanvasWelcomeProps {
  onSelect: (id: TemplateId) => void
  pendingShapeCount?: number
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
      className="flex h-full w-full flex-col items-center justify-center gap-8 overflow-auto bg-[radial-gradient(circle_at_top,rgba(0,229,255,0.08),transparent_24%)] p-8"
      data-testid="canvas-welcome"
    >
      {agentBannerVisible && (
        <div className="w-full max-w-3xl rounded-2xl border border-accent/15 bg-accent/10 px-4 py-3 shadow-[0_18px_60px_rgba(0,229,255,0.08)]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent/80">
            Agent Handoff
          </div>
          <div className="mt-1 text-sm text-text">
            Receiving {pendingShapeCount} visual block{pendingShapeCount === 1 ? '' : 's'} from the agent. The canvas is opening automatically.
          </div>
        </div>
      )}

      <div className="grid w-full max-w-5xl gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col justify-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/20 to-accent/5">
            <span className="text-2xl text-accent">{'\u2726'}</span>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent/80">
              Visual Workspace
            </div>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-text">
              Turn agent output into a working canvas
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-text-secondary">
              Architecture plans, large diffs, code review boards, and task maps should not disappear into chat. Use the canvas as a shared spatial layer between the agent and the operator.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Architecture', 'Map services, gameplay systems, and dependencies.'],
              ['Code Review', 'Open visual diffs, notes, and implementation context.'],
              ['Planning', 'Stage boards, execution lanes, and next-step clusters.'],
            ].map(([title, description]) => (
              <div key={title} className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                <div className="text-sm font-medium text-text">{title}</div>
                <div className="mt-1 text-xs leading-5 text-text-secondary">{description}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-4 shadow-[0_28px_120px_rgba(0,0,0,0.2)]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-tertiary">
                Quick Starts
              </div>
              <div className="mt-1 text-sm text-text-secondary">
                Pick a template or start blank. Agent shapes can layer on top later.
              </div>
            </div>
            {loading && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <div className="h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
                Loading
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={loading}
                onClick={() => handleClick(template.id)}
                data-testid={`canvas-template-${template.id}`}
                className={`group relative flex min-h-[132px] flex-col items-start gap-3 rounded-2xl border p-5 text-left transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 ${
                  template.id === 'blank'
                    ? 'border-dashed border-white/12 bg-white/[0.02]'
                    : 'border-white/8 bg-white/[0.04]'
                } hover:border-accent/20 hover:bg-white/[0.06] hover:shadow-[0_0_28px_rgba(0,229,255,0.08)]`}
              >
                <span className="text-2xl transition-transform duration-200 group-hover:scale-110">
                  {template.icon}
                </span>
                <div>
                  <div className="text-sm font-medium text-text">{template.title}</div>
                  <div className="mt-1 text-xs leading-5 text-text-secondary">
                    {template.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
