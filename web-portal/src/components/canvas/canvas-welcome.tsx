import { useState } from 'react'
import { TEMPLATES, type TemplateId } from './canvas-templates'

interface CanvasWelcomeProps {
  onSelect: (id: TemplateId) => void
}

export default function CanvasWelcome({ onSelect }: CanvasWelcomeProps) {
  const [loading, setLoading] = useState(false)

  const handleClick = (id: TemplateId) => {
    if (loading) return
    setLoading(true)
    onSelect(id)
  }

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-8 p-8"
      data-testid="canvas-welcome"
    >
      {/* Header */}
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30">
          <span className="text-2xl text-accent">{'\u2726'}</span>
        </div>
        <h2 className="text-text text-2xl font-bold tracking-tight">Visual Workspace</h2>
        <p className="text-text-secondary text-sm max-w-md text-center">
          Plan architecture, review code, and brainstorm ideas on an infinite canvas. Pick a template or start blank.
        </p>
      </div>

      {/* Template grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full max-w-2xl">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={loading}
            onClick={() => handleClick(t.id)}
            data-testid={`canvas-template-${t.id}`}
            className={`group relative flex flex-col items-center gap-2 rounded-xl p-5
              bg-white/3 backdrop-blur-xl border border-white/5
              hover:border-accent/20 hover:bg-white/5 hover:shadow-[0_0_20px_rgba(0,229,255,0.08)]
              transition-all duration-200
              disabled:opacity-50 disabled:pointer-events-none
              ${t.id === 'blank' ? 'border-dashed' : ''}`}
          >
            <span className="text-2xl group-hover:scale-110 transition-transform duration-200">
              {t.icon}
            </span>
            <span className="text-text text-sm font-medium">{t.title}</span>
            <span className="text-text-secondary text-xs text-center">{t.description}</span>
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-text-secondary text-sm">
          <div className="h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
          Loading canvas...
        </div>
      )}
    </div>
  )
}
