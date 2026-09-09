import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '../i18n'
import type { BuildStatus } from '../types/build-status'
import { useCampaignStore, pickFreshest } from '../stores/campaign-store'
import { dispatchWorkspaceMessage, isWorkspaceMessage } from '../hooks/use-dashboard-socket'

const useCampaignStatus = vi.fn()
vi.mock('../hooks/use-api', () => ({ useCampaignStatus: () => useCampaignStatus() }))
const fetchJson = vi.fn()
vi.mock('../utils/api', () => ({ fetchJson: (...args: unknown[]) => fetchJson(...args) }))

import CampaignCard from './CampaignCard'
import { formatDurationShort } from '../utils/format'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function status(overrides: Partial<BuildStatus> = {}): BuildStatus {
  return {
    generatedAt: new Date(NOW - 5_000).toISOString(),
    projectRoot: '/proj',
    campaign: {
      id: 'camp_1',
      chatId: 'c',
      channelType: 'web',
      state: 'executing',
      projectRoot: '/proj',
      gddPath: 'docs/GDD.md',
      createdAt: NOW - 5 * HOUR,
      updatedAt: NOW - 10 * 60_000,
      currentMilestone: 1,
      milestones: [
        { id: 'm1', title: 'Foundations', status: 'green', attempts: 1, maxAttempts: 2, timeBoxEscalations: 0, structureRefused: false },
        {
          id: 'm2',
          title: 'Core loop',
          status: 'running',
          attempts: 1,
          maxAttempts: 2,
          startedAtMs: NOW - 2 * HOUR,
          timeBoxEscalations: 1,
          compileVerdict: { ok: false, ran: true, errors: 3 },
          placeholderArtAtStart: { sprites: 519, placeholders: 394 },
          structureRefused: false,
        },
        { id: 'm3', title: 'Polish', status: 'pending', attempts: 0, maxAttempts: 2, timeBoxEscalations: 0, structureRefused: false },
      ],
      milestoneTimeBoxMs: 6 * HOUR,
      deliveryReported: false,
      revivable: false,
      currentTask: { id: 'task_9', title: 'T', status: 'executing', createdAt: NOW - HOUR, updatedAt: NOW, lastProgress: 'editing PlayerController.cs', lastProgressAt: NOW - 3 * 60_000 },
      activeTasks: [{ id: 'task_12', title: 'M', status: 'executing', createdAt: NOW - 30 * 60_000, updatedAt: NOW, lastProgress: 'placeholder mission node 3' }],
    },
    guardian: {
      projectRoot: '/proj',
      lastVerdict: 'red',
      lastCheckedAt: NOW - 4 * 60_000,
      lastErrorCount: 3,
      lastDetail: 'error CS0246: missing Foo',
      fixTaskId: 'task_fix',
      fixTaskStartedAt: NOW - 9 * 60_000,
      fixAttempts: 2,
      maxFixAttempts: 3,
      attemptsWithoutProgress: 0,
      escalated: false,
      blindStreak: 0,
      nextVerifyAt: 0,
    },
    measurement: null,
    ...overrides,
  }
}

describe('CampaignCard', () => {
  beforeEach(() => {
    useCampaignStore.getState().reset()
    useCampaignStatus.mockReset()
    fetchJson.mockReset()
  })

  it('renders the measured campaign: milestones with attempts, time box, compile errors, current task, guardian', () => {
    useCampaignStatus.mockReturnValue({ data: status(), isError: false })
    render(<CampaignCard now={NOW} />)
    expect(screen.getByTestId('campaign-state').textContent).toBe('executing')
    expect(screen.getByText('1/3 green')).toBeTruthy()
    const m2 = screen.getByTestId('milestone-m2')
    expect(m2.textContent).toContain('attempt 1/2')
    expect(m2.textContent).toContain('2h 0m of 6h 0m time box')
    expect(m2.textContent).toContain('compile RED (3 errors)')
    expect(m2.textContent).toContain('placeholder sprites at start 394/519')
    expect(m2.textContent).toContain('1 scope narrowing(s)')
    expect(screen.getByTestId('current-task').textContent).toContain('task_9')
    expect(screen.getByTestId('current-task').textContent).toContain('Last progress 3m ago: editing PlayerController.cs')
    expect(screen.getByText(/task_12/).closest('li')?.textContent).toContain('placeholder mission node 3')
    const guardian = screen.getByTestId('guardian-line').textContent ?? ''
    expect(guardian).toContain('tree does not compile')
    expect(guardian).toContain('verified 4m ago')
    expect(guardian).toContain('3 errors')
    expect(guardian).toContain('fix task task_fix running 9m (2/3)')
  })

  it('says there is no campaign instead of rendering an empty ladder', () => {
    useCampaignStatus.mockReturnValue({ data: status({ campaign: null, guardian: null }), isError: false })
    render(<CampaignCard now={NOW} />)
    expect(screen.getByText(/No campaign for this project yet/)).toBeTruthy()
    expect(screen.queryByTestId('campaign-state')).toBeNull()
  })

  it('shows the daemon error when the status cannot be fetched', () => {
    useCampaignStatus.mockReturnValue({ data: undefined, isError: true, error: new Error('503 no campaign layer') })
    render(<CampaignCard now={NOW} />)
    expect(screen.getByText(/Build status unavailable: 503 no campaign layer/)).toBeTruthy()
  })

  it('prefers the fresher of the pushed frame and the polled response', () => {
    const polled = status({ generatedAt: new Date(NOW - 60_000).toISOString() })
    const pushedStatus = status({ generatedAt: new Date(NOW).toISOString() })
    pushedStatus.campaign!.state = 'done'
    expect(pickFreshest(pushedStatus, polled)).toBe(pushedStatus)
    expect(pickFreshest(polled, pushedStatus)).toBe(pushedStatus)
    expect(pickFreshest(null, polled)).toBe(polled)

    useCampaignStatus.mockReturnValue({ data: polled, isError: false })
    expect(isWorkspaceMessage('campaign:status')).toBe(true)
    dispatchWorkspaceMessage({ type: 'campaign:status', payload: pushedStatus })
    render(<CampaignCard now={NOW} />)
    expect(screen.getByTestId('campaign-state').textContent).toBe('done')
  })

  it('"Measure now" fetches ?measure=1 and renders the gate counts verbatim', async () => {
    useCampaignStatus.mockReturnValue({ data: status(), isError: false })
    fetchJson.mockResolvedValue(
      status({
        measurement: {
          measuredAt: new Date(NOW).toISOString(),
          measured: true,
          refusal: 'the shipped scene renders 0 project sprites',
          shippedScenes: ['Assets/Scenes/Main.unity', 'Assets/Scenes/Menu.unity'],
          shippedRenderers: 27,
          shippedWorldRenderers: 20,
          shippedSpriteRenderers: 22,
          shippedMeshRenderers: 5,
          artInventory: { prefabs: 31, models: 0, sprites: 519, placeholderSprites: 394, audio: 29, duplicateAudio: 4, shortAudio: 19 },
          boundPlaceholderSprites: 12,
          unbound: { prefabs: 2, models: 0, sprites: 7 },
          primitiveCallSites: 0,
          incomplete: [],
        },
      }),
    )
    render(<CampaignCard now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Measure now' }))
    await waitFor(() => expect(screen.getByTestId('measurement')).toBeTruthy())
    expect(fetchJson).toHaveBeenCalledWith('/api/campaign?measure=1')
    const block = screen.getByTestId('measurement').textContent ?? ''
    expect(block).toContain('Structural refusal: the shipped scene renders 0 project sprites')
    expect(block).toContain('394')
    expect(block).toContain('of 519 sprites · 12 bound in shipped scenes')
    expect(block).toContain('20 world · 22 sprite · 5 mesh')
    expect(block).toContain('2 prefabs · 0 models · 7 sprites')
    expect(block).toContain('19 short · 4 duplicate')
  })

  it('reports a measurement failure instead of stale numbers', async () => {
    useCampaignStatus.mockReturnValue({ data: status(), isError: false })
    fetchJson.mockRejectedValue(new Error('500 EACCES'))
    render(<CampaignCard now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'Measure now' }))
    await waitFor(() => expect(screen.getByText(/Measurement failed: 500 EACCES/)).toBeTruthy())
    expect(screen.queryByTestId('measurement')).toBeNull()
  })

  it('formatDurationShort rounds down to minutes, hours, days', () => {
    expect(formatDurationShort(59_000)).toBe('0m')
    expect(formatDurationShort(HOUR + 5 * 60_000)).toBe('1h 5m')
    expect(formatDurationShort(26 * HOUR)).toBe('1d 2h')
  })
})
