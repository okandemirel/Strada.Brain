import { describe, it, expect } from 'vitest'
import {
  WAYPOINTS,
  DEMO_AGENTS,
  pickTargetWaypoint,
  stepTowards,
  toWorld,
  mapLiveAgents,
  mapMonitorTasks,
  RECENT_ACTIVITY_MS,
  OFFICE_W,
  OFFICE_H,
  FURNITURE,
  buildNavGrid,
  findPath,
  navCellAt,
  NAV_GRID,
  seedWalkState,
  advanceWalk,
  type OfficeAgent,
} from './officeModel'
import { OFFICE_STATIONS } from '../office-stations'

describe('officeModel — waypoints', () => {
  it('maps every waypoint to a real station route (stays in sync with office-stations)', () => {
    const stationRoutes = new Set(OFFICE_STATIONS.map((s) => s.route))
    for (const wp of WAYPOINTS) {
      expect(stationRoutes.has(wp.route)).toBe(true)
    }
  })

  it('has unique ids and covers all 13 stations', () => {
    const ids = WAYPOINTS.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(WAYPOINTS).toHaveLength(OFFICE_STATIONS.length)
  })

  it('positions every waypoint inside the office canvas', () => {
    for (const wp of WAYPOINTS) {
      expect(wp.x).toBeGreaterThanOrEqual(0)
      expect(wp.x).toBeLessThanOrEqual(OFFICE_W)
      expect(wp.y).toBeGreaterThanOrEqual(0)
      expect(wp.y).toBeLessThanOrEqual(OFFICE_H)
    }
  })
})

describe('officeModel — agents', () => {
  it('every agent home references a real waypoint', () => {
    const ids = new Set(WAYPOINTS.map((w) => w.id))
    for (const a of DEMO_AGENTS) {
      expect(ids.has(a.homeWaypointId)).toBe(true)
    }
  })
})

describe('pickTargetWaypoint', () => {
  it('is deterministic and always returns a valid waypoint', () => {
    for (const a of DEMO_AGENTS) {
      for (let tick = 0; tick < 30; tick++) {
        const w1 = pickTargetWaypoint(a.id, tick)
        const w2 = pickTargetWaypoint(a.id, tick)
        expect(w1).toBe(w2)
        expect(WAYPOINTS).toContain(w1)
      }
    }
  })

  it('handles fractional and negative ticks safely', () => {
    expect(WAYPOINTS).toContain(pickTargetWaypoint('aria', 2.7))
    expect(WAYPOINTS).toContain(pickTargetWaypoint('aria', -5))
  })
})

describe('stepTowards', () => {
  it('reports arrival within epsilon and clamps onto the target', () => {
    const { position, arrived } = stepTowards([100, 100], [101, 100], 80, 0.016)
    expect(arrived).toBe(true)
    expect(position).toEqual([101, 100])
  })

  it('never overshoots — clamps when the step exceeds the distance', () => {
    const { position, arrived } = stepTowards([0, 0], [10, 0], 1000, 1)
    expect(arrived).toBe(true)
    expect(position).toEqual([10, 0])
  })

  it('takes a proportional partial step when far away', () => {
    const { position, arrived } = stepTowards([0, 0], [100, 0], 50, 1)
    expect(arrived).toBe(false)
    expect(position[0]).toBeCloseTo(50, 5)
    expect(position[1]).toBeCloseTo(0, 5)
  })

  it('makes no progress with a non-positive step', () => {
    const { position, arrived } = stepTowards([5, 5], [99, 99], 0, 1)
    expect(arrived).toBe(false)
    expect(position).toEqual([5, 5])
  })
})

describe('mapLiveAgents (wiring real /api/agents data)', () => {
  const now = 1_000_000_000

  it('uses the real agent count and key as the display name', () => {
    const out = mapLiveAgents(
      [
        { id: 'a1', key: 'researcher', lastActivity: now },
        { id: 'a2', key: 'coder', lastActivity: now },
      ],
      now,
    )
    expect(out).toHaveLength(2)
    expect(out.map((a) => a.name)).toEqual(['researcher', 'coder'])
    expect(out.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('renders readable nameplates for channel-session keys (web:uuid → "Web 9914")', () => {
    const out = mapLiveAgents(
      [
        { id: 'x', key: 'web:67990889-5025-4541-9dc3-d9e586709914', channelType: 'web' },
        { id: 'y', key: 'web:1a8afdb7-fb4a-401a-8939-7e610aeb3fe7', channelType: 'web' },
      ],
      now,
    )
    expect(out.map((a) => a.name)).toEqual(['Web 9914', 'Web 3fe7'])
  })

  it('labels a bare UUID id by channelType + suffix, and keeps friendly keys', () => {
    expect(
      mapLiveAgents([{ id: '67990889-5025-4541-9dc3-d9e586709914', channelType: 'web' }], now)[0].name,
    ).toBe('Web 9914')
    expect(mapLiveAgents([{ id: 'a1', key: 'researcher' }], now)[0].name).toBe('researcher')
  })

  it('derives active from recent lastActivity relative to the fetch time', () => {
    const recent = mapLiveAgents([{ id: 'a', lastActivity: now - 1_000 }], now)[0]
    const stale = mapLiveAgents([{ id: 'b', lastActivity: now - RECENT_ACTIVITY_MS - 1 }], now)[0]
    expect(recent.active).toBe(true)
    expect(stale.active).toBe(false)
  })

  it('assigns each agent a real waypoint home (round-robin) and a colour', () => {
    const out = mapLiveAgents([{ id: 'a' }, { id: 'b' }], now)
    const ids = new Set(WAYPOINTS.map((w) => w.id))
    for (const a of out) {
      expect(ids.has(a.homeWaypointId)).toBe(true)
      expect(a.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('mapMonitorTasks (wiring the live supervisor work)', () => {
  it('shows only in-flight tasks as working agents (skips done/failed)', () => {
    const out = mapMonitorTasks([
      { id: 't1', title: 'Analyze level data', status: 'executing' },
      { id: 't2', title: 'Verify output', status: 'verifying' },
      { id: 't3', title: 'Old task', status: 'completed' },
      { id: 't4', title: 'Dead task', status: 'failed' },
      { id: 't5', title: 'Queued', status: 'pending' },
    ])
    expect(out.map((a) => a.id)).toEqual(['t1', 't2', 't5'])
  })

  it('labels avatars by (shortened) task title and flags executing as active', () => {
    const [a] = mapMonitorTasks([
      { id: 't', title: 'A very long task title that should be truncated for the nameplate', status: 'executing' },
    ])
    expect(a.name.length).toBeLessThanOrEqual(22)
    expect(a.active).toBe(true)
    const [v] = mapMonitorTasks([{ id: 'v', title: 'Verify', status: 'verifying' }])
    expect(v.active).toBe(false)
  })

  it('caps the crowd and assigns valid waypoint homes', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: 'executing' }))
    const out = mapMonitorTasks(many)
    expect(out.length).toBeLessThanOrEqual(10)
    const ids = new Set(WAYPOINTS.map((w) => w.id))
    for (const a of out) expect(ids.has(a.homeWaypointId)).toBe(true)
  })

  it('returns nothing when there is no live work', () => {
    expect(mapMonitorTasks([])).toEqual([])
    expect(mapMonitorTasks([{ id: 'x', status: 'completed' }])).toEqual([])
  })
})

describe('toWorld', () => {
  it('maps the canvas centre to the world origin', () => {
    const [x, y, z] = toWorld(OFFICE_W / 2, OFFICE_H / 2)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBe(0)
    expect(z).toBeCloseTo(0, 6)
  })
})

describe('buildNavGrid (Hermes A* occupancy grid)', () => {
  it('marks a blocking desk cubicle as impassable but leaves the open aisle free', () => {
    const grid = buildNavGrid([{ type: 'desk_cubicle', x: 100, y: 300, id: 'd' }])
    expect(navCellAt(grid, 150, 320)).toBe(1) // inside the desk footprint → blocked
    expect(navCellAt(grid, 600, 400)).toBe(0) // far-away open floor → free
  })

  it('walls off the office border but keeps the interior open', () => {
    const grid = buildNavGrid([])
    expect(navCellAt(grid, 2, 2)).toBe(1) // top-left border cell
    expect(navCellAt(grid, OFFICE_W - 2, OFFICE_H - 2)).toBe(1) // bottom-right border cell
    expect(navCellAt(grid, OFFICE_W / 2, OFFICE_H / 2)).toBe(0) // centre is walkable
  })

  it('does not block passable props (chairs and desk computers are walk-through)', () => {
    const grid = buildNavGrid([
      { type: 'chair', x: 400, y: 400 },
      { type: 'computer', x: 410, y: 405 },
    ])
    expect(navCellAt(grid, 412, 407)).toBe(0)
  })

  it('blocks freestanding plants so agents detour around the plant models (Hermes issue #4)', () => {
    const grid = buildNavGrid([{ type: 'plant', x: 450, y: 450 }])
    expect(navCellAt(grid, 456, 456)).toBe(1)
  })
})

describe('findPath (A* routing around furniture)', () => {
  it('routes around a blocker without ever stepping on a blocked cell, ending at the target', () => {
    const grid = buildNavGrid([{ type: 'bookshelf', x: 560, y: 300, w: 80, h: 120 }])
    const start: [number, number] = [540, 360] // left of the bookshelf
    const end: [number, number] = [700, 360] // right of the bookshelf
    const path = findPath(start, end, grid)
    expect(path.length).toBeGreaterThan(0)
    expect(path[path.length - 1]).toEqual(end) // arrives exactly at the target pixel
    for (const [x, y] of path) expect(navCellAt(grid, x, y)).toBe(0) // never clips furniture
  })

  it('always returns at least the destination so an agent never freezes', () => {
    const grid = buildNavGrid(FURNITURE)
    const path = findPath([20, 20], [OFFICE_W - 20, OFFICE_H - 20], grid)
    expect(path.length).toBeGreaterThan(0)
    expect(path[path.length - 1]).toEqual([OFFICE_W - 20, OFFICE_H - 20])
  })
})

describe('NAV_GRID + waypoint placement', () => {
  it('places every clickable waypoint on a free (walkable) cell, not on furniture', () => {
    for (const wp of WAYPOINTS) {
      expect({ id: wp.id, cell: navCellAt(NAV_GRID, wp.x, wp.y) }).toEqual({ id: wp.id, cell: 0 })
    }
  })
})

describe('seedWalkState + advanceWalk (A* walking behaviour)', () => {
  const grid = NAV_GRID
  const active: OfficeAgent = {
    id: 'aria', name: 'Aria', color: '#6366f1', homeWaypointId: 'dashboard', active: true,
  }
  const idle: OfficeAgent = { ...active, id: 'idle', active: false }

  it('seeds an active agent at its home with a planned A* path to its first target', () => {
    const s = seedWalkState(active, grid)
    const home = WAYPOINTS.find((w) => w.id === 'dashboard')!
    expect(s.position).toEqual([home.x, home.y])
    expect(s.path.length).toBeGreaterThan(0)
    const first = pickTargetWaypoint('aria', 0)
    expect(s.path[s.path.length - 1]).toEqual([first.x, first.y]) // destination = first station
  })

  it('seeds an idle agent standing still at home (no path)', () => {
    const s = seedWalkState(idle, grid)
    const home = WAYPOINTS.find((w) => w.id === 'dashboard')!
    expect(s.position).toEqual([home.x, home.y])
    expect(s.path).toEqual([])
  })

  it('advances an active agent along its path, reporting movement + a heading', () => {
    const s = seedWalkState(active, grid)
    const before: [number, number] = [...s.position]
    const { moving, heading } = advanceWalk(s, active, grid, 0.5)
    expect(moving).toBe(true)
    expect(heading).not.toBeNull()
    expect(s.position).not.toEqual(before)
  })

  it('every node the agent steps onto stays on walkable floor (never clips furniture)', () => {
    const s = seedWalkState(active, grid)
    for (let i = 0; i < 400; i++) {
      advanceWalk(s, active, grid, 0.1)
      expect(navCellAt(grid, s.position[0], s.position[1])).toBe(0)
    }
  })

  it('keeps an idle agent put', () => {
    const s = seedWalkState(idle, grid)
    const before: [number, number] = [...s.position]
    const { moving } = advanceWalk(s, idle, grid, 0.5)
    expect(moving).toBe(false)
    expect(s.position).toEqual(before)
  })

  it('on reaching its destination, dwells then re-plans a route to the next station', () => {
    const s = seedWalkState(active, grid)
    let guard = 0
    while (s.path.length > 0 && guard++ < 5000) advanceWalk(s, active, grid, 0.2)
    expect(s.path.length).toBe(0) // arrived
    const next = advanceWalk(s, active, grid, 0.016)
    expect(next.moving).toBe(false)
    expect(s.dwell).toBeGreaterThan(0) // pauses at the station
    expect(s.path.length).toBeGreaterThan(0) // new route planned
  })
})
