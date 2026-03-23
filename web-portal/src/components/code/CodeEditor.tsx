import { lazy, Suspense } from 'react'
import { useCodeStore } from '../../stores/code-store'

const Editor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })))

export default function CodeEditor() {
  const tabs = useCodeStore((s) => s.tabs)
  const activeTab = useCodeStore((s) => s.activeTab)
  const closeFile = useCodeStore((s) => s.closeFile)
  const setActiveTab = useCodeStore((s) => s.setActiveTab)

  const activeFile = tabs.find((t) => t.path === activeTab)

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-bg-secondary overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            onClick={() => setActiveTab(tab.path)}
            className={`flex items-center gap-1 px-3 py-1.5 text-xs border-r border-border whitespace-nowrap ${
              activeTab === tab.path ? 'bg-bg text-text' : 'text-text-secondary hover:bg-surface-hover'
            }`}
          >
            <span>{tab.path.split('/').pop()}</span>
            <span
              role="button"
              aria-label={`Close ${tab.path.split('/').pop()}`}
              onClick={(e) => {
                e.stopPropagation()
                closeFile(tab.path)
              }}
              className="ml-1 hover:text-error cursor-pointer"
            >
              &times;
            </span>
          </button>
        ))}
      </div>
      {/* Editor */}
      <div className="flex-1 min-h-0">
        {activeFile ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
                Loading editor...
              </div>
            }
          >
            <Editor
              path={activeFile.path}
              defaultLanguage={activeFile.language}
              defaultValue={activeFile.content}
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
        ) : (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">No file open</div>
        )}
      </div>
    </div>
  )
}
