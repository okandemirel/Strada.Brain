/**
 * Office agents — the PURE logic that drives the walking avatars in the
 * furnished isometric office. No three.js import: this is plain 2D (x, z) math
 * + deterministic target selection, so it unit-tests fully in jsdom. The scene
 * (OfficeScene.tsx) wires it into `useFrame`, advancing each avatar toward its
 * current target waypoint every frame.
 *
 * v1 STAND-IN: {@link DEMO_AGENTS} is a small, hand-authored cast used only to
 * make the office feel alive until real data is available. {@link pickTargetWaypoint}
 * is the deliberate SEAM where the real wiring plugs in later: replace its
 * round-robin schedule with a "which task is agent X working on, and where does
 * that task live" mapping sourced from the live AgentManager. Nothing visual or
 * spatial needs to change — only the body of pickTargetWaypoint.
 */
import type { OfficeWaypoint } from './office-layout'

/** A walking avatar in the office. */
export interface OfficeAgent {
  /** Stable unique id. */
  id: string
  /** Display name shown above the avatar. */
  name: string
  /** Accent colour (hex) for the avatar / its label. */
  color: string
  /** Waypoint id the agent starts at (its "home" desk). */
  homeWaypointId: string
}

/**
 * Representative cast of agents — the v1 stand-in for real AgentManager data.
 * Kept deliberately small (4) so the office reads as lively, not crowded. Each
 * starts at a distinct home waypoint and is given a distinct accent colour.
 *
 * REPLACE-ME: when the live AgentManager is wired, derive this list (and the
 * per-agent targets in pickTargetWaypoint) from real agents + their tasks.
 */
export const DEMO_AGENTS: readonly OfficeAgent[] = [
  { id: 'aria', name: 'Aria', color: '#6366f1', homeWaypointId: 'dashboard' },
  { id: 'nova', name: 'Nova', color: '#22d3ee', homeWaypointId: 'memory' },
  { id: 'orion', name: 'Orion', color: '#f59e0b', homeWaypointId: 'tools' },
  { id: 'lyra', name: 'Lyra', color: '#ec4899', homeWaypointId: 'settings' },
]

/**
 * Deterministic, stable hash of a string -> non-negative integer. Used to give
 * each agent its own phase offset so they don't all walk to the same spot in
 * lockstep, while keeping selection fully reproducible (no Math.random).
 */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    // (hash * 31 + charCode), kept in 32-bit range; >>> 0 makes it unsigned.
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

/**
 * Deterministically pick which task spot an agent is heading to on a given
 * tick. This is the SEAM for real task->location wiring; today it round-robins
 * the agent through every waypoint, offset by a per-agent hash so different
 * agents target different spots on the same tick.
 *
 * Deterministic: same (agentId, tickIndex, waypoints) always yields the same
 * waypoint. Always returns a valid member of `waypoints`.
 *
 * @throws if `waypoints` is empty (there is no valid spot to return).
 */
export function pickTargetWaypoint(
  agentId: string,
  tickIndex: number,
  waypoints: readonly OfficeWaypoint[],
): OfficeWaypoint {
  if (waypoints.length === 0) {
    throw new Error('pickTargetWaypoint: waypoints must not be empty')
  }
  const offset = hashString(agentId)
  // Floor tickIndex so fractional ticks (rare, but possible if a caller passes
  // elapsed time) still index a stable waypoint, and guard against negatives.
  const tick = Math.max(0, Math.floor(tickIndex))
  const index = (offset + tick) % waypoints.length
  return waypoints[index]
}

/** Distance at which an agent is considered to have arrived at its target. */
export const ARRIVAL_EPSILON = 0.05

/**
 * Move a point in 2D (x, z) toward a target at `speed` units/second over `dt`
 * seconds. Pure: returns a new position and whether the target was reached.
 *
 * - Never overshoots: if the remaining distance is <= the step (or within
 *   {@link ARRIVAL_EPSILON}), it clamps exactly onto the target and reports
 *   `arrived: true`.
 * - dt-scaled: the step length is `speed * dt`, so movement is frame-rate
 *   independent.
 * - Non-positive / non-finite step (speed <= 0, dt <= 0) makes no progress but
 *   still reports arrival if already at the target.
 */
export function stepTowards(
  current: readonly [number, number],
  target: readonly [number, number],
  speed: number,
  dt: number,
): { position: [number, number]; arrived: boolean } {
  const [cx, cz] = current
  const [tx, tz] = target
  const dx = tx - cx
  const dz = tz - cz
  const distance = Math.hypot(dx, dz)

  // Already there (within epsilon): clamp exactly onto target.
  if (distance <= ARRIVAL_EPSILON) {
    return { position: [tx, tz], arrived: true }
  }

  const step = speed * dt
  // No usable step this frame: stay put, not yet arrived.
  if (!Number.isFinite(step) || step <= 0) {
    return { position: [cx, cz], arrived: false }
  }

  // Would reach or pass the target this frame: clamp onto it (no overshoot).
  if (step >= distance) {
    return { position: [tx, tz], arrived: true }
  }

  // Partial step along the unit direction vector.
  const t = step / distance
  return { position: [cx + dx * t, cz + dz * t], arrived: false }
}
