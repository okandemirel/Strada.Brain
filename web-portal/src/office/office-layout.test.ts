import { describe, it, expect } from 'vitest'
import { FURNITURE, WAYPOINTS, ROOM } from './office-layout'
import { OFFICE_STATIONS } from './office-stations'

/**
 * The real, navigable app routes — kept in sync with office-stations.ts (which
 * is itself kept in sync with the <Route> tree in src/App.tsx). Every waypoint
 * must point at one of these so a click still navigates.
 */
const REAL_APP_ROUTES = [
  '/',
  '/admin/dashboard',
  '/admin/config',
  '/admin/tools',
  '/admin/channels',
  '/admin/sessions',
  '/admin/logs',
  '/admin/identity',
  '/admin/personality',
  '/admin/memory',
  '/admin/vaults',
  '/admin/settings',
  '/admin/skills',
] as const

/** The furniture model ids the scene + asset manifest agree on. */
const KNOWN_FURNITURE_IDS = [
  'desk',
  'chair',
  'table',
  'couch',
  'plant',
  'bookshelf',
  'monitor',
  'rug',
] as const

const HALF = ROOM.size / 2

describe('ROOM', () => {
  it('has a positive size and wall height', () => {
    expect(ROOM.size).toBeGreaterThan(0)
    expect(ROOM.wallHeight).toBeGreaterThan(0)
  })
})

describe('WAYPOINTS', () => {
  it('is non-empty', () => {
    expect(WAYPOINTS.length).toBeGreaterThan(0)
  })

  it('has unique ids', () => {
    const ids = WAYPOINTS.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('maps every waypoint to a real app route', () => {
    for (const waypoint of WAYPOINTS) {
      expect(REAL_APP_ROUTES).toContain(waypoint.route)
    }
  })

  it('covers every real app route exactly once', () => {
    const routes = WAYPOINTS.map((w) => w.route)
    expect(new Set(routes).size).toBe(routes.length)
    expect(new Set(routes)).toEqual(new Set(REAL_APP_ROUTES))
  })

  it('matches the office-stations route set (kept in lock-step)', () => {
    const waypointRoutes = new Set(WAYPOINTS.map((w) => w.route))
    const stationRoutes = new Set(OFFICE_STATIONS.map((s) => s.route))
    expect(waypointRoutes).toEqual(stationRoutes)
  })

  it('has non-empty labels', () => {
    for (const waypoint of WAYPOINTS) {
      expect(waypoint.label.trim().length).toBeGreaterThan(0)
    }
  })

  it('places every waypoint on finite floor coordinates inside the room', () => {
    for (const waypoint of WAYPOINTS) {
      expect(waypoint.position).toHaveLength(3)
      const [x, y, z] = waypoint.position
      for (const axis of waypoint.position) {
        expect(Number.isFinite(axis)).toBe(true)
      }
      // Floor-level (y ~ 0) and within the room footprint.
      expect(y).toBeCloseTo(0)
      expect(Math.abs(x)).toBeLessThanOrEqual(HALF)
      expect(Math.abs(z)).toBeLessThanOrEqual(HALF)
    }
  })

  it('gives each waypoint a distinct position', () => {
    const positions = WAYPOINTS.map((w) => w.position.join(','))
    expect(new Set(positions).size).toBe(positions.length)
  })
})

describe('FURNITURE', () => {
  it('is non-empty (a furnished office)', () => {
    expect(FURNITURE.length).toBeGreaterThan(0)
  })

  it('references only known model ids', () => {
    for (const piece of FURNITURE) {
      expect(KNOWN_FURNITURE_IDS).toContain(piece.modelId)
    }
  })

  it('includes the core furnishings of an open office + meeting room', () => {
    const used = new Set(FURNITURE.map((p) => p.modelId))
    // A believable furnished office must at least have desks, chairs, a meeting
    // table, a couch, plants, a bookshelf, monitors and a rug.
    for (const id of KNOWN_FURNITURE_IDS) {
      expect(used).toContain(id)
    }
  })

  it('places every piece on finite coordinates inside the room footprint', () => {
    for (const piece of FURNITURE) {
      expect(piece.position).toHaveLength(3)
      const [x, , z] = piece.position
      for (const axis of piece.position) {
        expect(Number.isFinite(axis)).toBe(true)
      }
      expect(Math.abs(x)).toBeLessThanOrEqual(HALF)
      expect(Math.abs(z)).toBeLessThanOrEqual(HALF)
    }
  })

  it('uses finite, positive scale and finite rotation when provided', () => {
    for (const piece of FURNITURE) {
      if (piece.scale !== undefined) {
        expect(Number.isFinite(piece.scale)).toBe(true)
        expect(piece.scale).toBeGreaterThan(0)
      }
      if (piece.rotationY !== undefined) {
        expect(Number.isFinite(piece.rotationY)).toBe(true)
      }
    }
  })

  it('has more than one desk and chair (an open-plan team office)', () => {
    const deskCount = FURNITURE.filter((p) => p.modelId === 'desk').length
    const chairCount = FURNITURE.filter((p) => p.modelId === 'chair').length
    expect(deskCount).toBeGreaterThanOrEqual(2)
    expect(chairCount).toBeGreaterThanOrEqual(2)
  })
})
