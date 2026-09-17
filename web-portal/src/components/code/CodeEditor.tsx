import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCodeStore, type CodeTab } from '../../stores/code-store'
import { useChangeReview } from '../../hooks/use-change-review'
import { cn } from '@/lib/utils'
import CodeViewer from './CodeViewer'
import DiffViewer from './DiffViewer'
import InlineDiffViewer from './InlineDiffViewer'

type DiffViewMode = 'inline' | 'split'

/**
 * Accept / reject for the open diff (round 11 #20).
 *
 * The buttons do NOT decide anything by themselves: they record the decision and
 * the hook sends it to the daemon, which performs the undo against the project.
 * "Revert" therefore stays visible, disabled and labelled, until the server says
 * the file was actually put back — the previous version of this panel dismissed
 * the diff immediately and left the run's bytes on disk.
 */
function DecisionControls({ file }: { file: CodeTab }) {
  const { t } = useTranslation('code')
  const { review, pending, sending, error, undecided, decide } = useChangeReview()
  const decision = pending.find((d) => d.path === file.path)
  const inFlight = sending || decision?.status === 'sending'
  const entry = review?.entries.find((e) => e.path === file.path)
  const waiting = undecided.filter((path) => path !== file.path)
  const reason = decision?.error ?? error

  return (
    <div className="flex items-center gap-2">
      {entry?.state === 'changed-since' && (
        <span className="text-[10px] text-warning" title={entry.detail}>
          {t('review.changedSince')}
        </span>
      )}
      {reason && (
        <span className="max-w-[18rem] truncate text-[10px] text-error" title={reason}>
          {t('review.notApplied', { reason })}
        </span>
      )}
      {/*
        ROUND 12 #18: a keep is waited for exactly like a revert. Keeping used to
        dismiss the diff — controls included — so a review with one keep and one
        revert could never be decided; the diff now stays until the server
        acknowledges the whole review, and this says what it is waiting for.
      */}
      {!reason && decision !== undefined && waiting.length > 0 && (
        <span className="text-[10px] text-text-tertiary">{t('review.awaiting', { count: waiting.length })}</span>
      )}
      <button
        type="button"
        disabled={inFlight}
        onClick={() => void decide(file.path, true)}
        className="rounded border border-white/8 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-white/10 transition-colors disabled:opacity-40"
      >
        {t('review.keep')}
      </button>
      <button
        type="button"
        disabled={inFlight}
        onClick={() => void decide(file.path, false)}
        className="rounded border border-white/8 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-white/10 transition-colors disabled:opacity-40"
      >
        {inFlight ? t('review.reverting') : t('review.revert')}
      </button>
    </div>
  )
}

function DiffHeader({ file, mode, onToggle }: { file: CodeTab; mode: DiffViewMode; onToggle: () => void }) {
  const { t } = useTranslation('code')
  return (
    <div className="flex items-center gap-3 border-b border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] px-3 py-1.5 backdrop-blur shrink-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent/75">
            {t('diff.changes')}
          </span>
          <span className="text-xs text-text-tertiary font-mono">{file.path}</span>
        </div>
      </div>
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 rounded border border-white/8 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-white/10 transition-colors"
      >
        {mode === 'inline' ? (
          <>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-60">
              <rect x="1" y="2" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <line x1="6" y1="2" x2="6" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            {t('diff.splitView')}
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-60">
              <rect x="1" y="2" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <line x1="3" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="3" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            {t('diff.inlineView')}
          </>
        )}
      </button>
      <DecisionControls file={file} />
    </div>
  )
}

function EditorContent({
  file,
  diffMode,
  onToggleDiffMode,
}: {
  file: CodeTab
  diffMode: DiffViewMode
  onToggleDiffMode: () => void
}) {
  if (file.isDiff) {
    return (
      <div className="flex flex-col h-full">
        <DiffHeader file={file} mode={diffMode} onToggle={onToggleDiffMode} />
        <div className="flex-1 min-h-0">
          {diffMode === 'inline' ? (
            <InlineDiffViewer
              original={file.originalContent ?? file.content}
              modified={file.modifiedContent ?? ''}
              language={file.language}
            />
          ) : (
            <DiffViewer
              original={file.originalContent ?? file.content}
              modified={file.modifiedContent ?? ''}
              language={file.language}
            />
          )}
        </div>
      </div>
    )
  }

  return <CodeViewer content={file.content} language={file.language} />
}

export default function CodeEditor() {
  const { t } = useTranslation('code')
  const tabs = useCodeStore((s) => s.tabs)
  const activeTab = useCodeStore((s) => s.activeTab)
  const closeFile = useCodeStore((s) => s.closeFile)
  const setActiveTab = useCodeStore((s) => s.setActiveTab)
  const [diffMode, setDiffMode] = useState<DiffViewMode>('inline')

  const activeFile = tabs.find((t) => t.path === activeTab)

  const handleToggleDiffMode = useCallback(() => {
    setDiffMode((m) => (m === 'inline' ? 'split' : 'inline'))
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center bg-white/3 backdrop-blur border-b border-white/5 overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            onClick={() => setActiveTab(tab.path)}
            className={cn(
              'group flex items-center gap-1 px-3 py-1.5 text-xs border-r border-white/5 whitespace-nowrap transition-colors',
              activeTab === tab.path
                ? 'border-b-2 border-b-accent text-text'
                : 'text-text-secondary hover:text-text',
            )}
          >
            <span>{tab.path.split('/').pop()}</span>
            {tab.isDiff && <span className="ml-1 text-[10px] text-accent font-medium">{t('editor.diffLabel')}</span>}
            <span
              role="button"
              aria-label={t('editor.closeTab', { filename: tab.path.split('/').pop() })}
              onClick={(e) => {
                e.stopPropagation()
                closeFile(tab.path)
              }}
              className="ml-1 hover:text-error cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            >
              &times;
            </span>
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {activeFile ? (
          <EditorContent
            file={activeFile}
            diffMode={diffMode}
            onToggleDiffMode={handleToggleDiffMode}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">{t('editor.noFileOpen')}</div>
        )}
      </div>
    </div>
  )
}
