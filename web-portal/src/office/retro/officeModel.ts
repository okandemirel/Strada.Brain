/**
 * Office model — pure data + geometry ported from Hermes's RetroOffice3D
 * (`~/.hermes/hermes-office/src/features/retro-office`). This is the proven
 * Hermes approach: a 2D-authored furniture layout (pixel coords on a virtual
 * canvas) rendered in 3D via an orthographic r3f camera, with a TWO-FACTOR
 * scale that fixes Strada's old "giant shapes":
 *
 *   1. WORLD SCALE — every canvas pixel is multiplied by SCALE (0.018) so the
 *      whole canvas becomes a ~21x14 world-unit floor. (Treating px as metres
 *      is what made the old scene ~55x too big.)
 *   2. PER-MODEL GLB SCALE — each furniture type has a fixed, hand-tuned
 *      `FURNITURE_SCALE` multiplier applied to its raw Kenney GLB (which ships
 *      ~1 unit). NO bounding-box normalisation — that fights the fixed values.
 *
 * three.js-free so it can be unit-tested in jsdom. Coordinates: canvas (x,y) in
 * px, origin top-left, y down; toWorld maps to world [x, 0, z] (y up = floor).
 */

export type FurnitureItem = {
  type: string
  x: number
  y: number
  w?: number
  h?: number
  r?: number
  color?: string
  id?: string
  facing?: number
  vertical?: boolean
  elevation?: number
}

// ── world / canvas constants (Hermes core/constants.ts) ─────────────────────
/** px → world-unit factor. A 100px desk → 1.8 world units. */
export const SCALE = 0.018
/** Virtual authoring canvas (px). The furnished content lives inside this box. */
export const OFFICE_W = 1180
export const OFFICE_H = 760
/** World-space floor extent (centred on the origin). */
export const WORLD_W = OFFICE_W * SCALE // 21.24
export const WORLD_H = OFFICE_H * SCALE // 13.68

/** Canvas px → world [x, 0, z]; canvas centre maps to the world origin. */
export const toWorld = (cx: number, cy: number): [number, number, number] => [
  cx * SCALE - OFFICE_W * SCALE * 0.5,
  0,
  cy * SCALE - OFFICE_H * SCALE * 0.5,
]

// ── per-type footprint (px) — drives the rotation pivot (Hermes geometry.ts) ─
export const ITEM_FOOTPRINT: Record<string, [number, number]> = {
  desk_cubicle: [100, 55],
  chair: [24, 24],
  round_table: [120, 120],
  executive_desk: [130, 65],
  couch: [100, 40],
  couch_v: [40, 80],
  bookshelf: [80, 120],
  plant: [24, 24],
  beanbag: [40, 40],
  pingpong: [100, 60],
  table_rect: [80, 40],
  coffee_machine: [32, 34],
  fridge: [40, 80],
  water_cooler: [20, 54],
  whiteboard: [10, 60],
  cabinet: [200, 40],
  computer: [30, 20],
  lamp: [30, 30],
}

/** Round items use their diameter; otherwise the footprint (or explicit w/h). */
export const resolveItemTypeKey = (item: FurnitureItem): string =>
  item.type === 'couch' && item.vertical ? 'couch_v' : item.type

export const getItemBaseSize = (item: FurnitureItem): { width: number; height: number } => {
  if (item.r !== undefined) return { width: item.r * 2, height: item.r * 2 }
  const [dw, dh] = ITEM_FOOTPRINT[resolveItemTypeKey(item)] ?? [item.w ?? 40, item.h ?? 40]
  return { width: item.w ?? dw, height: item.h ?? dh }
}

/** Per-type baseline rotation that corrects each GLB's authored forward axis. */
export const FURNITURE_ROTATION: Record<string, number> = {
  couch: Math.PI,
  couch_v: Math.PI / 2,
  executive_desk: -Math.PI / 2,
  whiteboard: Math.PI / 2,
}

/** facing(deg) → radians plus the per-type baseline. */
export const getItemRotationRadians = (item: FurnitureItem): number =>
  ((item.facing ?? 0) * Math.PI) / 180 + (FURNITURE_ROTATION[resolveItemTypeKey(item)] ?? 0)

// ── type → Kenney GLB (copied into public/office-assets/models/furniture) ────
const GLB = '/office-assets/models/furniture'
export const FURNITURE_GLB: Record<string, string> = {
  desk_cubicle: `${GLB}/desk.glb`,
  executive_desk: `${GLB}/deskCorner.glb`,
  chair: `${GLB}/chairDesk.glb`,
  round_table: `${GLB}/tableRound.glb`,
  couch: `${GLB}/loungeSofa.glb`,
  couch_v: `${GLB}/loungeDesignChair.glb`,
  bookshelf: `${GLB}/bookcaseClosed.glb`,
  plant: `${GLB}/pottedPlant.glb`,
  beanbag: `${GLB}/loungeDesignChair.glb`,
  pingpong: `${GLB}/tableCoffee.glb`,
  table_rect: `${GLB}/table.glb`,
  coffee_machine: `${GLB}/kitchenCoffeeMachine.glb`,
  fridge: `${GLB}/kitchenFridgeSmall.glb`,
  water_cooler: `${GLB}/plantSmall1.glb`,
  whiteboard: `${GLB}/bookcaseClosed.glb`,
  cabinet: `${GLB}/kitchenCabinet.glb`,
  computer: `${GLB}/computerScreen.glb`,
  lamp: `${GLB}/lampRoundFloor.glb`,
}
/** Guaranteed fallback path (Hermes uses table_rect). */
export const FALLBACK_GLB = FURNITURE_GLB.table_rect

/** Hand-tuned per-type GLB scale multipliers (NOT bbox-normalised). */
export const FURNITURE_SCALE: Record<string, [number, number, number]> = {
  desk_cubicle: [1.5, 1.5, 1.5],
  executive_desk: [1.8, 1.8, 1.8],
  chair: [1.2, 1.2, 1.2],
  round_table: [3.2, 3.2, 3.2],
  couch: [1.8, 1.8, 1.8],
  couch_v: [1.4, 1.4, 1.4],
  bookshelf: [1.5, 2, 1.5],
  plant: [1.2, 1.8, 1.2],
  beanbag: [1, 1, 1],
  pingpong: [2.4, 1.2, 1.6],
  table_rect: [1.4, 1.2, 1.0],
  coffee_machine: [0.8, 0.8, 0.8],
  fridge: [1, 1.4, 1],
  water_cooler: [1, 2, 1],
  whiteboard: [0.6, 1.4, 0.3],
  cabinet: [2.6, 1.2, 1],
  computer: [1.1, 1.1, 1.1],
  lamp: [1.2, 1.2, 1.2],
}
/** Items that sit on a surface get a small vertical lift (world units). */
export const FURNITURE_Y_OFFSET: Record<string, number> = {
  computer: 0.61,
}

/**
 * The furnished office — the GLB-backed subset of Hermes's DEFAULT_FURNITURE
 * (open-plan desk grid + conference + kitchen + lounge + greenery). Non-GLB
 * Hermes props (procedural machines/kitchen appliances, gym/QA/server/art
 * rooms) are intentionally omitted for this pass. Coordinates are verbatim
 * Hermes canvas px. `id` desks are the seats agents will occupy in Pass 2.
 */
export const FURNITURE: readonly FurnitureItem[] = [
  // ── conference (top-left) ──
  { type: 'round_table', x: 50, y: 50, r: 90 },
  { type: 'chair', x: 130, y: 50, facing: 0 },
  { type: 'chair', x: 200, y: 90, facing: 325 },
  { type: 'chair', x: 180, y: 170, facing: 240 },
  { type: 'chair', x: 50, y: 150, facing: 105 },
  { type: 'chair', x: 60, y: 80, facing: 60 },
  { type: 'bookshelf', x: 600, y: 30, w: 80, h: 120 },
  { type: 'couch', x: 270, y: 90, w: 40, h: 80, vertical: true, facing: 180 },

  // ── kitchen / coffee (top-right) ──
  { type: 'fridge', x: 1050, y: 20, w: 40, h: 80 },
  { type: 'cabinet', x: 840, y: 30, w: 80, h: 40 },
  { type: 'cabinet', x: 980, y: 30, w: 40, h: 40 },
  { type: 'coffee_machine', x: 880, y: 30, elevation: 0.56 },
  { type: 'round_table', x: 890, y: 100, r: 50 },
  { type: 'chair', x: 930, y: 100, facing: 0 },
  { type: 'chair', x: 930, y: 180, facing: 180 },
  { type: 'chair', x: 880, y: 130, facing: 90 },
  { type: 'chair', x: 970, y: 130, facing: 270 },

  // ── desk grid (4x2) — desk + chair + computer per cubicle ──
  { type: 'desk_cubicle', x: 100, y: 300, id: 'desk_0' },
  { type: 'chair', x: 120, y: 290, facing: 180 },
  { type: 'computer', x: 120, y: 287 },
  { type: 'desk_cubicle', x: 300, y: 300, id: 'desk_1' },
  { type: 'chair', x: 320, y: 290, facing: 180 },
  { type: 'computer', x: 320, y: 287 },
  { type: 'desk_cubicle', x: 500, y: 300, id: 'desk_2' },
  { type: 'chair', x: 520, y: 290, facing: 180 },
  { type: 'computer', x: 520, y: 287 },
  { type: 'desk_cubicle', x: 700, y: 300, id: 'desk_3' },
  { type: 'chair', x: 720, y: 290, facing: 180 },
  { type: 'computer', x: 720, y: 287 },
  { type: 'desk_cubicle', x: 100, y: 500, id: 'desk_4' },
  { type: 'chair', x: 120, y: 490, facing: 180 },
  { type: 'computer', x: 120, y: 487 },
  { type: 'desk_cubicle', x: 300, y: 500, id: 'desk_5' },
  { type: 'chair', x: 320, y: 490, facing: 180 },
  { type: 'computer', x: 320, y: 487 },
  { type: 'desk_cubicle', x: 500, y: 500, id: 'desk_6' },
  { type: 'chair', x: 520, y: 490, facing: 180 },
  { type: 'computer', x: 520, y: 487 },
  { type: 'desk_cubicle', x: 700, y: 500, id: 'desk_7' },
  { type: 'chair', x: 720, y: 490, facing: 180 },
  { type: 'computer', x: 720, y: 487 },

  // ── lounge / play (right) ──
  { type: 'couch', x: 1000, y: 380, w: 100, h: 40, facing: 90 },
  { type: 'couch', x: 390, y: 630, w: 100, h: 40 },
  { type: 'table_rect', x: 980, y: 380, w: 60, h: 30, facing: 270 },
  { type: 'pingpong', x: 950, y: 600, w: 100, h: 60 },
  { type: 'beanbag', x: 1000, y: 330, color: '#e65100', facing: 90 },
  { type: 'beanbag', x: 1000, y: 410, color: '#1565c0', facing: 90 },

  // ── greenery + accents ──
  { type: 'whiteboard', x: 40, y: 200, w: 10, h: 60 },
  { type: 'lamp', x: 430, y: 100 },
  { type: 'lamp', x: 980, y: 390 },
  { type: 'plant', x: 40, y: 40 },
  { type: 'plant', x: 660, y: 30 },
  { type: 'plant', x: 340, y: 700 },
  { type: 'plant', x: 450, y: 450 },
  { type: 'plant', x: 1090, y: 310 },
  { type: 'plant', x: 1100, y: 490 },
  { type: 'plant', x: 530, y: 700 },
]

// ── stations / waypoints (the launcher: each maps to a real admin route) ─────
/** A named spot in the office. Clicking its hotspot navigates to `route`;
 * agents also walk between these. Position is in canvas px (see toWorld). */
export interface OfficeWaypoint {
  id: string
  label: string
  route: string
  /** Canvas px (top-left convention, same space as FURNITURE). */
  x: number
  y: number
}

/** The 13 real admin routes, placed across the furnished office (desk grid +
 * conference + kitchen + lounge). Kept in lock-step with office-stations.ts so
 * the 2D list fallback and the 3D hotspots navigate identically. */
export const WAYPOINTS: readonly OfficeWaypoint[] = [
  { id: 'chat', label: 'Chat', route: '/', x: 120, y: 130 },
  { id: 'dashboard', label: 'Dashboard', route: '/admin/dashboard', x: 140, y: 340 },
  { id: 'memory', label: 'Memory', route: '/admin/memory', x: 340, y: 340 },
  { id: 'vaults', label: 'Vaults', route: '/admin/vaults', x: 540, y: 340 },
  { id: 'sessions', label: 'Sessions', route: '/admin/sessions', x: 740, y: 340 },
  { id: 'logs', label: 'Logs', route: '/admin/logs', x: 140, y: 540 },
  { id: 'tools', label: 'Tools', route: '/admin/tools', x: 340, y: 540 },
  { id: 'channels', label: 'Channels', route: '/admin/channels', x: 540, y: 540 },
  { id: 'identity', label: 'Identity', route: '/admin/identity', x: 740, y: 540 },
  { id: 'personality', label: 'Personality', route: '/admin/personality', x: 915, y: 145 },
  { id: 'skills', label: 'Skills', route: '/admin/skills', x: 1010, y: 405 },
  { id: 'settings', label: 'Settings', route: '/admin/settings', x: 440, y: 640 },
  { id: 'config', label: 'Config', route: '/admin/config', x: 600, y: 200 },
]

// ── walking agents (v1 stand-in cast; SEAM for real AgentManager data) ───────
export interface OfficeAgent {
  id: string
  name: string
  /** Accent colour (hex) for the avatar shirt + nameplate. */
  color: string
  /** Waypoint id the agent starts at. */
  homeWaypointId: string
  /** Whether the agent is currently active (walks) vs idle (rests at home). */
  active?: boolean
}

export const DEMO_AGENTS: readonly OfficeAgent[] = [
  { id: 'aria', name: 'Aria', color: '#6366f1', homeWaypointId: 'dashboard', active: true },
  { id: 'nova', name: 'Nova', color: '#22d3ee', homeWaypointId: 'memory', active: true },
  { id: 'orion', name: 'Orion', color: '#f59e0b', homeWaypointId: 'tools', active: true },
  { id: 'lyra', name: 'Lyra', color: '#ec4899', homeWaypointId: 'settings', active: true },
]

/** Distinct accent palette for live agents (deterministic per agent id). */
const AGENT_PALETTE = [
  '#6366f1', '#22d3ee', '#f59e0b', '#ec4899', '#10b981',
  '#a78bfa', '#38bdf8', '#fb7185', '#84cc16', '#f472b6',
]
/** An agent counts as "active" (walking) if it acted within this window. */
export const RECENT_ACTIVITY_MS = 45_000

/** The shape of one live agent from GET /api/agents (`agents[]`). */
export interface LiveAgentRecord {
  id: string
  key?: string
  channelType?: string
  status?: string
  lastActivity?: number
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * Turn a raw agent key/id into a readable nameplate. Channel-session keys look
 * like "web:67990889-5025-…-914" — unreadable on a nameplate — so we render
 * them as "Web 9914" (channel + last 4 hex of the id). Friendly keys are kept.
 */
export function prettyAgentName(record: LiveAgentRecord): string {
  const raw = record.key && record.key.trim() ? record.key.trim() : record.id
  const colon = raw.match(/^([a-z0-9_-]+):(.+)$/i)
  if (colon) {
    const channel = cap(colon[1])
    const short = colon[2].replace(/[^a-z0-9]/gi, '').slice(-4)
    return short ? `${channel} ${short}` : channel
  }
  // A bare UUID/long-id with no channel prefix → label by channelType + suffix.
  if (/^[0-9a-f-]{16,}$/i.test(raw)) {
    const short = raw.replace(/[^a-z0-9]/gi, '').slice(-4)
    return `${cap(record.channelType ?? 'Agent')} ${short}`
  }
  return raw
}

/**
 * Map Strada's live agents (GET /api/agents) onto office avatars. Names + count
 * are REAL; colour is a deterministic palette pick; each agent is seeded at a
 * distinct home waypoint (round-robin); `active` is derived from recent
 * lastActivity so active agents walk and idle ones rest. SEAM: which waypoint
 * an agent walks to (pickTargetWaypoint) is still a heuristic until Strada
 * exposes a real task→location mapping.
 */
export function mapLiveAgents(records: readonly LiveAgentRecord[], nowMs: number): OfficeAgent[] {
  return records.map((a, i) => ({
    id: a.id,
    name: prettyAgentName(a),
    color: AGENT_PALETTE[hashString(a.id) % AGENT_PALETTE.length],
    homeWaypointId: WAYPOINTS[i % WAYPOINTS.length].id,
    active:
      typeof a.lastActivity === 'number'
        ? nowMs - a.lastActivity < RECENT_ACTIVITY_MS
        : true,
  }))
}

/** One live task from the monitor store (the supervisor's real work). */
export interface LiveTaskRecord {
  id: string
  title?: string
  status?: string
  phase?: string
  agentId?: string
}

/** Task statuses that represent an agent actively working (worth an avatar). */
const IN_FLIGHT_TASK_STATUSES = new Set(['executing', 'verifying', 'pending', 'acting'])
/** Status → avatar accent colour (so the office mirrors live task state). */
const TASK_STATUS_COLOR: Record<string, string> = {
  executing: '#22c55e',
  acting: '#22c55e',
  verifying: '#f59e0b',
  pending: '#64748b',
}
const MAX_OFFICE_AGENTS = 10

/** Trim a task title to a nameplate-friendly length. */
function shortLabel(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 22 ? `${clean.slice(0, 21)}…` : clean
}

/**
 * Map the supervisor's live monitor tasks onto office avatars — THE real-work
 * wiring. Each in-flight task becomes a working agent labelled by its (short)
 * title and coloured by status; `active` (executing) agents walk, others rest.
 * Capped so a big DAG doesn't overcrowd the room.
 */
export function mapMonitorTasks(tasks: readonly LiveTaskRecord[]): OfficeAgent[] {
  return tasks
    .filter((t) => IN_FLIGHT_TASK_STATUSES.has(String(t.status ?? '')))
    .slice(0, MAX_OFFICE_AGENTS)
    .map((t, i) => ({
      id: t.id,
      name: shortLabel(t.title && t.title.trim() ? t.title : (t.agentId ?? t.id)),
      color: TASK_STATUS_COLOR[String(t.status)] ?? AGENT_PALETTE[hashString(t.id) % AGENT_PALETTE.length],
      homeWaypointId: WAYPOINTS[i % WAYPOINTS.length].id,
      active: t.status === 'executing' || t.status === 'acting',
    }))
}

/** Agent render scale (Hermes AGENT_SCALE) — tuned to this exact world SCALE. */
export const AGENT_SCALE = 1.75
/** Walk speed in canvas px / second. */
export const AGENT_SPEED_PX = 80
/** Seconds an agent dwells at a waypoint before moving on. */
export const AGENT_DWELL = 1.8

/** Deterministic string hash → unsigned int (per-agent phase offset). */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0
  return hash >>> 0
}

/** Deterministically pick the waypoint an agent heads to on a given tick.
 * SEAM: replace the round-robin with real task→location mapping later. */
export function pickTargetWaypoint(agentId: string, tickIndex: number): OfficeWaypoint {
  const offset = hashString(agentId)
  const tick = Math.max(0, Math.floor(tickIndex))
  return WAYPOINTS[(offset + tick) % WAYPOINTS.length]
}

export const ARRIVAL_EPSILON_PX = 3

/** Move a 2D (canvas-px) point toward a target at `speed` px/s over `dt` s. */
export function stepTowards(
  current: readonly [number, number],
  target: readonly [number, number],
  speed: number,
  dt: number,
): { position: [number, number]; arrived: boolean } {
  const [cx, cy] = current
  const [tx, ty] = target
  const dx = tx - cx
  const dy = ty - cy
  const dist = Math.hypot(dx, dy)
  if (dist <= ARRIVAL_EPSILON_PX) return { position: [tx, ty], arrived: true }
  const step = speed * dt
  if (!Number.isFinite(step) || step <= 0) return { position: [cx, cy], arrived: false }
  if (step >= dist) return { position: [tx, ty], arrived: true }
  const t = step / dist
  return { position: [cx + dx * t, cy + dy * t], arrived: false }
}

// ── camera (Hermes orthographic iso) ────────────────────────────────────────
/** Iso view direction (camera − target), from Hermes's district preset. */
export const CAMERA_OFFSET: readonly [number, number, number] = [14, 16, 17]
/** Look-at target = the floor centre (origin, since the floor is centred). */
export const CAMERA_TARGET: readonly [number, number, number] = [0, 0, 0]
/** Wall height in world units (short walls so the iso camera sees inside). */
export const WALL_HEIGHT = 1
