import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Mock WebSocketProvider to avoid real WS connections
vi.mock('../../contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="ws-provider">{children}</div>,
}))

// Mock Sidebar to keep tests focused
vi.mock('./Sidebar', () => ({
  default: () => <aside data-testid="sidebar">Sidebar</aside>,
}))

import AppLayout from './AppLayout'

function renderLayout(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<div data-testid="main-content">Main Page</div>} />
          <Route path="/tools" element={<div data-testid="tools-content">Tools Page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('AppLayout', () => {
  it('renders sidebar and main content area', () => {
    renderLayout()
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-content')).toBeInTheDocument()
  })

  it('wraps children in WebSocketProvider', () => {
    renderLayout()
    expect(screen.getByTestId('ws-provider')).toBeInTheDocument()
  })
})
