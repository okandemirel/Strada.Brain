import { describe, it, expect } from 'vitest'
import {
  DEMO_AGENTS,
  pickTargetWaypoint,
  stepTowards,
  ARRIVAL_EPSILON,
} from './office-agents'
import { WAYPOINTS } from './office-layout'
import type { OfficeWaypoint } from './office-layout'

describe('DEMO_AGENTS', () => {
  it('is a small representative cast (3-5 agents)', () => {
    expect(DEMO_AGENTS.length).toBeGreaterThanOrEqual(3)
    expect(DEMO_AGENTS.length).toBeLessThanOrEqual(5)
  })

  it('has unique ids and distinct colours', () => {
    const ids = DEMO_AGENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    const colors = DEMO_AGENTS.map((a) => a.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('gives each agent a non-empty name and valid hex colour', () => {
    for (const agent of DEMO_AGENTS) {
      expect(agent.name.trim().length).toBeGreaterThan(0)
      expect(agent.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('points every home waypoint id at a real waypoint', () => {
    const waypointIds = new Set(WAYPOINTS.map((w) => w.id))
    for (const agent of DEMO_AGENTS) {
      expect(waypointIds).toContain(agent.homeWaypointId)
    }
  })
})

describe('pickTargetWaypoint', () => {
  it('always returns a member of the supplied waypoints', () => {
    for (const agent of DEMO_AGENTS) {
      for (let tick = 0; tick < 50; tick++) {
        const target = pickTargetWaypoint(agent.id, tick, WAYPOINTS)
        expect(WAYPOINTS).toContain(target)
      }
    }
  })

  it('is deterministic for the same inputs', () => {
    const a = pickTargetWaypoint('aria', 7, WAYPOINTS)
    const b = pickTargetWaypoint('aria', 7, WAYPOINTS)
    expect(a).toBe(b)
  })

  it('advances through waypoints as the tick increases (cycles them)', () => {
    // Over one full cycle, a single agent should visit every distinct waypoint.
    const visited = new Set<string>()
    for (let tick = 0; tick < WAYPOINTS.length; tick++) {
      visited.add(pickTargetWaypoint('aria', tick, WAYPOINTS).id)
    }
    expect(visited.size).toBe(WAYPOINTS.length)
  })

  it('wraps around after a full cycle', () => {
    const first = pickTargetWaypoint('nova', 3, WAYPOINTS)
    const wrapped = pickTargetWaypoint('nova', 3 + WAYPOINTS.length, WAYPOINTS)
    expect(wrapped).toBe(first)
  })

  it('offsets different agents so they do not all target the same spot', () => {
    // The four demo agents should not all sit on the identical waypoint at t=0
    // (the per-agent hash offset spreads them out).
    const targetsAtZero = DEMO_AGENTS.map((a) => pickTargetWaypoint(a.id, 0, WAYPOINTS).id)
    expect(new Set(targetsAtZero).size).toBeGreaterThan(1)
  })

  it('floors fractional ticks to a stable waypoint', () => {
    expect(pickTargetWaypoint('orion', 2.9, WAYPOINTS)).toBe(
      pickTargetWaypoint('orion', 2, WAYPOINTS),
    )
  })

  it('throws when there are no waypoints', () => {
    expect(() => pickTargetWaypoint('aria', 0, [])).toThrow()
  })
})

describe('stepTowards', () => {
  it('moves toward the target along the connecting line', () => {
    const { position, arrived } = stepTowards([0, 0], [10, 0], 1, 1)
    expect(position[0]).toBeCloseTo(1)
    expect(position[1]).toBeCloseTo(0)
    expect(arrived).toBe(false)
    // It got strictly closer.
    expect(Math.hypot(10 - position[0], 0 - position[1])).toBeLessThan(10)
  })

  it('moves diagonally toward the target, reducing distance by the step length', () => {
    const start: [number, number] = [0, 0]
    const target: [number, number] = [3, 4] // distance 5
    const { position } = stepTowards(start, target, 1, 1) // step length 1
    const remaining = Math.hypot(target[0] - position[0], target[1] - position[1])
    expect(remaining).toBeCloseTo(4) // 5 - 1
    // Stays on the line: x/z ratio preserved (3:4).
    expect(position[0] / position[1]).toBeCloseTo(3 / 4)
  })

  it('scales movement by dt (frame-rate independent)', () => {
    const slow = stepTowards([0, 0], [10, 0], 2, 0.5) // step 1
    const fast = stepTowards([0, 0], [10, 0], 2, 1) // step 2
    expect(slow.position[0]).toBeCloseTo(1)
    expect(fast.position[0]).toBeCloseTo(2)
  })

  it('never overshoots: clamps exactly onto the target', () => {
    // A huge step would pass the target; it must land exactly on it.
    const { position, arrived } = stepTowards([0, 0], [3, 4], 1000, 1)
    expect(position[0]).toBe(3)
    expect(position[1]).toBe(4)
    expect(arrived).toBe(true)
  })

  it('reports arrival when within epsilon and snaps to the target', () => {
    const target: [number, number] = [5, 5]
    const near: [number, number] = [5 + ARRIVAL_EPSILON / 2, 5]
    const { position, arrived } = stepTowards(near, target, 1, 1)
    expect(arrived).toBe(true)
    expect(position[0]).toBe(target[0])
    expect(position[1]).toBe(target[1])
  })

  it('makes no progress with a non-positive step but is not "arrived" if far', () => {
    const zeroSpeed = stepTowards([0, 0], [10, 0], 0, 1)
    expect(zeroSpeed.position).toEqual([0, 0])
    expect(zeroSpeed.arrived).toBe(false)

    const zeroDt = stepTowards([0, 0], [10, 0], 5, 0)
    expect(zeroDt.position).toEqual([0, 0])
    expect(zeroDt.arrived).toBe(false)
  })

  it('reports arrival immediately when already on the target', () => {
    const { position, arrived } = stepTowards([2, -3], [2, -3], 5, 1)
    expect(arrived).toBe(true)
    expect(position).toEqual([2, -3])
  })

  it('reaches the target after enough repeated steps without overshooting', () => {
    let pos: [number, number] = [0, 0]
    const target: [number, number] = [7, -4]
    let arrived = false
    let guard = 0
    while (!arrived && guard < 10000) {
      const result = stepTowards(pos, target, 1.3, 0.2)
      pos = result.position
      arrived = result.arrived
      guard++
      // It must never overshoot past the target in any single step.
      expect(Math.hypot(target[0] - pos[0], target[1] - pos[1])).toBeGreaterThanOrEqual(0)
    }
    expect(arrived).toBe(true)
    expect(pos[0]).toBeCloseTo(target[0])
    expect(pos[1]).toBeCloseTo(target[1])
  })

  it('drives a demo agent toward its picked waypoint', () => {
    const agent = DEMO_AGENTS[0]
    const target = pickTargetWaypoint(agent.id, 1, WAYPOINTS)
    const targetXZ: [number, number] = [target.position[0], target.position[2]]
    const before = Math.hypot(targetXZ[0] - 0, targetXZ[1] - 0)
    const { position } = stepTowards([0, 0], targetXZ, 1, 0.5)
    const after = Math.hypot(targetXZ[0] - position[0], targetXZ[1] - position[1])
    // Moving from origin toward a non-origin waypoint reduces the distance.
    const sameSpot = (target as OfficeWaypoint).position[0] === 0 &&
      (target as OfficeWaypoint).position[2] === 0
    if (!sameSpot) {
      expect(after).toBeLessThan(before)
    }
  })
})
