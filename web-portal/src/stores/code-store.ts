import { create } from 'zustand'

export interface CodeTab {
  path: string
  content: string
  language: string
  isDiff?: boolean
  diffContent?: string
  originalContent?: string
  modifiedContent?: string
}

export interface Annotation {
  path: string
  line: number
  message: string
  severity: 'error' | 'warning' | 'info'
}

export type TouchedStatus = 'modified' | 'new' | 'deleted'

/**
 * What the server would do to one path if the run's changes were undone.
 * Mirrors ReviewedChange/UndoEntryPreview in
 * src/agents/multi/workspace-change-review.ts — the review is computed there,
 * against the project on disk, and only displayed here.
 */
export type ReviewAction = 'restore' | 'delete' | 'restore-deleted'
export type ReviewEntryState = 'ready' | 'changed-since' | 'already-undone' | 'unrecoverable'

export interface ChangeReviewEntry {
  path: string
  action: ReviewAction
  state: ReviewEntryState
  detail?: string
}

export interface ChangeReview {
  reviewId: string
  createdAt: number
  entries: ChangeReviewEntry[]
  /** Project commits the run made, which an undo would roll back. */
  historyCommits: number
  /** False when something is in the way — see each entry's state. */
  complete: boolean
}

export type ChangeDecision = 'keep' | 'undo'

/**
 * How far a decision has got. The whole point of the field: 'applied' is set
 * ONLY by a server acknowledgement, so nothing in the UI can present a revert
 * that has not happened.
 */
export type DecisionStatus = 'pending' | 'sending' | 'applied' | 'refused'

/**
 * A decision the user made in the browser, and how far it has got.
 *
 * This queue is half of the fix for the defect this store was carrying:
 * resolveDiff() rewrote a tab's fields and stopped there, so "accept" /
 * "reject" existed only in browser state. What the user saw and what could
 * actually be kept or put back were two different things, and closing the tab
 * (or the browser) lost the decision with nothing said.
 *
 * The other half is the transport (round 11 #20): useChangeReview() sends these
 * to POST /api/workspace/change-review/:id/decisions, which calls applyUndo on
 * the server, and hands the answer back to settleDecisions(). A decision stays
 * here until that answer arrives — draining the queue on send is how a decision
 * gets lost — and a rejection is shown as done only once the answer says the
 * path was actually put back.
 */
export interface PendingChangeDecision {
  path: string
  decision: ChangeDecision
  /** The server-side review this decision belongs to; null when none is loaded. */
  reviewId: string | null
  /**
   * The server must ask before acting: this path is not in a state where an
   * undo is safe — typically because a human edited it after the run published
   * it, which is precisely the case where silently reverting destroys their work.
   */
  needsConfirm: boolean
  at: number
  status: DecisionStatus
  /** What the server said when it would not apply this decision. */
  error?: string
}

/**
 * The server's answer to a batch of decisions, as the store needs it.
 *
 * `applied` is the only field that may dismiss a diff: it is what the route
 * reported as actually done (restored or deleted on disk for an undo, recorded
 * as kept for a keep). Everything else the user sent and that is not in
 * `applied` stays visible, with the reason.
 */
export interface DecisionAck {
  applied?: string[]
  refused?: string[]
  reason?: string
}

interface CodeState {
  tabs: CodeTab[]
  activeTab: string | null
  terminalOutput: string[]
  annotations: Annotation[]
  touchedFiles: Record<string, TouchedStatus>
  /** What the server says this run changed, and what an undo would do. */
  review: ChangeReview | null
  /** Decisions made here that still have to reach the server. */
  pendingDecisions: PendingChangeDecision[]

  openFile: (tab: CodeTab) => void
  closeFile: (path: string) => void
  setActiveTab: (path: string) => void
  appendTerminal: (line: string) => void
  clearTerminal: () => void
  addAnnotation: (ann: Annotation) => void
  clearAnnotations: (path: string) => void
  markTouched: (path: string, status: TouchedStatus) => void
  /**
   * Record what the user decided about one path.
   *
   * Accepting shows the run's version, which is already the version on disk.
   * REJECTING changes nothing on screen yet: the run's bytes are still in the
   * project until the server puts the previous ones back, so the diff stays
   * until settleDecisions() says it was applied.
   */
  resolveDiff: (path: string, accepted: boolean) => void
  setChangeReview: (review: ChangeReview | null) => void
  /** Remove a decision without sending it (the user changed their mind). */
  clearPendingDecision: (path: string) => void
  /**
   * Hand the undecided decisions to whoever sends them and mark them in flight.
   * They STAY in the queue: a decision removed before the server answers is a
   * decision lost, which is the defect this store had.
   */
  takePendingDecisions: () => PendingChangeDecision[]
  /** Apply the server's answer: dismiss what it applied, keep what it refused. */
  settleDecisions: (ack: DecisionAck) => void
  reset: () => void
}

const initialState = {
  tabs: [] as CodeTab[],
  activeTab: null as string | null,
  terminalOutput: [] as string[],
  annotations: [] as Annotation[],
  touchedFiles: {} as Record<string, TouchedStatus>,
  review: null as ChangeReview | null,
  pendingDecisions: [] as PendingChangeDecision[],
}

export const useCodeStore = create<CodeState>()((set, get) => ({
  ...initialState,

  openFile: (tab) =>
    set((s) => {
      const exists = s.tabs.some((t) => t.path === tab.path)
      if (exists) {
        return { tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, ...tab } : t)), activeTab: tab.path }
      }
      return { tabs: [...s.tabs, tab], activeTab: tab.path }
    }),

  closeFile: (path) =>
    set((s) => {
      const newTabs = s.tabs.filter((t) => t.path !== path)
      let newActive = s.activeTab
      if (s.activeTab === path) {
        const idx = s.tabs.findIndex((t) => t.path === path)
        newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.path ?? null
      }
      return { tabs: newTabs, activeTab: newActive }
    }),

  setActiveTab: (path) => set({ activeTab: path }),

  appendTerminal: (line) =>
    set((s) => {
      const next = [...s.terminalOutput, line]
      return { terminalOutput: next.length > 5000 ? next.slice(-5000) : next }
    }),

  clearTerminal: () => set({ terminalOutput: [] }),

  addAnnotation: (ann) => set((s) => ({ annotations: [...s.annotations, ann] })),

  clearAnnotations: (path) => set((s) => ({ annotations: s.annotations.filter((a) => a.path !== path) })),

  markTouched: (path, status) =>
    set((s) => ({
      touchedFiles: { ...s.touchedFiles, [path]: status },
    })),

  resolveDiff: (path, accepted) =>
    set((s) => {
      const decision: ChangeDecision = accepted ? 'keep' : 'undo'
      const entry = s.review?.entries.find((e) => e.path === path)
      // An undo the server cannot simply perform must be CONFIRMED, not sent as
      // if it were routine: the usual reason is that a person edited this file
      // after the run published it, and their bytes are not ours to discard.
      const needsConfirm = decision === 'undo' && (s.review === null || entry === undefined || entry.state !== 'ready')
      return {
        // Accepting is the only half that can be shown immediately: the run's
        // version IS what the project holds. A rejection leaves the diff up —
        // showing the original before the server has restored it would be the
        // original defect, a revert that exists only in the browser.
        tabs: accepted
          ? s.tabs.map((t) =>
              t.path === path
                ? {
                    ...t,
                    content: t.modifiedContent ?? t.content,
                    isDiff: false,
                    diffContent: undefined,
                    originalContent: undefined,
                    modifiedContent: undefined,
                  }
                : t,
            )
          : s.tabs,
        // One decision per path — the last one the user made.
        pendingDecisions: [
          ...s.pendingDecisions.filter((d) => d.path !== path),
          {
            path,
            decision,
            reviewId: s.review?.reviewId ?? null,
            needsConfirm,
            at: Date.now(),
            status: 'pending' as DecisionStatus,
          },
        ],
      }
    }),

  setChangeReview: (review) =>
    set((s) => ({
      review,
      // Decisions belong to the run they were made about. A new review means a
      // new run, and carrying an old decision into it would apply it to the
      // wrong change.
      pendingDecisions: s.pendingDecisions.filter((d) => d.reviewId === review?.reviewId),
    })),

  clearPendingDecision: (path) =>
    set((s) => ({ pendingDecisions: s.pendingDecisions.filter((d) => d.path !== path) })),

  takePendingDecisions: () => {
    // Everything not already in flight or done: a refused decision is offered
    // again so a retry (or a confirmed undo) can carry it.
    const queued = get().pendingDecisions.filter((d) => d.status === 'pending' || d.status === 'refused')
    if (queued.length === 0) return []
    const sending = new Set(queued.map((d) => d.path))
    set((s) => ({
      pendingDecisions: s.pendingDecisions.map((d) =>
        sending.has(d.path) ? { ...d, status: 'sending' as DecisionStatus, error: undefined } : d,
      ),
    }))
    return queued.map((d) => ({ ...d, status: 'sending' as DecisionStatus }))
  },

  settleDecisions: (ack) =>
    set((s) => {
      const applied = new Set(ack.applied ?? [])
      const refused = new Set(ack.refused ?? [])
      // Only an applied UNDO changes what is on screen: the file on disk is the
      // previous version again, so the diff goes and the original is the content.
      const undone = s.pendingDecisions.filter((d) => d.decision === 'undo' && applied.has(d.path)).map((d) => d.path)
      const touchedFiles = { ...s.touchedFiles }
      for (const path of undone) delete touchedFiles[path]
      return {
        tabs: s.tabs.map((t) =>
          undone.includes(t.path)
            ? {
                ...t,
                content: t.originalContent ?? t.content,
                isDiff: false,
                diffContent: undefined,
                originalContent: undefined,
                modifiedContent: undefined,
              }
            : t,
        ),
        touchedFiles,
        // An applied decision leaves the queue; a refused one stays, with the
        // reason, so the user is told rather than silently ignored.
        pendingDecisions: s.pendingDecisions
          .filter((d) => !applied.has(d.path))
          .map((d) =>
            refused.has(d.path)
              ? {
                  ...d,
                  status: 'refused' as DecisionStatus,
                  error: ack.reason ?? 'the server did not apply this decision',
                }
              : d,
          ),
      }
    }),

  reset: () =>
    set({
      tabs: [],
      activeTab: null,
      terminalOutput: [],
      annotations: [],
      touchedFiles: {},
      review: null,
      pendingDecisions: [],
    }),
}))
