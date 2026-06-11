import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
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

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
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

    renderWithClient(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('connected')).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp/status', expect.anything())
    expect(screen.getByText(/MyGame/)).toBeTruthy()
    expect(screen.getByText('12 of 12 available')).toBeTruthy()
    expect(screen.getByText('Reconnect')).toBeTruthy()
  })

  it('renders not-installed state without a Reconnect button', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ installed: false, status: null }))

    renderWithClient(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('Strada MCP is not installed for this project.')).toBeTruthy()
    })
    expect(screen.queryByText('Reconnect')).toBeNull()
  })

  it('falls back to the not-installed message when the status request fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))

    renderWithClient(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('Strada MCP is not installed for this project.')).toBeTruthy()
    })
    expect(screen.queryByText('Reconnect')).toBeNull()
  })

  it('reconnect click POSTs /api/mcp/reconnect, refetches status, and updates the badge', async () => {
    let currentStatus = { ...connectedStatus, bridgeConnected: false, bridgeState: 'dormant' }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp/reconnect' && init?.method === 'POST') {
        currentStatus = { ...connectedStatus, bridgeState: 'reconnected' }
        return Promise.resolve(jsonResponse({
          success: true,
          bridgeConnected: true,
          status: currentStatus,
        }))
      }
      return Promise.resolve(jsonResponse({ installed: true, status: currentStatus }))
    })

    renderWithClient(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('dormant')).toBeTruthy()
    })

    await userEvent.click(screen.getByText('Reconnect'))

    await waitFor(() => {
      expect(screen.getByText('reconnected')).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mcp/reconnect',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(toast.success).toHaveBeenCalled()
    expect(screen.queryByText('dormant')).toBeNull()
  })

  it('shows an error toast when reconnect fails', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp/reconnect' && init?.method === 'POST') {
        return Promise.reject(new Error('bridge down'))
      }
      return Promise.resolve(jsonResponse({ installed: true, status: connectedStatus }))
    })

    renderWithClient(<McpSection />)

    await waitFor(() => {
      expect(screen.getByText('Reconnect')).toBeTruthy()
    })

    await userEvent.click(screen.getByText('Reconnect'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })
})
