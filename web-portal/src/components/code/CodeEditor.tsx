import { useCallback, useState } from 'react'
import { useCodeStore, type CodeTab } from '../../stores/code-store'
import { cn } from '@/lib/utils'
import CodeViewer from './CodeViewer'
import DiffViewer from './DiffViewer'
import InlineDiffViewer from './InlineDiffViewer'

type DiffViewMode = 'inline' | 'split'

function DiffHeader({ file, mode, onToggle }: { file: CodeTab; mode: DiffViewMode; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] px-3 py-1.5 backdrop-blur shrink-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent/75">
            Changes
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
            Split
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-60">
              <rect x="1" y="2" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <line x1="3" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="3" y1="7" x2="9" y2="7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            Inline
          </>
        )}
      </button>
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
            {tab.isDiff && <span className="ml-1 text-[10px] text-accent font-medium">DIFF</span>}
            <span
              role="button"
              aria-label={`Close ${tab.path.split('/').pop()}`}
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
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">No file open</div>
        )}
      </div>
    </div>
  )
}
