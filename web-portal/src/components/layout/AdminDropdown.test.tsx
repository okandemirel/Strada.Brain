import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import AdminDropdown from './AdminDropdown'

function renderAdminDropdown(collapsed = false) {
  return render(
    <MemoryRouter>
      <AdminDropdown collapsed={collapsed} />
    </MemoryRouter>,
  )
}

describe('AdminDropdown', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders trigger button', () => {
    renderAdminDropdown()
    // The trigger button is always rendered; contains a Shield icon
    const btn = screen.getByRole('button')
    expect(btn).toBeInTheDocument()
  })

  it('shows Admin label when not collapsed', () => {
    renderAdminDropdown(false)
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  it('hides Admin label when collapsed', () => {
    renderAdminDropdown(true)
    // When collapsed, the span containing 'Admin' is conditionally rendered
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  it('shows all 10 admin menu items when opened', async () => {
    const user = userEvent.setup()
    renderAdminDropdown()
    const btn = screen.getByRole('button')
    await user.click(btn)

    const expectedLabels = [
      'Dashboard', 'Config', 'Tools', 'Channels', 'Sessions',
      'Logs', 'Identity', 'Personality', 'Memory', 'Settings',
    ]
    for (const label of expectedLabels) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('menu items have correct /admin/* paths', async () => {
    const user = userEvent.setup()
    renderAdminDropdown()
    const btn = screen.getByRole('button')
    await user.click(btn)

    const expectedPaths = [
      '/admin/dashboard', '/admin/config', '/admin/tools', '/admin/channels',
      '/admin/sessions', '/admin/logs', '/admin/identity', '/admin/personality',
      '/admin/memory', '/admin/settings',
    ]
    // Radix DropdownMenuItem wraps NavLink as role="menuitem" anchor elements
    const menuItems = screen.getAllByRole('menuitem')
    const hrefs = menuItems.map((el) => el.getAttribute('href'))
    for (const path of expectedPaths) {
      expect(hrefs).toContain(path)
    }
  })
})
