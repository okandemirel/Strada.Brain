import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../i18n'
import DeliveryPackagePanel from './DeliveryPackagePanel'
import type { DeliveryPackage, DeliveryPackageView } from '../types/build-status'

const NOW = 1_800_000_000_000

function pkg(overrides: Partial<DeliveryPackage> = {}): DeliveryPackage {
  return {
    schemaVersion: 1,
    campaignId: 'camp_1',
    taskId: 'task_9',
    title: 'Sprint D — Delivery',
    projectRoot: '/proj',
    campaignState: 'done',
    assembledAt: NOW - 60_000,
    pieces: [
      {
        id: 'diff',
        title: 'The change',
        state: 'present',
        summary: '3 commits, 12 files.',
        source: "the delivering sprint's own commits",
        locators: [{ kind: 'command', label: 'show the diff', value: 'git -C /proj diff --stat abc~1..def' }],
        lines: ['abc123456789 the change itself'],
        missing: ['lines added/removed'],
      },
      {
        id: 'playthrough',
        title: 'The play-through',
        state: 'not-measured',
        summary: 'NOT MEASURED — nobody played the game at the delivery gate.',
        source: 'the delivering sprint recorded no playthrough',
        missing: ['the recording file'],
      },
      {
        id: 'checklist',
        title: 'What was asked for',
        state: 'present',
        summary: '2 lines: 1 met, 1 open.',
        source: 'the milestone ladder',
        items: [
          { text: 'Pigs must flee', state: 'open', source: 'sprint m3', cause: 'the sprint ended failed' },
          { text: 'at least 60 fps: MET — 61.2 fps', state: 'met', source: 'the GDD claim check' },
        ],
        itemsOmitted: 4,
      },
    ],
    falseGreens: [{ claim: 'Sprint C landed green', rootCause: 'compile NOT measured — no Unity', source: 'sprint m3' }],
    receipts: [],
    receiptsNote: 'No producer dispatch was recorded for this sprint.',
    completeness: { of: 7, present: 4, failed: 1, missing: 1, notMeasured: 1 },
    ...overrides,
  }
}

function view(overrides: Partial<DeliveryPackageView> = {}): DeliveryPackageView {
  const latest = pkg()
  return {
    latest,
    latestRevision: 3,
    latestStoredAt: NOW - 120_000,
    index: [
      { campaignId: 'camp_1', title: latest.title, revision: 3, storedAt: NOW - 120_000, campaignState: 'done', completeness: latest.completeness },
    ],
    ...overrides,
  }
}

describe('DeliveryPackagePanel', () => {
  it('renders the package the server gave it: pieces, locators, checklist and the revision', () => {
    render(<DeliveryPackagePanel view={view()} now={NOW} />)
    expect(screen.getByTestId('delivery-package')).toBeTruthy()
    expect(screen.getByTestId('delivery-package-completeness').textContent).toBe(
      '4 of 7 pieces present · 1 failed · 1 missing · 1 never measured',
    )
    expect(screen.getByText(/revision 3, stored 2m ago/)).toBeTruthy()
    const diff = screen.getByTestId('package-piece-diff').textContent ?? ''
    expect(diff).toContain('3 commits, 12 files.')
    expect(diff).toContain('git -C /proj diff --stat abc~1..def')
    expect(diff).toContain('abc123456789 the change itself')
    const checklist = screen.getByTestId('package-piece-checklist').textContent ?? ''
    expect(checklist).toContain('Pigs must flee')
    expect(checklist).toContain('the sprint ended failed')
    expect(checklist).toContain('+4 more not listed here')
  })

  it('renders an unmeasured piece AS unmeasured instead of leaving the section blank', () => {
    render(<DeliveryPackagePanel view={view()} now={NOW} />)
    const play = screen.getByTestId('package-piece-playthrough')
    expect(play.textContent).toContain('NOT MEASURED — nobody played the game')
    // The named gaps inside a piece are rendered, not hidden.
    expect(play.textContent).toContain('NOT MEASURED: the recording file')
    expect(screen.getByTestId('package-piece-diff').textContent).toContain('NOT MEASURED: lines added/removed')
    expect(screen.getAllByTestId('package-piece-missing').length).toBeGreaterThan(1)
  })

  it('shows every false green with its root cause', () => {
    render(<DeliveryPackagePanel view={view()} now={NOW} />)
    const greens = screen.getByTestId('delivery-package-false-greens').textContent ?? ''
    expect(greens).toContain('Sprint C landed green')
    expect(greens).toContain('compile NOT measured — no Unity')
    expect(greens).toContain('sprint m3')
  })

  it('says a delivery rests on NO dispatch rather than rendering an empty receipt list', () => {
    render(<DeliveryPackagePanel view={view()} now={NOW} />)
    expect(screen.getByTestId('delivery-package-no-receipts').textContent).toContain('No producer dispatch was recorded')
  })

  it('says WHY there is no package instead of rendering nothing', () => {
    render(<DeliveryPackagePanel view={{ latest: null, index: [], note: 'no delivery has been packaged on this machine yet' }} now={NOW} />)
    expect(screen.getByTestId('delivery-package-none').textContent).toBe(
      'No delivery package: no delivery has been packaged on this machine yet',
    )
    expect(screen.queryByTestId('delivery-package-completeness')).toBeNull()
  })

  it('does not go silent when the store gave no reason either', () => {
    render(<DeliveryPackagePanel view={{ latest: null, index: [] }} now={NOW} />)
    expect(screen.getByTestId('delivery-package-none').textContent).toContain('no reason was recorded')
  })
})
