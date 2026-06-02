import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { OFFICE_STATIONS } from '../office/office-stations'

// ---------------------------------------------------------------------------
// Force the 2D fallback path. We mock the WebGL helper so the test never
// depends on a (non-existent) jsdom WebGL context.
// ---------------------------------------------------------------------------
const mockIsOffice3DEnabled = vi.fn<() => boolean>()
vi.mock('../office/webgl', () => ({
  isOffice3DEnabled: () => mockIsOffice3DEnabled(),
}))

// OfficePage's only responsibility on the 3D path is to lazy-render
// <OfficeScene/> and show the List view toggle. The scene's WebGL internals
// (useGLTF / useFrame / Clone) are covered by OfficeScene.test.tsx, so stub the
// whole module here — jsdom never touches react-three-fiber / drei this way.
vi.mock('../office/OfficeScene', () => ({
  OfficeScene: () => <div data-testid="r3f-canvas" />,
}))

import OfficePage from './OfficePage'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Surfaces the current router location so navigation can be asserted. */
function LocationDisplay() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderPage(initialPath = '/admin/office') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <OfficePage />
      <LocationDisplay />
    </MemoryRouter>,
  )
}

describe('OfficePage (2D fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsOffice3DEnabled.mockReturnValue(false)
  })

  it('renders a clickable card for every station when 3D is disabled', () => {
    renderPage()
    expect(screen.queryByTestId('r3f-canvas')).not.toBeInTheDocument()

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(OFFICE_STATIONS.length)
    expect(buttons).toHaveLength(13)

    for (const station of OFFICE_STATIONS) {
      expect(screen.getByText(station.label)).toBeInTheDocument()
      expect(screen.getByText(station.description)).toBeInTheDocument()
    }
  })

  it('navigates to a station route when its card is clicked', async () => {
    const user = userEvent.setup()
    renderPage()

    const memory = OFFICE_STATIONS.find((s) => s.id === 'memory')!
    await user.click(screen.getByRole('button', { name: new RegExp(memory.label) }))

    expect(screen.getByTestId('location')).toHaveTextContent('/admin/memory')
  })

  it('navigates to the chat route ("/") for the Chat station', async () => {
    const user = userEvent.setup()
    renderPage()

    const chat = OFFICE_STATIONS.find((s) => s.id === 'chat')!
    await user.click(screen.getByRole('button', { name: new RegExp(chat.label) }))

    expect(screen.getByTestId('location')).toHaveTextContent('/')
  })

  it('every station card navigates to its declared route', async () => {
    for (const station of OFFICE_STATIONS) {
      const user = userEvent.setup()
      const { unmount } = renderPage()
      await user.click(screen.getByRole('button', { name: new RegExp(`^${station.label}`) }))
      expect(screen.getByTestId('location')).toHaveTextContent(station.route)
      unmount()
    }
  })
})

describe('OfficePage (3D path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsOffice3DEnabled.mockReturnValue(true)
  })

  it('renders the 3D scene (mocked canvas) with a List view toggle when 3D is enabled', async () => {
    renderPage()
    // The scene is lazy-loaded; wait for the mocked <Canvas> to appear.
    expect(await screen.findByTestId('r3f-canvas')).toBeInTheDocument()
    // The only control in 3D mode is the accessible "List view" toggle; station
    // navigation happens via the 3D meshes (covered by OfficeScene.test.tsx).
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(screen.getByRole('button', { name: /list view/i })).toBeInTheDocument()
  })

  it('lets keyboard/screen-reader users switch to the accessible 2D list and back', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('r3f-canvas')

    // Switch to the 2D list (the accessible, keyboard-navigable view).
    await user.click(screen.getByRole('button', { name: /list view/i }))
    expect(screen.queryByTestId('r3f-canvas')).not.toBeInTheDocument()
    // All station cards are now present, plus a "3D view" toggle to return.
    expect(screen.getAllByRole('button')).toHaveLength(OFFICE_STATIONS.length + 1)
    expect(screen.getByRole('button', { name: /3d view/i })).toBeInTheDocument()
    expect(screen.getByText(OFFICE_STATIONS[0].label)).toBeInTheDocument()

    // Switch back to the 3D scene.
    await user.click(screen.getByRole('button', { name: /3d view/i }))
    expect(await screen.findByTestId('r3f-canvas')).toBeInTheDocument()
  })
})
