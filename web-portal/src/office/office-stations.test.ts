import { describe, it, expect } from 'vitest'
import { OFFICE_STATIONS } from './office-stations'

/**
 * The real, navigable app routes — kept in sync with the <Route> tree in
 * src/App.tsx. Every office station must point at one of these.
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

describe('OFFICE_STATIONS', () => {
  it('contains exactly 13 stations', () => {
    expect(OFFICE_STATIONS).toHaveLength(13)
  })

  it('has unique ids', () => {
    const ids = OFFICE_STATIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has unique routes', () => {
    const routes = OFFICE_STATIONS.map((s) => s.route)
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('has non-empty labels, descriptions and emojis', () => {
    for (const station of OFFICE_STATIONS) {
      expect(station.label.trim().length).toBeGreaterThan(0)
      expect(station.description.trim().length).toBeGreaterThan(0)
      expect(station.emoji.trim().length).toBeGreaterThan(0)
    }
  })

  it('maps every station to a real app route', () => {
    for (const station of OFFICE_STATIONS) {
      expect(REAL_APP_ROUTES).toContain(station.route)
    }
  })

  it('covers every real app route', () => {
    const routes = new Set(OFFICE_STATIONS.map((s) => s.route))
    for (const route of REAL_APP_ROUTES) {
      expect(routes).toContain(route)
    }
  })

  it('uses a valid hex color for each station', () => {
    for (const station of OFFICE_STATIONS) {
      expect(station.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('gives each station a distinct 3D position', () => {
    const positions = OFFICE_STATIONS.map((s) => s.position.join(','))
    expect(new Set(positions).size).toBe(positions.length)
    for (const station of OFFICE_STATIONS) {
      expect(station.position).toHaveLength(3)
      for (const axis of station.position) {
        expect(Number.isFinite(axis)).toBe(true)
      }
    }
  })
})
