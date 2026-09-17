import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchJson } from '../utils/api'
import {
  useCodeStore,
  type ChangeReview,
  type ChangeReviewEntry,
  type PendingChangeDecision,
} from '../stores/code-store'

/**
 * The transport for the code panel's accept / reject (round 11 #20).
 *
 * THE DEFECT THIS CLOSES. The store had a review-aware decision queue and the
 * daemon had a working undo (src/agents/multi/workspace-change-review.ts), and
 * nothing joined them: no component fetched a review, nothing supplied its id,
 * and no decision was ever sent. Rejecting a change repainted a tab while the
 * run's bytes stayed in the project, and a reload lost the decision silently.
 *
 * This hook is the only production caller of setChangeReview /
 * takePendingDecisions / settleDecisions, and the rule it exists to enforce is:
 * a rejection is presented as done ONLY for the paths the server says it
 * applied. Everything else is reported with the server's own reason.
 */

/** The preview as src/dashboard/change-review-routes.ts sends it. */
interface ServerEntry {
  path: string
  action: ChangeReviewEntry['action']
  state: ChangeReviewEntry['state']
  detail?: string
}

interface ServerPreview {
  reviewId: string
  createdAt: number
  entries: ServerEntry[]
  history: { commits: number } | null
  complete: boolean
}

interface DecisionsResponse {
  reviewId: string
  outcome: 'undone' | 'partially-undone' | 'kept'
  applied: string[]
  kept: string[]
  failed: string[]
  leftOver: string[]
  review: ServerPreview | null
}

export const CHANGE_REVIEW_URL = '/api/workspace/change-review'

function toStoreReview(preview: ServerPreview | null | undefined): ChangeReview | null {
  if (!preview) return null
  return {
    reviewId: preview.reviewId,
    createdAt: preview.createdAt,
    entries: preview.entries.map((entry) => ({
      path: entry.path,
      action: entry.action,
      state: entry.state,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    })),
    historyCommits: preview.history?.commits ?? 0,
    complete: preview.complete,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the change review could not be reached'
}

export interface UseChangeReview {
  review: ChangeReview | null
  /** Paths whose decision has not been applied yet, with any server reason. */
  pending: PendingChangeDecision[]
  /** True while a decision batch is in flight. */
  sending: boolean
  /** What the server said about the last attempt, or a transport failure. */
  error: string | null
  /** Entries still waiting for the user to decide (the undo needs all of them). */
  undecided: string[]
  /** Record a decision, and send the batch as soon as the review is fully decided. */
  decide: (path: string, accepted: boolean) => Promise<void>
  /** Send whatever is queued now. `onBlocked: 'skip'` is a confirmed undo. */
  submit: (options?: { onBlocked?: 'refuse' | 'skip' }) => Promise<void>
  /** Re-read the review from the server (after a run publishes, or a decision). */
  refresh: () => Promise<void>
}

export function useChangeReview(): UseChangeReview {
  const review = useCodeStore((s) => s.review)
  const pending = useCodeStore((s) => s.pendingDecisions)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

/**
   * Re-read the review. `keepError` exists because the reload that FOLLOWS a
   * refused decision must not erase the reason for the refusal — the refusal is
   * the thing the user has to see, and a successful reload is not news.
   */
  const reload = useCallback(async (options?: { keepError?: boolean }) => {
    try {
      const body = await fetchJson<{ review: ServerPreview | null }>(CHANGE_REVIEW_URL)
      useCodeStore.getState().setChangeReview(toStoreReview(body?.review))
      if (alive.current && !options?.keepError) setError(null)
    } catch (err) {
      if (alive.current) setError(messageOf(err))
    }
  }, [])

  const refresh = useCallback(async () => {
    await reload()
  }, [reload])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = useCallback<UseChangeReview['submit']>(
    async (options) => {
      const queued = useCodeStore.getState().takePendingDecisions()
      if (queued.length === 0) return
      const reviewId = queued.find((d) => d.reviewId !== null)?.reviewId ?? null
      if (reviewId === null) {
        // Nothing on the server to act on: say so instead of pretending.
        useCodeStore.getState().settleDecisions({
          refused: queued.map((d) => d.path),
          reason: 'no published change review to apply this to',
        })
        if (alive.current) setError('no published change review to apply this to')
        return
      }
      if (alive.current) {
        setSending(true)
        setError(null)
      }
      try {
        const body = await fetchJson<DecisionsResponse>(
          `${CHANGE_REVIEW_URL}/${encodeURIComponent(reviewId)}/decisions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              decisions: queued.map((d) => ({ path: d.path, decision: d.decision })),
              ...(options?.onBlocked ? { onBlocked: options.onBlocked } : {}),
            }),
          },
        )
        const applied = body?.applied ?? []
        const refused = queued.map((d) => d.path).filter((path) => !applied.includes(path))
        useCodeStore.getState().settleDecisions({
          applied,
          refused,
          ...(refused.length > 0 ? { reason: 'the server did not report this path as applied' } : {}),
        })
        if (body?.review !== undefined) useCodeStore.getState().setChangeReview(toStoreReview(body.review))
        else await reload()
      } catch (err) {
        // A refusal (409) and a transport failure are the same thing here:
        // nothing was applied, so every decision goes back on the queue with
        // the server's reason attached.
        const reason = messageOf(err)
        useCodeStore.getState().settleDecisions({ refused: queued.map((d) => d.path), reason })
        if (alive.current) setError(reason)
        await reload({ keepError: true })
      } finally {
        if (alive.current) setSending(false)
      }
    },
    [reload],
  )

  /**
   * Entries the server would touch and that the user has not decided about. The
   * undo restores a review as a whole, so sending a decision for one file of
   * three would be refused — the panel waits until the run is fully decided.
   */
  const undecided = (review?.entries ?? [])
    .filter((entry) => entry.state !== 'already-undone')
    .map((entry) => entry.path)
    .filter((path) => !pending.some((d) => d.path === path))

  const decide = useCallback<UseChangeReview['decide']>(
    async (path, accepted) => {
      useCodeStore.getState().resolveDiff(path, accepted)
      const state = useCodeStore.getState()
      const decided = new Set(state.pendingDecisions.map((d) => d.path))
      const needed = (state.review?.entries ?? [])
        .filter((entry) => entry.state !== 'already-undone')
        .map((entry) => entry.path)
      if (needed.length > 0 && needed.every((p) => decided.has(p))) await submit()
    },
    [submit],
  )

  return { review, pending, sending, error, undecided, decide, submit, refresh }
}
