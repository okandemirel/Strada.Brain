import { describe, it, expect, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'

// --- WebGL-free mocks -------------------------------------------------------
// drei's <Html> portals into the DOM, <OrbitControls> wants a real
// camera/renderer, and <Clone>/useGLTF load real GLBs over the network. Stub
// them all so the test-renderer only ever sees the plain meshes whose
// click->onSelect wiring we are verifying. No WebGL, no asset fetches.
vi.mock('@react-three/drei', () => ({
  Html: () => null,
  OrbitControls: () => null,
  Clone: () => null,
  useGLTF: Object.assign(() => ({ scene: {} }), { preload: () => {} }),
}))

// useFrame would otherwise drive the per-frame walk loop; the test-renderer has
// no render loop and we are only asserting mount + click wiring, so stub it.
vi.mock('@react-three/fiber', async () => {
  const actual =
    await vi.importActual<typeof import('@react-three/fiber')>('@react-three/fiber')
  return { ...actual, useFrame: () => {} }
})

// office-assets is real; force the primitive (no-GLB) path so the scene never
// touches useGLTF for furniture or agents during this jsdom render.
vi.mock('./office-assets', () => ({
  officeModelUrl: () => undefined,
  HAS_OFFICE_MODELS: false,
  OFFICE_MODELS: [],
}))

// office-layout / office-agents are written by a sibling agent and may not even
// exist yet during this run. Mock them with minimal, contract-conforming data
// so this test is deterministic and self-contained. The orchestrator verifies
// the real modules centrally after both agents finish.
const TEST_WAYPOINTS = [
  { id: 'wp-chat', label: 'Chat', route: '/', position: [0, 0, 2] as const },
  {
    id: 'wp-dash',
    label: 'Dashboard',
    route: '/admin/dashboard',
    position: [2, 0, -1] as const,
  },
]

vi.mock('./office-layout', () => ({
  ROOM: { size: 16, wallHeight: 4 },
  FURNITURE: [
    { modelId: 'desk', position: [1, 0, 1] as const },
    { modelId: 'plant', position: [-2, 0, -2] as const, rotationY: 0.4, scale: 1.2 },
  ],
  WAYPOINTS: TEST_WAYPOINTS,
}))

vi.mock('./office-agents', () => ({
  DEMO_AGENTS: [
    { id: 'a1', name: 'Ada', color: '#6366f1', homeWaypointId: 'wp-chat' },
    { id: 'a2', name: 'Linus', color: '#22d3ee', homeWaypointId: 'wp-dash' },
  ],
  // Deterministic round-robin over the waypoints.
  pickTargetWaypoint: (
    _agentId: string,
    tickIndex: number,
    waypoints: typeof TEST_WAYPOINTS,
  ) => waypoints[tickIndex % waypoints.length],
  stepTowards: (
    _current: readonly [number, number],
    target: readonly [number, number],
  ) => ({ position: [target[0], target[1]] as [number, number], arrived: true }),
}))

// Imported AFTER the mocks above are registered.
const { OfficeSceneContents } = await import('./OfficeScene')

describe('OfficeSceneContents — furnished office scene', () => {
  it('mounts without WebGL and renders clickable waypoint hotspots', async () => {
    const onSelect = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <OfficeSceneContents onSelect={onSelect} />,
    )

    // Floor + two walls + furniture primitives have no onClick; only the
    // waypoint hotspot discs do.
    const clickable = renderer.scene
      .findAllByType('Mesh')
      .filter((m) => typeof m.props.onClick === 'function')

    expect(clickable).toHaveLength(TEST_WAYPOINTS.length)
  })

  it('navigates to the waypoint route when a hotspot is clicked', async () => {
    const onSelect = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <OfficeSceneContents onSelect={onSelect} />,
    )

    const clickable = renderer.scene
      .findAllByType('Mesh')
      .filter((m) => typeof m.props.onClick === 'function')

    // Hotspots render in WAYPOINTS order; each click navigates to its route.
    for (let i = 0; i < clickable.length; i++) {
      onSelect.mockClear()
      await renderer.fireEvent(clickable[i], 'click')
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(TEST_WAYPOINTS[i].route)
    }
  })
})
