import { lazy, Suspense, useCallback } from 'react'
import { useCodeStore, type CodeTab } from '../../stores/code-store'
import { useWS } from '../../hooks/useWS'
import { cn } from '@/lib/utils'
import DiffViewer from './DiffViewer'

const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })))

function DiffActionBar({ file, onAction }: { file: CodeTab; onAction: (action: 'accept' | 'reject') => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-white/3 backdrop-blur border-b border-white/5 shrink-0">
      <span className="text-xs text-text-secondary flex-1">
        Review changes to {file.path.split('/').pop()}
      </span>
      <button
        onClick={() => onAction('reject')}
        className="px-2 py-0.5 text-xs rounded bg-white/5 text-text-secondary hover:bg-white/10 transition-colors"
      >
        Dismiss
      </button>
      <button
        onClick={() => onAction('accept')}
        className="px-2 py-0.5 text-xs rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
      >
        Accept
      </button>
    </div>
  )
}

function EditorContent({ file, onDiffAction }: { file: CodeTab; onDiffAction: (action: 'accept' | 'reject') => void }) {
  if (file.isDiff) {
    return (
      <>
        <DiffActionBar file={file} onAction={onDiffAction} />
        <div className="flex-1 min-h-0">
          <DiffViewer
            original={file.originalContent ?? file.content}
            modified={file.modifiedContent ?? ''}
            language={file.language}
          />
        </div>
      </>
    )
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full text-text-tertiary text-sm animate-pulse">
          Loading editor...
        </div>
      }
    >
      <Editor
        path={file.path}
        defaultLanguage={file.language}
        defaultValue={file.content}
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: true },
          lineNumbers: 'on',
          bracketPairColorization: { enabled: true },
          scrollBeyondLastLine: false,
        }}
      />
    </Suspense>
  )
}

export default function CodeEditor() {
  const tabs = useCodeStore((s) => s.tabs)
  const activeTab = useCodeStore((s) => s.activeTab)
  const closeFile = useCodeStore((s) => s.closeFile)
  const setActiveTab = useCodeStore((s) => s.setActiveTab)
  const resolveDiff = useCodeStore((s) => s.resolveDiff)
  const { sendRawJSON } = useWS()

  const activeFile = tabs.find((t) => t.path === activeTab)

  const handleDiffAction = useCallback((action: 'accept' | 'reject') => {
    if (!activeFile) return
    const type = action === 'accept' ? 'code:accept_diff' : 'code:reject_diff'
    const sent = sendRawJSON({ type, path: activeFile.path, hunkIndex: 0 })
    if (sent || action === 'reject') resolveDiff(activeFile.path, action === 'accept')
  }, [activeFile, sendRawJSON, resolveDiff])

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center bg-white/3 backdrop-blur border-b border-white/5 overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            onClick={() => setActiveTab(tab.path)}
            className={cn(
              'group flex items-center gap-1 px-3 py-1.5 text-xs border-r border-white/5 whitespace-nowrap transition-colors',
              activeTab === tab.path
                ? 'border-b-2 border-b-accent text-text shadow-[0_1px_8px_0_rgba(var(--color-accent)/0.25)]'
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
      {/* Editor / Diff Viewer */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeFile ? (
          <EditorContent file={activeFile} onDiffAction={handleDiffAction} />
        ) : (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">No file open</div>
        )}
      </div>
    </div>
  )
}
