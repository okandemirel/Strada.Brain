import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const mockSetMode = vi.fn()
vi.mock('../../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { mode: 'chat', setMode: mockSetMode }
    return selector ? selector(state) : state
  },
}))

import AdminNav from './AdminNav'

function renderNav(collapsed = false, route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AdminNav collapsed={collapsed} />
    </MemoryRouter>,
  )
}

describe('AdminNav', () => {
  it('renders Admin button', () => {
    renderNav()
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  it('expands to show admin links on click', async () => {
    const user = userEvent.setup()
    renderNav()
    await user.click(screen.getByText('Admin'))
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Config')).toBeInTheDocument()
    expect(screen.getByText('Skills')).toBeInTheDocument()
  })

  it('auto-expands when on admin route', () => {
    renderNav(false, '/admin/config')
    expect(screen.getByText('Config')).toBeInTheDocument()
  })

  it('clicking a link calls setMode("chat")', async () => {
    const user = userEvent.setup()
    renderNav(false, '/admin/config')
    await user.click(screen.getByText('Tools'))
    expect(mockSetMode).toHaveBeenCalledWith('chat')
  })

  it('renders shield icon only when collapsed', () => {
    renderNav(true)
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })
})
