/**
 * Office stations — the single source of truth that maps each clickable
 * object in the 3D virtual office (and each card in the 2D fallback) to a
 * real admin route in the portal.
 *
 * Routes MUST stay in sync with the <Route> tree in src/App.tsx. The
 * office-stations.test.ts unit test asserts that every `route` below is one
 * of the app's real routes, so a drift in App.tsx will fail CI.
 */
export interface OfficeStation {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly route: string
  readonly emoji: string
  readonly color: string
  readonly position: readonly [number, number, number]
}

/**
 * 13 stations laid out as a ring of desks/objects around the room floor
 * (y = 0.5 so meshes sit on the floor). Each has a distinct position, a
 * sensible emoji and a distinct accent colour for hover/fallback styling.
 */
export const OFFICE_STATIONS: readonly OfficeStation[] = [
  {
    id: 'chat',
    label: 'Chat',
    description: 'Talk to the assistant',
    route: '/',
    emoji: '\u{1F4AC}',
    color: '#6366f1',
    position: [0, 0.5, 4],
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'System overview & metrics',
    route: '/admin/dashboard',
    emoji: '\u{1F4CA}',
    color: '#22d3ee',
    position: [3, 0.5, 3.2],
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Memory tiers & consolidation',
    route: '/admin/memory',
    emoji: '\u{1F9E0}',
    color: '#a855f7',
    position: [5, 0.5, 1],
  },
  {
    id: 'vaults',
    label: 'Vaults',
    description: 'Knowledge vaults & graphs',
    route: '/admin/vaults',
    emoji: '\u{1F5C4}\u{FE0F}',
    color: '#f59e0b',
    position: [5.5, 0.5, -1.5],
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Active & past sessions',
    route: '/admin/sessions',
    emoji: '\u{1F5C2}\u{FE0F}',
    color: '#10b981',
    position: [4.5, 0.5, -3.5],
  },
  {
    id: 'logs',
    label: 'Logs',
    description: 'Live system logs',
    route: '/admin/logs',
    emoji: '\u{1F4DC}',
    color: '#84cc16',
    position: [2.5, 0.5, -5],
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Tool registry & metrics',
    route: '/admin/tools',
    emoji: '\u{1F6E0}\u{FE0F}',
    color: '#f97316',
    position: [0, 0.5, -5.5],
  },
  {
    id: 'channels',
    label: 'Channels',
    description: 'Connected channels',
    route: '/admin/channels',
    emoji: '\u{1F4E1}',
    color: '#06b6d4',
    position: [-2.5, 0.5, -5],
  },
  {
    id: 'identity',
    label: 'Identity',
    description: 'Assistant identity',
    route: '/admin/identity',
    emoji: '\u{1F464}',
    color: '#ec4899',
    position: [-4.5, 0.5, -3.5],
  },
  {
    id: 'personality',
    label: 'Personality',
    description: 'Tone & behaviour',
    route: '/admin/personality',
    emoji: '\u{1F3AD}',
    color: '#d946ef',
    position: [-5.5, 0.5, -1.5],
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Installed skills',
    route: '/admin/skills',
    emoji: '\u{1F9E9}',
    color: '#14b8a6',
    position: [-5, 0.5, 1],
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Portal settings',
    route: '/admin/settings',
    emoji: '\u{2699}\u{FE0F}',
    color: '#64748b',
    position: [-3, 0.5, 3.2],
  },
  {
    id: 'config',
    label: 'Config',
    description: 'Advanced configuration',
    route: '/admin/config',
    emoji: '\u{1F5C3}\u{FE0F}',
    color: '#0ea5e9',
    position: [-1.5, 0.5, 4.5],
  },
]
