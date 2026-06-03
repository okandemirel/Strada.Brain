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

/** The 13 real admin routes, placed on WALKABLE floor across the furnished
 * office. The 8 desk-grid stations sit just in front of their cubicle (the
 * aisle seat-front), and the 5 zone stations (chat/personality/skills/settings/
 * config) on the nearest open floor of the conference / kitchen / lounge. Every
 * position is verified to land on a free nav-grid cell (officeModel.test.ts) so
 * the clickable hotspot never floats on furniture and the A* target is always
 * reachable. Kept in lock-step with office-stations.ts so the 2D list fallback
 * and the 3D hotspots navigate identically. */
export const WAYPOINTS: readonly OfficeWaypoint[] = [
  { id: 'chat', label: 'Chat', route: '/', x: 115, y: 262 },
  // desk grid, front-of-cubicle (top row y≈388, bottom row y≈588)
  { id: 'dashboard', label: 'Dashboard', route: '/admin/dashboard', x: 160, y: 388 },
  { id: 'memory', label: 'Memory', route: '/admin/memory', x: 360, y: 388 },
  { id: 'vaults', label: 'Vaults', route: '/admin/vaults', x: 560, y: 388 },
  { id: 'sessions', label: 'Sessions', route: '/admin/sessions', x: 760, y: 388 },
  { id: 'logs', label: 'Logs', route: '/admin/logs', x: 160, y: 588 },
  { id: 'tools', label: 'Tools', route: '/admin/tools', x: 360, y: 588 },
  { id: 'channels', label: 'Channels', route: '/admin/channels', x: 560, y: 588 },
  { id: 'identity', label: 'Identity', route: '/admin/identity', x: 760, y: 588 },
  // zone stations on open floor
  { id: 'personality', label: 'Personality', route: '/admin/personality', x: 862, y: 138 },
  { id: 'skills', label: 'Skills', route: '/admin/skills', x: 962, y: 412 },
  { id: 'settings', label: 'Settings', route: '/admin/settings', x: 438, y: 588 },
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

// ── navigation (Hermes A* pathfinding: buildNavGrid + astar) ─────────────────
/** Nav-grid cell size in canvas px (Hermes navigation.ts GRID_CELL). */
export const NAV_GRID_CELL = 25
export const NAV_COLS = Math.ceil(OFFICE_W / NAV_GRID_CELL)
export const NAV_ROWS = Math.ceil(OFFICE_H / NAV_GRID_CELL)

/**
 * Which furniture types block pathfinding (Hermes core/geometry ITEM_METADATA).
 * Solid floor-standing props are impassable; passable items (chairs agents sit
 * on, desk computers, elevated coffee machines, small plants/lamps) are
 * walk-through. Unknown types default to NON-blocking so a newly added
 * decorative prop never accidentally walls off the room.
 */
const ITEM_NAV_METADATA: Record<string, { blocksNavigation: boolean; navPadding?: number }> = {
  desk_cubicle: { blocksNavigation: true, navPadding: 0 }, // tight to the desk body
  executive_desk: { blocksNavigation: true },
  round_table: { blocksNavigation: true },
  table_rect: { blocksNavigation: true },
  pingpong: { blocksNavigation: true },
  couch: { blocksNavigation: true },
  couch_v: { blocksNavigation: true },
  beanbag: { blocksNavigation: true },
  bookshelf: { blocksNavigation: true },
  cabinet: { blocksNavigation: true },
  fridge: { blocksNavigation: true },
  whiteboard: { blocksNavigation: true },
  plant: { blocksNavigation: true }, // freestanding floor plant — agents detour (Hermes issue #4)
  // passable — agents walk through / sit on / reach over these:
  chair: { blocksNavigation: false },
  computer: { blocksNavigation: false },
  coffee_machine: { blocksNavigation: false }, // elevated on the counter
  lamp: { blocksNavigation: false }, // thin floor lamp — agents brush past
  water_cooler: { blocksNavigation: false },
}

const itemBlocksNavigation = (type: string): boolean =>
  ITEM_NAV_METADATA[type]?.blocksNavigation ?? false

/** Axis-aligned bounds (canvas px) of a placed item, accounting for rotation
 * (Hermes geometry.ts getItemBounds). (x,y) is the item's top-left corner. */
export function getNavItemBounds(item: FurnitureItem): { x: number; y: number; w: number; h: number } {
  const { width, height } = getItemBaseSize(item)
  const rot = getItemRotationRadians(item)
  const absCos = Math.abs(Math.cos(rot))
  const absSin = Math.abs(Math.sin(rot))
  const w = width * absCos + height * absSin
  const h = width * absSin + height * absCos
  const cx = item.x + width / 2
  const cy = item.y + height / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

export type NavGrid = Uint8Array

/** Build the occupancy grid: blocked cells (+padding) around solid furniture,
 * plus an impassable wall ring at the office border (Hermes buildNavGrid). */
export function buildNavGrid(furniture: readonly FurnitureItem[]): NavGrid {
  const grid = new Uint8Array(NAV_COLS * NAV_ROWS)
  const defaultPad = NAV_GRID_CELL * 0.6
  for (const item of furniture) {
    if (!itemBlocksNavigation(item.type)) continue
    const pad = ITEM_NAV_METADATA[item.type]?.navPadding ?? defaultPad
    const b = getNavItemBounds(item)
    const c1 = Math.max(0, Math.floor((b.x - pad) / NAV_GRID_CELL))
    const c2 = Math.min(NAV_COLS - 1, Math.floor((b.x + b.w + pad) / NAV_GRID_CELL))
    const r1 = Math.max(0, Math.floor((b.y - pad) / NAV_GRID_CELL))
    const r2 = Math.min(NAV_ROWS - 1, Math.floor((b.y + b.h + pad) / NAV_GRID_CELL))
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) grid[r * NAV_COLS + c] = 1
    }
  }
  // border wall ring
  for (let c = 0; c < NAV_COLS; c++) {
    grid[c] = 1
    grid[(NAV_ROWS - 1) * NAV_COLS + c] = 1
  }
  for (let r = 0; r < NAV_ROWS; r++) {
    grid[r * NAV_COLS] = 1
    grid[r * NAV_COLS + NAV_COLS - 1] = 1
  }
  return grid
}

/** Grid occupancy (1 = blocked, 0 = free) at a canvas-px point (clamped). */
export function navCellAt(grid: NavGrid, x: number, y: number): number {
  const c = Math.min(NAV_COLS - 1, Math.max(0, Math.floor(x / NAV_GRID_CELL)))
  const r = Math.min(NAV_ROWS - 1, Math.max(0, Math.floor(y / NAV_GRID_CELL)))
  return grid[r * NAV_COLS + c]
}

/** A* over the occupancy grid (Hermes navigation.ts astar): octile moves, a
 * binary-heap open list, corner-cut prevention on diagonals, and a findFree
 * fallback that relocates a blocked start/end onto the nearest open cell.
 * Returns canvas-px nodes (last node snapped to the exact target), or [] when
 * no route exists. */
function astar(sx: number, sy: number, ex: number, ey: number, grid: NavGrid): { x: number; y: number }[] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const toCell = (x: number, y: number) => ({
    c: clamp(Math.floor(x / NAV_GRID_CELL), 0, NAV_COLS - 1),
    r: clamp(Math.floor(y / NAV_GRID_CELL), 0, NAV_ROWS - 1),
  })
  const cellCx = (c: number) => c * NAV_GRID_CELL + NAV_GRID_CELL / 2
  const cellCy = (r: number) => r * NAV_GRID_CELL + NAV_GRID_CELL / 2

  const findFree = (col: number, row: number) => {
    if (!grid[row * NAV_COLS + col]) return { c: col, r: row }
    for (let d = 1; d < 10; d++) {
      for (let ro = -d; ro <= d; ro++) {
        for (let co = -d; co <= d; co++) {
          if (Math.abs(ro) !== d && Math.abs(co) !== d) continue
          const nr = row + ro
          const nc = col + co
          if (nr < 0 || nr >= NAV_ROWS || nc < 0 || nc >= NAV_COLS) continue
          if (!grid[nr * NAV_COLS + nc]) return { c: nc, r: nr }
        }
      }
    }
    return null
  }

  let { c: sc, r: sr } = toCell(sx, sy)
  let { c: ec, r: er } = toCell(ex, ey)
  const startFree = findFree(sc, sr)
  const endFree = findFree(ec, er)
  if (!startFree || !endFree) return []
  sc = startFree.c
  sr = startFree.r
  ec = endFree.c
  er = endFree.r
  if (sc === ec && sr === er) return [{ x: ex, y: ey }]

  const nodeCount = NAV_COLS * NAV_ROWS
  const gCost = new Float32Array(nodeCount).fill(Infinity)
  const parent = new Int32Array(nodeCount).fill(-1)
  const visited = new Uint8Array(nodeCount)
  const startIndex = sr * NAV_COLS + sc
  const endIndex = er * NAV_COLS + ec
  gCost[startIndex] = 0

  const open: [number, number][] = []
  const pushOpen = (entry: [number, number]) => {
    open.push(entry)
    let index = open.length - 1
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      if (open[parentIndex][1] <= entry[1]) break
      open[index] = open[parentIndex]
      index = parentIndex
    }
    open[index] = entry
  }
  const popOpen = (): [number, number] | null => {
    if (open.length === 0) return null
    const first = open[0]
    const last = open.pop()
    if (!last || open.length === 0) return first
    let index = 0
    while (true) {
      const leftIndex = index * 2 + 1
      const rightIndex = leftIndex + 1
      if (leftIndex >= open.length) break
      let smallestIndex = leftIndex
      if (rightIndex < open.length && open[rightIndex][1] < open[leftIndex][1]) {
        smallestIndex = rightIndex
      }
      if (open[smallestIndex][1] >= last[1]) break
      open[index] = open[smallestIndex]
      index = smallestIndex
    }
    open[index] = last
    return first
  }

  pushOpen([startIndex, Math.hypot(ec - sc, er - sr)])
  const directions: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
  ]

  while (open.length) {
    const next = popOpen()
    if (!next) break
    const [current] = next
    if (visited[current]) continue
    visited[current] = 1

    if (current === endIndex) {
      const path: { x: number; y: number }[] = []
      let node = current
      while (node !== startIndex) {
        path.push({ x: cellCx(node % NAV_COLS), y: cellCy(Math.floor(node / NAV_COLS)) })
        node = parent[node]
      }
      path.reverse()
      if (path.length) path[path.length - 1] = { x: ex, y: ey }
      else path.push({ x: ex, y: ey })
      return path
    }

    const currentColumn = current % NAV_COLS
    const currentRow = Math.floor(current / NAV_COLS)
    for (const [columnOffset, rowOffset, cost] of directions) {
      const nextColumn = currentColumn + columnOffset
      const nextRow = currentRow + rowOffset
      if (nextColumn < 0 || nextColumn >= NAV_COLS || nextRow < 0 || nextRow >= NAV_ROWS) continue
      const nextIndex = nextRow * NAV_COLS + nextColumn
      if (visited[nextIndex] || grid[nextIndex]) continue
      // Diagonal moves require both orthogonal neighbours free (no corner-clipping).
      if (columnOffset !== 0 && rowOffset !== 0) {
        const orthogonalA = (currentRow + rowOffset) * NAV_COLS + currentColumn
        const orthogonalB = currentRow * NAV_COLS + (currentColumn + columnOffset)
        if (grid[orthogonalA] || grid[orthogonalB]) continue
      }
      const nextCost = gCost[current] + cost
      if (nextCost < gCost[nextIndex]) {
        gCost[nextIndex] = nextCost
        parent[nextIndex] = current
        pushOpen([nextIndex, nextCost + Math.hypot(ec - nextColumn, er - nextRow)])
      }
    }
  }

  return []
}

/**
 * Plan a walkable route (canvas-px nodes) from `start` to `end` around the
 * furniture. The last node is always the exact `end` pixel. If A* finds no
 * route the path degrades to a single direct segment so the agent still
 * advances (and never freezes) instead of standing still.
 */
export function findPath(
  start: readonly [number, number],
  end: readonly [number, number],
  grid: NavGrid,
): [number, number][] {
  const raw = astar(start[0], start[1], end[0], end[1], grid)
  if (raw.length === 0) return [[end[0], end[1]]]
  return raw.map((p) => [p.x, p.y] as [number, number])
}

/** The office occupancy grid, built once from the static FURNITURE layout and
 * shared by the scene's walking agents (and asserted in unit tests). */
export const NAV_GRID: NavGrid = buildNavGrid(FURNITURE)

// ── walk state machine (A* path following; pure + ref-held in the scene) ─────
/** One agent's mutable walk state. `path` is the remaining A* route to the
 * current destination (canvas px; the last node is the destination). */
export interface WalkState {
  position: [number, number]
  path: [number, number][]
  tickIndex: number
  dwell: number
}

/** Resolve an agent's home waypoint (falls back to the first station). */
function homeWaypoint(agent: OfficeAgent): OfficeWaypoint {
  return WAYPOINTS.find((w) => w.id === agent.homeWaypointId) ?? WAYPOINTS[0]
}

/** Seed an agent at its home. Active agents get an A* path to their first
 * station; idle agents stand still (empty path). */
export function seedWalkState(agent: OfficeAgent, grid: NavGrid): WalkState {
  const home = homeWaypoint(agent)
  const state: WalkState = { position: [home.x, home.y], path: [], tickIndex: 0, dwell: 0 }
  if (agent.active ?? true) {
    const first = pickTargetWaypoint(agent.id, 0)
    state.path = findPath(state.position, [first.x, first.y], grid)
  }
  return state
}

/**
 * Advance one agent's walk by `dt` seconds, MUTATING `state` in place (it is
 * held in a render-free ref). Active agents step along their A* path one node
 * at a time, routing around furniture; on reaching the destination they dwell,
 * then re-plan a route to the next round-robin station. Idle agents rest.
 * Returns whether the agent is moving and the immediate heading node (for
 * facing). Pure w.r.t. the grid/agent — only `state` changes.
 */
export function advanceWalk(
  state: WalkState,
  agent: OfficeAgent,
  grid: NavGrid,
  dt: number,
): { moving: boolean; heading: [number, number] | null } {
  if (!(agent.active ?? true)) {
    state.path = []
    return { moving: false, heading: null }
  }
  if (state.dwell > 0) {
    state.dwell = Math.max(0, state.dwell - dt)
    return { moving: false, heading: null }
  }
  if (state.path.length === 0) {
    // arrived at (or seeded without) a destination: dwell, then plan the next leg.
    state.tickIndex += 1
    const dest = pickTargetWaypoint(agent.id, state.tickIndex)
    state.path = findPath(state.position, [dest.x, dest.y], grid)
    state.dwell = AGENT_DWELL
    return { moving: false, heading: null }
  }
  const node = state.path[0]
  const { position, arrived } = stepTowards(state.position, node, AGENT_SPEED_PX, dt)
  state.position = position
  if (arrived) state.path = state.path.slice(1)
  return { moving: true, heading: node }
}

// ── camera (Hermes orthographic iso) ────────────────────────────────────────
/** Iso view direction (camera − target), from Hermes's district preset. */
export const CAMERA_OFFSET: readonly [number, number, number] = [14, 16, 17]
/** Look-at target = the floor centre (origin, since the floor is centred). */
export const CAMERA_TARGET: readonly [number, number, number] = [0, 0, 0]
/** Wall height in world units (short walls so the iso camera sees inside). */
export const WALL_HEIGHT = 1
