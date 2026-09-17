/**
 * The portal side of round 11 #20: decisions actually leave the browser.
 *
 * What was wrong is not visible in a store assertion — the store was fine on its
 * own terms. The defect was that NOTHING called it: no fetch supplied a review
 * id, no request carried a decision, and a rejection was presented as done while
 * the run's bytes were still in the project. So these tests assert on the
 * REQUEST (its URL, method and body) and on the rule that only a server
 * acknowledgement may dismiss a diff.
 *
 * The file on disk is proven in src/dashboard/change-review-routes.test.ts,
 * which drives the route this hook posts to against a real project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useChangeReview } from './use-change-review'
import { useCodeStore } from '../stores/code-store'

const REVIEW_ID = '9f3a1c2d'

const serverPreview = {
  reviewId: REVIEW_ID,
  createdAt: 1_700_000_000_000,
  entries: [{ path: 'Assets/Scripts/Existing.cs', action: 'restore', state: 'ready' }],
  history: { commits: 2 },
  complete: true,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

function openDiff(path: string) {
  useCodeStore.getState().openFile({
    path,
    content: "the run's version",
    language: 'csharp',
    isDiff: true,
    diffContent: '--- a\n+++ b',
    originalContent: "the user's version",
    modifiedContent: "the run's version",
  })
}

/** Requests the hook made, in order. */
function calls(): Array<{ url: string; method: string; body: unknown }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: (init as RequestInit | undefined)?.body
      ? (JSON.parse(String((init as RequestInit).body)) as unknown)
      : undefined,
  }))
}

beforeEach(() => {
  useCodeStore.getState().reset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useChangeReview — the review reaches the store', () => {
  it('fetches the published review and supplies its id, which nothing did before', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { review: serverPreview }))

    const { result } = renderHook(() => useChangeReview())

    await waitFor(() => expect(result.current.review).not.toBeNull())
    expect(calls()[0]).toMatchObject({ url: '/api/workspace/change-review', method: 'GET' })
    expect(result.current.review!.reviewId).toBe(REVIEW_ID)
    expect(result.current.review!.historyCommits).toBe(2)
    expect(useCodeStore.getState().review!.entries[0].path).toBe('Assets/Scripts/Existing.cs')
  })

  it('a project with nothing to review leaves the store empty and says nothing is wrong', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { review: null }))
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(result.current.review).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('a daemon that cannot be reached is reported, not swallowed', async () => {
    fetchMock.mockRejectedValue(new Error('Network request failed'))
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.error).toBe('Network request failed'))
  })
})

describe('useChangeReview — a rejection reaches the daemon', () => {
  it('posts the decision to the review it belongs to', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse(200, {
            reviewId: REVIEW_ID,
            outcome: 'undone',
            applied: ['Assets/Scripts/Existing.cs'],
            kept: [],
            failed: [],
            leftOver: [],
            review: { ...serverPreview, entries: [], complete: true },
          })
        : jsonResponse(200, { review: serverPreview }),
    )
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.review).not.toBeNull())
    openDiff('Assets/Scripts/Existing.cs')

    await act(async () => {
      await result.current.decide('Assets/Scripts/Existing.cs', false)
    })

    const post = calls().find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    expect(post!.url).toBe(`/api/workspace/change-review/${REVIEW_ID}/decisions`)
    expect(post!.body).toEqual({
      decisions: [{ path: 'Assets/Scripts/Existing.cs', decision: 'undo' }],
    })
    // Applied: only NOW is the original on screen and the diff gone.
    const tab = useCodeStore.getState().tabs[0]
    expect(tab.content).toBe("the user's version")
    expect(tab.isDiff).toBe(false)
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
  })

  // The refusal path is the one that used to lie: the portal showed the revert
  // as done regardless. A 409 has to leave the diff exactly as it was.
  it('a refused undo keeps the diff up and shows the daemon’s reason', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse(409, {
            error: 'The undo was refused',
            reason: 'nothing was undone: 1 path(s) are not in the state this run left them in',
          })
        : jsonResponse(200, { review: serverPreview }),
    )
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.review).not.toBeNull())
    openDiff('Assets/Scripts/Existing.cs')

    await act(async () => {
      await result.current.decide('Assets/Scripts/Existing.cs', false)
    })

    const tab = useCodeStore.getState().tabs[0]
    expect(tab.isDiff).toBe(true)
    expect(tab.content).toBe("the run's version")
    expect(result.current.error).toContain('The undo was refused')
    const decision = useCodeStore.getState().pendingDecisions[0]
    expect(decision.status).toBe('refused')
    expect(decision.error).toContain('The undo was refused')
  })

  it('a transport failure does not lose the decision', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('Failed to fetch')
      return jsonResponse(200, { review: serverPreview })
    })
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.review).not.toBeNull())
    openDiff('Assets/Scripts/Existing.cs')

    await act(async () => {
      await result.current.decide('Assets/Scripts/Existing.cs', false)
    })

    expect(useCodeStore.getState().pendingDecisions).toHaveLength(1)
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
    expect(result.current.error).toContain('Failed to fetch')
  })

  it('waits until every path of the run is decided, because the undo is review-wide', async () => {
    const twoEntries = {
      ...serverPreview,
      entries: [
        { path: 'a.cs', action: 'restore', state: 'ready' },
        { path: 'b.cs', action: 'delete', state: 'ready' },
      ],
    }
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse(200, {
            reviewId: REVIEW_ID,
            outcome: 'undone',
            applied: ['a.cs', 'b.cs'],
            kept: [],
            failed: [],
            leftOver: [],
            review: { ...twoEntries, entries: [] },
          })
        : jsonResponse(200, { review: twoEntries }),
    )
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.review).not.toBeNull())
    openDiff('a.cs')
    openDiff('b.cs')

    await act(async () => {
      await result.current.decide('a.cs', false)
    })
    // One of two decided: nothing sent, and the panel can say what it waits for.
    expect(calls().some((c) => c.method === 'POST')).toBe(false)
    expect(result.current.undecided).toEqual(['b.cs'])

    await act(async () => {
      await result.current.decide('b.cs', false)
    })
    const post = calls().find((c) => c.method === 'POST')
    expect(post!.body).toEqual({
      decisions: [
        { path: 'a.cs', decision: 'undo' },
        { path: 'b.cs', decision: 'undo' },
      ],
    })
  })

  it('a decision with no published review to act on is refused locally, not sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { review: null }))
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    openDiff('Assets/Scripts/Existing.cs')

    await act(async () => {
      useCodeStore.getState().resolveDiff('Assets/Scripts/Existing.cs', false)
      await result.current.submit()
    })

    expect(calls().some((c) => c.method === 'POST')).toBe(false)
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
    expect(useCodeStore.getState().pendingDecisions[0].status).toBe('refused')
    expect(result.current.error).toContain('no published change review')
  })

  it('an explicitly confirmed undo is the only thing that sends onBlocked: skip', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse(200, {
            reviewId: REVIEW_ID,
            outcome: 'partially-undone',
            applied: ['Assets/Scripts/Existing.cs'],
            kept: [],
            failed: [],
            leftOver: [],
            review: null,
          })
        : jsonResponse(200, { review: serverPreview }),
    )
    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.review).not.toBeNull())
    openDiff('Assets/Scripts/Existing.cs')

    await act(async () => {
      useCodeStore.getState().resolveDiff('Assets/Scripts/Existing.cs', false)
      await result.current.submit({ onBlocked: 'skip' })
    })

    const post = calls().find((c) => c.method === 'POST')
    expect(post!.body).toMatchObject({ onBlocked: 'skip' })
  })
})

/**
 * Round 12 #17, through the transport: the hook must tell the store WHICH review
 * and which revision an answer is about. Settling on the path alone let a
 * response that was still in flight when a new run published clear the decision
 * the user had just made about the new one.
 */
describe('useChangeReview — a late answer belongs to the review it was sent for', () => {
  it('does not settle a newer review’s decision when the older response arrives', async () => {
    const secondPreview = { ...serverPreview, reviewId: 'run-2', createdAt: 1_700_000_100_000 }
    let answerFirstPost: (() => void) | undefined
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        // Held open: the response lands after the next run has published.
        await new Promise<void>((resolve) => {
          answerFirstPost = resolve
        })
        return jsonResponse(200, {
          reviewId: REVIEW_ID,
          outcome: 'undone',
          applied: ['Assets/Scripts/Existing.cs'],
          kept: [],
          failed: [],
          leftOver: [],
          review: null,
        })
      }
      return jsonResponse(200, { review: serverPreview })
    })

    const { result } = renderHook(() => useChangeReview())
    await waitFor(() => expect(result.current.review).not.toBeNull())
    openDiff('Assets/Scripts/Existing.cs')

    const inFlight = act(async () => {
      await result.current.decide('Assets/Scripts/Existing.cs', false)
    })
    await waitFor(() => expect(answerFirstPost).toBeDefined())

    // A new run publishes and the user rejects its version of the same file.
    act(() => {
      useCodeStore.getState().setChangeReview({
        reviewId: 'run-2',
        createdAt: secondPreview.createdAt,
        entries: [{ path: 'Assets/Scripts/Existing.cs', action: 'restore', state: 'ready' }],
        historyCommits: 0,
        complete: true,
      })
      useCodeStore.getState().resolveDiff('Assets/Scripts/Existing.cs', false)
    })

    answerFirstPost!()
    await inFlight

    const pending = useCodeStore.getState().pendingDecisions
    expect(pending).toHaveLength(1)
    expect(pending[0].reviewId).toBe('run-2')
    // Nothing has reverted run-2's change, so its diff is still up.
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
  })
})
