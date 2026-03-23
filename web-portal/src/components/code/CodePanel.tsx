import { useCallback } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useCodeStore } from '../../stores/code-store'
import CodeEditor from './CodeEditor'
import Terminal from './Terminal'
import FileTree from './FileTree'

export default function CodePanel() {
  const touchedFiles = useCodeStore((s) => s.touchedFiles)
  const openFile = useCodeStore((s) => s.openFile)

  const handleFileSelect = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`)
        if (!res.ok) return
        const data = await res.json()
        openFile({
          path: data.path ?? path,
          content: data.content ?? '',
          language: data.language ?? 'plaintext',
        })
      } catch {
        // silently ignore — user can retry
      }
    },
    [openFile],
  )

  return (
    <div className="h-full flex flex-col">
      <PanelGroup direction="horizontal">
        <Panel defaultSize={20} minSize={12} maxSize={40}>
          <FileTree touchedFiles={touchedFiles} onFileSelect={handleFileSelect} />
        </Panel>

        <PanelResizeHandle className="w-1 cursor-col-resize bg-border transition-colors hover:bg-accent" />

        <Panel defaultSize={80} minSize={40}>
          <PanelGroup direction="vertical">
            <Panel defaultSize={70} minSize={20}>
              <CodeEditor />
            </Panel>

            <PanelResizeHandle className="h-1 cursor-row-resize bg-border transition-colors hover:bg-accent" />

            <Panel defaultSize={30} minSize={10}>
              <div className="h-full border-t border-white/5">
                <Terminal />
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  )
}
