import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ResolvedShape } from './canvas-types'

interface EditableCardProps {
  shape: ResolvedShape
  onSave: (id: string, props: Record<string, unknown>) => void
  onCancel: () => void
}

const inputCls =
  'w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-white placeholder-slate-600 outline-none focus:border-sky-400/40 focus:ring-1 focus:ring-sky-400/20'
const selectCls =
  'rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-white outline-none focus:border-sky-400/40'
const btnBaseCls =
  'rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors'

export default function EditableCard({ shape, onSave, onCancel }: EditableCardProps) {
  const { t } = useTranslation('canvas')
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...shape.props })
  const containerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.stopPropagation()
      onSave(shape.id, draft)
    }
  }, [draft, onCancel, onSave, shape.id])

  function set(key: string, value: unknown): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const fields = getEditableFields(shape.type)

  return (
    <div
      ref={containerRef}
      className="absolute overflow-hidden rounded-2xl border-2 border-sky-400/50 bg-[#0a0e16]/98 shadow-xl backdrop-blur-2xl"
      style={{ left: shape.x, top: shape.y, width: shape.w, minHeight: shape.h, zIndex: 100 }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <div className="border-b border-sky-400/15 bg-sky-400/[0.04] px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-sky-400/70">
          {t('editing.title')} — {shape.type}
        </span>
      </div>
      <div className="space-y-2.5 p-3">
        {fields.map((field) => (
          <div key={field.key}>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {field.label}
            </label>
            <FieldInput field={field} value={draft[field.key]} onChange={(v) => set(field.key, v)} />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/6 px-3 py-2">
        <button type="button" className={`${btnBaseCls} text-slate-500 hover:text-white`} onClick={onCancel}>
          {t('editing.cancel')}
        </button>
        <button
          type="button"
          className={`${btnBaseCls} border border-sky-400/30 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20`}
          onClick={() => onSave(shape.id, draft)}
        >
          {t('editing.save')}
        </button>
      </div>
    </div>
  )
}

/* ── Field input component (avoids nested ternaries) ──────────────── */

interface FieldInputProps {
  field: FieldDef
  value: unknown
  onChange: (value: unknown) => void
}

function FieldInput({ field, value, onChange }: FieldInputProps) {
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          className={`${inputCls} min-h-[60px] resize-y`}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoFocus={field.autoFocus}
          rows={3}
        />
      )
    case 'select':
      return (
        <select
          className={selectCls}
          value={String(value ?? field.options?.[0] ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )
    case 'number':
      return (
        <input
          type="number"
          className={inputCls}
          value={Number(value ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )
    default:
      return (
        <input
          type="text"
          className={inputCls}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoFocus={field.autoFocus}
        />
      )
  }
}

/* ── Field definitions per card type ──────────────────────────────── */

interface FieldDef {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'number'
  placeholder?: string
  options?: string[]
  autoFocus?: boolean
}

function getEditableFields(type: string): FieldDef[] {
  switch (type) {
    case 'note-block':
      return [{ key: 'content', label: 'Content', type: 'textarea', placeholder: 'Write a note...', autoFocus: true }]
    case 'code-block':
      return [
        { key: 'title', label: 'Title', type: 'text', placeholder: 'Snippet title', autoFocus: true },
        { key: 'language', label: 'Language', type: 'select', options: ['text', 'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'css', 'html', 'json', 'yaml', 'bash', 'sql'] },
        { key: 'code', label: 'Code', type: 'textarea', placeholder: '// code here...' },
      ]
    case 'task-card':
      return [
        { key: 'title', label: 'Title', type: 'text', placeholder: 'Task title', autoFocus: true },
        { key: 'status', label: 'Status', type: 'select', options: ['todo', 'in-progress', 'done', 'blocked'] },
        { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'critical'] },
      ]
    case 'diagram-node':
      return [
        { key: 'label', label: 'Label', type: 'text', placeholder: 'Node label', autoFocus: true },
        { key: 'nodeType', label: 'Type', type: 'select', options: ['default', 'process', 'decision', 'io', 'start', 'end'] },
        { key: 'status', label: 'Status', type: 'select', options: ['idle', 'active', 'error', 'pending'] },
      ]
    case 'file-card':
      return [
        { key: 'filePath', label: 'File Path', type: 'text', placeholder: 'src/index.ts', autoFocus: true },
        { key: 'language', label: 'Language', type: 'text', placeholder: 'typescript' },
        { key: 'lineCount', label: 'Lines', type: 'number' },
      ]
    case 'terminal-block':
      return [
        { key: 'command', label: 'Command', type: 'text', placeholder: '$ command', autoFocus: true },
        { key: 'output', label: 'Output', type: 'textarea', placeholder: 'terminal output...' },
      ]
    case 'image-block':
      return [
        { key: 'alt', label: 'Alt Text', type: 'text', placeholder: 'Image description', autoFocus: true },
        { key: 'src', label: 'Source (data URI)', type: 'textarea', placeholder: 'data:image/png;base64,...' },
      ]
    case 'error-card':
      return [
        { key: 'message', label: 'Message', type: 'text', placeholder: 'Error message', autoFocus: true },
        { key: 'severity', label: 'Severity', type: 'select', options: ['error', 'warning'] },
        { key: 'stack', label: 'Stack Trace', type: 'textarea', placeholder: 'Stack trace...' },
      ]
    case 'link-card':
      return [
        { key: 'title', label: 'Title', type: 'text', placeholder: 'Link title', autoFocus: true },
        { key: 'url', label: 'URL', type: 'text', placeholder: 'https://...' },
        { key: 'description', label: 'Description', type: 'text', placeholder: 'Description' },
      ]
    case 'metric-card':
      return [
        { key: 'label', label: 'Label', type: 'text', placeholder: 'Metric name', autoFocus: true },
        { key: 'value', label: 'Value', type: 'number' },
        { key: 'unit', label: 'Unit', type: 'text', placeholder: 'ms, %, etc.' },
        { key: 'trend', label: 'Trend', type: 'select', options: ['', 'up', 'down'] },
      ]
    case 'test-result':
      return [
        { key: 'passed', label: 'Passed', type: 'number' },
        { key: 'failed', label: 'Failed', type: 'number' },
        { key: 'skipped', label: 'Skipped', type: 'number' },
        { key: 'coverage', label: 'Coverage %', type: 'number' },
      ]
    case 'diff-block':
      return [
        { key: 'filePath', label: 'File', type: 'text', placeholder: 'file.ts', autoFocus: true },
        { key: 'diff', label: 'Diff', type: 'textarea', placeholder: '+added\n-removed' },
      ]
    case 'goal-summary':
      return [
        { key: 'title', label: 'Title', type: 'text', placeholder: 'Goal title', autoFocus: true },
        { key: 'taskCount', label: 'Total Tasks', type: 'number' },
        { key: 'completedCount', label: 'Completed', type: 'number' },
        { key: 'failedCount', label: 'Failed', type: 'number' },
      ]
    default:
      return [{ key: 'content', label: 'Content', type: 'textarea', autoFocus: true }]
  }
}
