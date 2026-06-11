import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import McpSection from './McpSection'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const connectedStatus = {
  installed: true,
  version: '1.2.3',
  toolCount: 12,
  resourceCount: 3,
  promptCount: 2,
  bridgeConfigured: true,
  bridgeConnected: true,
  bridgeState: 'connected',
  availableToolCount: 12,
  unavailableToolCount: 0,
  activeEditorPort: 6400,
  activeEditorProjectName: 'MyGame',
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response
}

describe('McpSection', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders connected state with badge, tools, and project name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ installed: true, status: connectedStatus }))

    render(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('connected')).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp/status')
    expect(screen.getByText(/MyGame/)).toBeTruthy()
    expect(screen.getByText('12 of 12 available')).toBeTruthy()
    expect(screen.getByText('Reconnect')).toBeTruthy()
  })

  it('renders not-installed state without a Reconnect button', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ installed: false, status: null }))

    render(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('Strada MCP is not installed for this project.')).toBeTruthy()
    })
    expect(screen.queryByText('Reconnect')).toBeNull()
  })

  it('reconnect click POSTs /api/mcp/reconnect and updates the badge', async () => {
    const disconnected = { ...connectedStatus, bridgeConnected: false, bridgeState: 'dormant' }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp/reconnect' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          success: true,
          bridgeConnected: true,
          status: { ...connectedStatus, bridgeState: 'reconnected' },
        }))
      }
      return Promise.resolve(jsonResponse({ installed: true, status: disconnected }))
    })

    render(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('dormant')).toBeTruthy()
    })

    await userEvent.click(screen.getByText('Reconnect'))

    await waitFor(() => {
      expect(screen.getByText('reconnected')).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp/reconnect', { method: 'POST' })
    expect(screen.queryByText('dormant')).toBeNull()
  })
})
