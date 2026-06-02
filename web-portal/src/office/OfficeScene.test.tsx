import { describe, it, expect, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { OfficeSceneContents } from './OfficeScene'
import { OFFICE_STATIONS } from './office-stations'

// drei's <Html> portals into the DOM and <OrbitControls> wants a real
// camera/renderer; stub both so the test-renderer only deals with the plain
// station meshes whose click->onSelect wiring we are verifying. No WebGL needed.
vi.mock('@react-three/drei', () => ({
  Html: () => null,
  OrbitControls: () => null,
}))

describe('OfficeSceneContents — 3D click navigation', () => {
  it('calls onSelect with the correct route when each station mesh is clicked', async () => {
    const onSelect = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <OfficeSceneContents onSelect={onSelect} />,
    )

    // Floor + two walls have no onClick; only the station desks do.
    const stationMeshes = renderer.scene
      .findAllByType('Mesh')
      .filter((m) => typeof m.props.onClick === 'function')

    expect(stationMeshes).toHaveLength(OFFICE_STATIONS.length)

    // Meshes render in OFFICE_STATIONS order; each must navigate to its route.
    for (let i = 0; i < stationMeshes.length; i++) {
      onSelect.mockClear()
      await renderer.fireEvent(stationMeshes[i], 'click')
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(OFFICE_STATIONS[i].route)
    }
  })
})
