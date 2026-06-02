/**
 * Office layout — the PURE data that describes the furnished isometric office:
 * what furniture sits where, the named task spots ("waypoints") agents walk
 * between, and the room shell (floor + walls).
 *
 * This module is intentionally three.js-free so it unit-tests in jsdom. The
 * scene (OfficeScene.tsx) consumes it: it renders each {@link FurniturePlacement}
 * as a real GLB when `officeModelUrl(modelId)` resolves (see office-assets.ts)
 * and as a labeled low-poly PRIMITIVE otherwise, frames the space from
 * {@link ROOM}, and turns each {@link OfficeWaypoint} into a subtle clickable
 * hotspot that navigates to its admin `route`.
 *
 * Coordinates are world-space [x, y, z]; y is up. The floor sits at y = 0 and
 * spans ROOM.size on each axis (so it runs from -size/2 to +size/2). Furniture
 * y values place a prop's base on or just above the floor.
 */

/** A single placed furniture prop. `modelId` keys into office-assets.ts. */
export interface FurniturePlacement {
  /** Model id the scene looks up (e.g. 'desk'); falls back to a primitive. */
  modelId: string
  /** World position [x, y, z]; y is up, floor at y = 0. */
  position: readonly [number, number, number]
  /** Optional yaw rotation in radians (default 0). */
  rotationY?: number
  /** Optional uniform scale multiplier (default 1). */
  scale?: number
}

/** A named spot an agent walks to; clicking it navigates to `route`. */
export interface OfficeWaypoint {
  /** Stable unique id. */
  id: string
  /** Human label shown on the hotspot. */
  label: string
  /** Admin route to navigate to on click — one of the 13 real app routes. */
  route: string
  /** World position [x, y, z] the agent walks to (floor-level). */
  position: readonly [number, number, number]
}

/** Room shell dimensions consumed by the scene to build floor + walls. */
export const ROOM: { size: number; wallHeight: number } = {
  size: 16,
  wallHeight: 4,
}

const HALF = ROOM.size / 2

/**
 * A believable furnished open office plus one meeting room (the back-left
 * corner, framed by a couch + bookshelf around a meeting table).
 *
 * The open floor holds four workstation clusters of desk + chair + monitor,
 * softened with plants and a central rug. Every `modelId` is one of the known
 * furniture ids the scene + asset manifest agree on:
 *   'desk','chair','table','couch','plant','bookshelf','monitor','rug'.
 */
export const FURNITURE: readonly FurniturePlacement[] = [
  // --- Central rug anchoring the open-plan area ---
  { modelId: 'rug', position: [0, 0.01, 1], scale: 1.4 },

  // --- Workstation cluster 1 (front-right): desk faces -z ---
  { modelId: 'desk', position: [3.2, 0, 3], rotationY: Math.PI },
  { modelId: 'chair', position: [3.2, 0, 4], rotationY: 0 },
  { modelId: 'monitor', position: [3.2, 0.75, 2.7], rotationY: Math.PI },

  // --- Workstation cluster 2 (right): desk faces -x ---
  { modelId: 'desk', position: [5, 0, 0.5], rotationY: -Math.PI / 2 },
  { modelId: 'chair', position: [6, 0, 0.5], rotationY: Math.PI / 2 },
  { modelId: 'monitor', position: [4.7, 0.75, 0.5], rotationY: -Math.PI / 2 },

  // --- Workstation cluster 3 (front-left): desk faces -z ---
  { modelId: 'desk', position: [-3.2, 0, 3], rotationY: Math.PI },
  { modelId: 'chair', position: [-3.2, 0, 4], rotationY: 0 },
  { modelId: 'monitor', position: [-3.2, 0.75, 2.7], rotationY: Math.PI },

  // --- Workstation cluster 4 (left): desk faces +x ---
  { modelId: 'desk', position: [-5, 0, 0.5], rotationY: Math.PI / 2 },
  { modelId: 'chair', position: [-6, 0, 0.5], rotationY: -Math.PI / 2 },
  { modelId: 'monitor', position: [-4.7, 0.75, 0.5], rotationY: Math.PI / 2 },

  // --- Meeting room (back-left corner): table + couch + bookshelf ---
  { modelId: 'table', position: [-4, 0, -4], scale: 1.2 },
  { modelId: 'chair', position: [-4, 0, -2.8], rotationY: 0 },
  { modelId: 'chair', position: [-4, 0, -5.2], rotationY: Math.PI },
  { modelId: 'chair', position: [-2.8, 0, -4], rotationY: -Math.PI / 2 },
  { modelId: 'couch', position: [-5.8, 0, -4], rotationY: Math.PI / 2 },
  { modelId: 'bookshelf', position: [-HALF + 0.4, 0, -HALF + 0.4], rotationY: Math.PI / 4 },

  // --- Greenery in the corners / along the walls ---
  { modelId: 'plant', position: [HALF - 0.8, 0, -HALF + 0.8] },
  { modelId: 'plant', position: [HALF - 0.8, 0, HALF - 0.8] },
  { modelId: 'plant', position: [-HALF + 0.8, 0, HALF - 0.8] },
  { modelId: 'plant', position: [0, 0, -HALF + 0.8] },
]

/**
 * The named task spots agents walk to. Each maps to one of the 13 real admin
 * routes (kept in lock-step with office-stations.ts so a click on a waypoint
 * still navigates exactly where the 2D fallback / station mesh would). Their
 * floor positions are spread across the room so walking agents trace believable
 * paths between desks and the meeting room.
 *
 * The route set is the single source of truth shared with office-stations.ts;
 * office-layout.test.ts asserts every route here is a real app route.
 */
export const WAYPOINTS: readonly OfficeWaypoint[] = [
  { id: 'chat', label: 'Chat', route: '/', position: [0, 0, 4] },
  { id: 'dashboard', label: 'Dashboard', route: '/admin/dashboard', position: [3.2, 0, 3] },
  { id: 'memory', label: 'Memory', route: '/admin/memory', position: [5, 0, 0.5] },
  { id: 'vaults', label: 'Vaults', route: '/admin/vaults', position: [5.5, 0, -1.5] },
  { id: 'sessions', label: 'Sessions', route: '/admin/sessions', position: [4.5, 0, -3.5] },
  { id: 'logs', label: 'Logs', route: '/admin/logs', position: [2.5, 0, -5] },
  { id: 'tools', label: 'Tools', route: '/admin/tools', position: [0, 0, -5.5] },
  { id: 'channels', label: 'Channels', route: '/admin/channels', position: [-2.5, 0, -5] },
  { id: 'identity', label: 'Identity', route: '/admin/identity', position: [-4, 0, -4] },
  { id: 'personality', label: 'Personality', route: '/admin/personality', position: [-5.5, 0, -1.5] },
  { id: 'skills', label: 'Skills', route: '/admin/skills', position: [-5, 0, 0.5] },
  { id: 'settings', label: 'Settings', route: '/admin/settings', position: [-3.2, 0, 3] },
  { id: 'config', label: 'Config', route: '/admin/config', position: [-1.5, 0, 4.5] },
]
