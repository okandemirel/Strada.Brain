import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DirectoryBrowser from './DirectoryBrowser'

function renderBrowser(overrides: Partial<ComponentProps<typeof DirectoryBrowser>> = {}) {
  return renderToStaticMarkup(
    <DirectoryBrowser
      isOpen
      currentPath="/Users/test/GameProject"
      entries={[
        { name: 'Assets' },
        { name: 'Packages' },
      ]}
      isUnityProject={false}
      stradaDeps={null}
      dependencyWarnings={[]}
      mcpRecommendation={null}
      mcpInstallStatus="idle"
      mcpInstallError={null}
      mcpInstallMessage={null}
      mcpInstallPlan={null}
      loading={false}
      error={null}
      browseTo={() => {}}
      installMcp={async () => false}
      onSelect={() => {}}
      onClose={() => {}}
      {...overrides}
    />,
  )
}

describe('DirectoryBrowser', () => {
  it('keeps breadcrumbs, project context, and entries inside a shared scroll region', () => {
    const html = renderBrowser({
      isUnityProject: true,
      stradaDeps: {
        coreInstalled: true,
        corePath: '/Users/test/GameProject/Packages/com.strada.core',
        modulesInstalled: true,
        modulesPath: '/Users/test/GameProject/Packages/com.strada.modules',
        mcpInstalled: true,
        mcpPath: '/Users/test/GameProject/Packages/Submodules/Strada.MCP',
        mcpVersion: '1.2.3',
        warnings: [],
      },
    })

    const scrollRegionIndex = html.indexOf('class="browser-scroll-region"')
    const breadcrumbsIndex = html.indexOf('class="browser-breadcrumbs"', scrollRegionIndex)
    const contextPanelIndex = html.indexOf('class="browser-context-panel"', scrollRegionIndex)
    const entriesIndex = html.indexOf('class="browser-entries"', scrollRegionIndex)
    const actionsIndex = html.indexOf('class="browser-actions"')

    expect(scrollRegionIndex).toBeGreaterThan(-1)
    expect(breadcrumbsIndex).toBeGreaterThan(scrollRegionIndex)
    expect(contextPanelIndex).toBeGreaterThan(breadcrumbsIndex)
    expect(entriesIndex).toBeGreaterThan(contextPanelIndex)
    expect(actionsIndex).toBeGreaterThan(entriesIndex)
    expect(html).toMatch(/class="browser-scroll-region">[\s\S]*class="browser-context-panel"[\s\S]*class="browser-entries"[\s\S]*<\/div><div class="browser-actions">/)
  })

  it('renders directory-only browsing with actions outside the scroll region', () => {
    const html = renderBrowser()

    expect(html).toContain('class="browser-scroll-region"')
    expect(html).toContain('class="browser-breadcrumbs"')
    expect(html).toContain('class="browser-entries"')
    expect(html).not.toContain('class="browser-context-panel"')
    expect(html).toMatch(/class="browser-scroll-region">[\s\S]*class="browser-entries"[\s\S]*<\/div><div class="browser-actions">/)
  })
})
