import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import McpInstallPanel from './McpInstallPanel'

describe('McpInstallPanel', () => {
  it('renders a clearer install flow with target cards and runtime checklist', () => {
    const html = renderToStaticMarkup(
      <McpInstallPanel
        projectPath="/Users/test/GameProject"
        stradaDeps={{
          coreInstalled: true,
          corePath: '/Users/test/GameProject/Packages/strada.core',
          modulesInstalled: false,
          modulesPath: null,
          mcpInstalled: false,
          mcpPath: null,
          mcpVersion: null,
          warnings: [],
        }}
        dependencyWarnings={['Strada.Modules not installed (optional).']}
        mcpRecommendation={{
          recommended: true,
          reason: 'Install Strada.MCP to unlock the live Unity runtime surface inside Strada.Brain.',
          featureList: [
            'Live Unity console reading and error analysis',
            'Unity editor command execution and menu actions',
            'Scene, prefab, GameObject, and component operations',
            'Multi-platform Unity builds for Android, iOS, WebGL, and standalone targets',
          ],
          discoveryHint: 'Brain auto-detects a sibling ../Strada.MCP checkout.',
          installHint: 'Install as a git submodule and bootstrap with npm install.',
        }}
        mcpInstallStatus="idle"
        mcpInstallError={null}
        mcpInstallMessage={null}
        mcpInstallPlan={null}
        onInstall={() => {}}
      />,
    )

    expect(html).toContain('What Brain will do')
    expect(html).toContain('Packages/Submodules')
    expect(html).toContain('/Users/test/GameProject/Packages/Submodules/Strada.MCP')
    expect(html).toContain('file:Submodules/Strada.MCP/unity-package/com.strada.mcp')
    expect(html).toContain('Live Unity console reading and error analysis')
    expect(html).toContain('Install Strada.MCP')
  })

  it('shows install button for missing Core when onInstallDep is provided', () => {
    const html = renderToStaticMarkup(
      <McpInstallPanel
        projectPath="/Users/test/GameProject"
        stradaDeps={{
          coreInstalled: false,
          corePath: null,
          modulesInstalled: false,
          modulesPath: null,
          mcpInstalled: false,
          mcpPath: null,
          mcpVersion: null,
          warnings: [],
        }}
        dependencyWarnings={[]}
        mcpRecommendation={{
          recommended: true,
          reason: 'Install Strada.MCP',
          featureList: [],
        }}
        mcpInstallStatus="idle"
        mcpInstallError={null}
        mcpInstallMessage={null}
        mcpInstallPlan={null}
        depInstallStatus={{}}
        depInstallError={{}}
        onInstall={() => {}}
        onInstallDep={() => {}}
      />,
    )

    expect(html).toContain('Install as git submodule')
    expect(html).toContain('Strada.Core')
    expect(html).toContain('Strada.Modules')
  })

  it('does not show install buttons when onInstallDep is not provided', () => {
    const html = renderToStaticMarkup(
      <McpInstallPanel
        projectPath="/Users/test/GameProject"
        stradaDeps={{
          coreInstalled: false,
          corePath: null,
          modulesInstalled: false,
          modulesPath: null,
          mcpInstalled: false,
          mcpPath: null,
          mcpVersion: null,
          warnings: [],
        }}
        dependencyWarnings={[]}
        mcpRecommendation={{
          recommended: true,
          reason: 'Install Strada.MCP',
          featureList: [],
        }}
        mcpInstallStatus="idle"
        mcpInstallError={null}
        mcpInstallMessage={null}
        mcpInstallPlan={null}
        onInstall={() => {}}
      />,
    )

    expect(html).not.toContain('Install as git submodule')
  })

  it('renders install results as structured runtime details', () => {
    const html = renderToStaticMarkup(
      <McpInstallPanel
        projectPath="/Users/test/GameProject"
        stradaDeps={{
          coreInstalled: true,
          corePath: '/Users/test/GameProject/Packages/strada.core',
          modulesInstalled: true,
          modulesPath: '/Users/test/GameProject/Packages/strada.modules',
          mcpInstalled: true,
          mcpPath: '/Users/test/GameProject/Packages/Submodules/Strada.MCP',
          mcpVersion: '1.2.3',
          warnings: [],
        }}
        dependencyWarnings={[]}
        mcpRecommendation={null}
        mcpInstallStatus="success"
        mcpInstallError={null}
        mcpInstallMessage="Installed into /Users/test/GameProject/Packages/Submodules/Strada.MCP."
        mcpInstallPlan={{
          target: 'packages',
          submodulePath: '/Users/test/GameProject/Packages/Submodules/Strada.MCP',
          unityPackagePath: '/Users/test/GameProject/Packages/Submodules/Strada.MCP/unity-package/com.strada.mcp',
          manifestPath: '/Users/test/GameProject/Packages/manifest.json',
          manifestDependency: 'file:Submodules/Strada.MCP/unity-package/com.strada.mcp',
          npmInstallRan: true,
        }}
        onInstall={() => {}}
      />,
    )

    expect(html).toContain('Runtime ready')
    expect(html).toContain('/Users/test/GameProject/Packages/Submodules/Strada.MCP')
    expect(html).toContain('file:Submodules/Strada.MCP/unity-package/com.strada.mcp')
    expect(html).toContain('npm install completed')
    expect(html).toContain('1.2.3')
  })
})
