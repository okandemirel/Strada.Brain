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
 * A decision the user made in the browser that has NOT reached the server yet.
 *
 * This queue is the fix for the defect this store was carrying: resolveDiff()
 * rewrote a tab's fields and stopped there, so "accept" / "reject" existed only
 * in browser state. What the user saw and what could actually be kept or put
 * back were two different things, and closing the tab (or the browser) lost the
 * decision with nothing said. Every decision now lands here with the review id
 * it belongs to, and the socket layer drains it.
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
  resolveDiff: (path: string, accepted: boolean) => void
  setChangeReview: (review: ChangeReview | null) => void
  /** Remove a decision without sending it (the user changed their mind). */
  clearPendingDecision: (path: string) => void
  /** Hand the queued decisions to whoever sends them, and empty the queue. */
  takePendingDecisions: () => PendingChangeDecision[]
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
        tabs: s.tabs.map((t) =>
          t.path === path
            ? {
                ...t,
                // Rejecting shows the ORIGINAL again. It used to leave whatever
                // was in `content` on screen, so a rejected change could still
                // be the text the user was reading.
                content: accepted
                  ? (t.modifiedContent ?? t.content)
                  : (t.originalContent ?? t.content),
                isDiff: false,
                diffContent: undefined,
                originalContent: undefined,
                modifiedContent: undefined,
              }
            : t,
        ),
        // One decision per path — the last one the user made.
        pendingDecisions: [
          ...s.pendingDecisions.filter((d) => d.path !== path),
          { path, decision, reviewId: s.review?.reviewId ?? null, needsConfirm, at: Date.now() },
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
    const queued = get().pendingDecisions
    set({ pendingDecisions: [] })
    return queued
  },

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
