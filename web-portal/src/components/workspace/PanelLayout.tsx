import type { ReactNode } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useWorkspaceStore } from '../../stores/workspace-store'
import TopBar from './TopBar'
import StatusBar from './StatusBar'

interface PanelLayoutProps {
  primary: ReactNode
  secondary?: ReactNode
}

export default function PanelLayout({ primary, secondary }: PanelLayoutProps) {
  const secondaryVisible = useWorkspaceStore((s) => s.secondaryVisible)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={secondaryVisible ? 70 : 100} minSize={30}>
            {primary}
          </Panel>
          {secondaryVisible && secondary && (
            <>
              <PanelResizeHandle className="w-1 cursor-col-resize bg-border transition-colors hover:bg-accent" />
              <Panel defaultSize={30} minSize={20}>
                {secondary}
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
      <StatusBar />
    </div>
  )
}
