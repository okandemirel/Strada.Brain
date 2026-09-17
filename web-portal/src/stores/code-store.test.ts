import { describe, it, expect, beforeEach } from 'vitest'
import { useCodeStore } from './code-store'

describe('useCodeStore', () => {
  beforeEach(() => useCodeStore.getState().reset())

  it('starts with empty tabs', () => {
    const state = useCodeStore.getState()
    expect(state.tabs).toEqual([])
    expect(state.activeTab).toBeNull()
  })

  it('opens a file (adds tab and sets active)', () => {
    useCodeStore.getState().openFile({ path: 'src/index.ts', content: 'hello', language: 'typescript' })
    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/index.ts')
    expect(state.activeTab).toBe('src/index.ts')
  })

  it('does not duplicate tab when opening same file', () => {
    useCodeStore.getState().openFile({ path: 'a.ts', content: 'v1', language: 'typescript' })
    useCodeStore.getState().openFile({ path: 'a.ts', content: 'v2', language: 'typescript' })
    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].content).toBe('v2')
  })

  it('switches active tab', () => {
    useCodeStore.getState().openFile({ path: 'a.ts', content: '', language: 'typescript' })
    useCodeStore.getState().openFile({ path: 'b.ts', content: '', language: 'typescript' })
    useCodeStore.getState().setActiveTab('a.ts')
    expect(useCodeStore.getState().activeTab).toBe('a.ts')
  })

  it('closes a tab and adjusts active', () => {
    useCodeStore.getState().openFile({ path: 'a.ts', content: '', language: 'typescript' })
    useCodeStore.getState().openFile({ path: 'b.ts', content: '', language: 'typescript' })
    useCodeStore.getState().setActiveTab('a.ts')
    useCodeStore.getState().closeFile('a.ts')
    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTab).toBe('b.ts')
  })

  it('closing last tab sets activeTab to null', () => {
    useCodeStore.getState().openFile({ path: 'a.ts', content: '', language: 'typescript' })
    useCodeStore.getState().closeFile('a.ts')
    expect(useCodeStore.getState().activeTab).toBeNull()
  })

  it('appends terminal output', () => {
    useCodeStore.getState().appendTerminal('line 1')
    useCodeStore.getState().appendTerminal('line 2')
    expect(useCodeStore.getState().terminalOutput).toEqual(['line 1', 'line 2'])
  })

  it('clears terminal', () => {
    useCodeStore.getState().appendTerminal('line 1')
    useCodeStore.getState().clearTerminal()
    expect(useCodeStore.getState().terminalOutput).toEqual([])
  })

  it('adds annotation', () => {
    useCodeStore.getState().addAnnotation({ path: 'a.ts', line: 10, message: 'err', severity: 'error' })
    expect(useCodeStore.getState().annotations).toHaveLength(1)
    expect(useCodeStore.getState().annotations[0].severity).toBe('error')
  })

  it('clears annotations for a specific file', () => {
    useCodeStore.getState().addAnnotation({ path: 'a.ts', line: 1, message: 'e', severity: 'error' })
    useCodeStore.getState().addAnnotation({ path: 'b.ts', line: 2, message: 'w', severity: 'warning' })
    useCodeStore.getState().clearAnnotations('a.ts')
    const anns = useCodeStore.getState().annotations
    expect(anns).toHaveLength(1)
    expect(anns[0].path).toBe('b.ts')
  })

  it('reset clears all state', () => {
    useCodeStore.getState().openFile({ path: 'a.ts', content: '', language: 'typescript' })
    useCodeStore.getState().appendTerminal('hi')
    useCodeStore.getState().addAnnotation({ path: 'a.ts', line: 1, message: 'e', severity: 'info' })
    useCodeStore.getState().reset()
    const state = useCodeStore.getState()
    expect(state.tabs).toEqual([])
    expect(state.activeTab).toBeNull()
    expect(state.terminalOutput).toEqual([])
    expect(state.annotations).toEqual([])
  })
})

describe('useCodeStore — touchedFiles', () => {
  beforeEach(() => useCodeStore.getState().reset())

  it('touchedFiles starts empty', () => {
    const state = useCodeStore.getState()
    expect(Object.keys(state.touchedFiles).length).toBe(0)
  })

  it('markTouched sets file status', () => {
    useCodeStore.getState().markTouched('src/index.ts', 'modified')
    expect(useCodeStore.getState().touchedFiles['src/index.ts']).toBe('modified')
  })

  it('markTouched overwrites previous status', () => {
    useCodeStore.getState().markTouched('src/app.ts', 'new')
    expect(useCodeStore.getState().touchedFiles['src/app.ts']).toBe('new')

    useCodeStore.getState().markTouched('src/app.ts', 'deleted')
    expect(useCodeStore.getState().touchedFiles['src/app.ts']).toBe('deleted')
  })

  it('reset clears touchedFiles', () => {
    useCodeStore.getState().markTouched('a.ts', 'modified')
    useCodeStore.getState().markTouched('b.ts', 'new')
    expect(Object.keys(useCodeStore.getState().touchedFiles).length).toBe(2)

    useCodeStore.getState().reset()
    expect(Object.keys(useCodeStore.getState().touchedFiles).length).toBe(0)
  })
})

describe('useCodeStore — closeFile auto-accepts diff', () => {
  beforeEach(() => useCodeStore.getState().reset())

  it('closing a diff tab auto-resolves to modified content', () => {
    useCodeStore.getState().openFile({
      path: 'src/test.ts',
      content: 'original code',
      language: 'typescript',
      isDiff: true,
      originalContent: 'original code',
      modifiedContent: 'modified code',
    })
    useCodeStore.getState().openFile({ path: 'other.ts', content: '', language: 'typescript' })

    useCodeStore.getState().closeFile('src/test.ts')
    expect(useCodeStore.getState().tabs.find((t) => t.path === 'src/test.ts')).toBeUndefined()
  })

  it('closing a non-diff tab works normally', () => {
    useCodeStore.getState().openFile({ path: 'a.ts', content: 'hello', language: 'typescript' })
    useCodeStore.getState().closeFile('a.ts')
    expect(useCodeStore.getState().tabs).toHaveLength(0)
  })
})

describe('useCodeStore — resolveDiff', () => {
  beforeEach(() => useCodeStore.getState().reset())

  // ROUND 12 #18: accepting used to rewrite the tab on the spot. It records a
  // decision and leaves the tab alone — see "a mixed review stays changeable".
  it('resolveDiff with accepted=true records a keep and leaves the tab alone', () => {
    useCodeStore.getState().openFile({
      path: 'src/test.ts',
      content: 'original code',
      language: 'typescript',
      isDiff: true,
      diffContent: '--- a\n+++ b',
      originalContent: 'original code',
      modifiedContent: 'modified code',
    })

    useCodeStore.getState().resolveDiff('src/test.ts', true)

    const tab = useCodeStore.getState().tabs.find((t) => t.path === 'src/test.ts')!
    expect(tab.content).toBe('original code')
    expect(tab.isDiff).toBe(true)
    expect(useCodeStore.getState().pendingDecisions[0].decision).toBe('keep')
  })

  // Round 11 #20: a rejection leaves the tab ALONE until the daemon has put the
  // file back — the diff stays up, so nothing on screen claims a revert that has
  // not happened yet.
  it('resolveDiff with accepted=false leaves the tab as it was, diff included', () => {
    useCodeStore.getState().openFile({
      path: 'src/test.ts',
      content: 'original code',
      language: 'typescript',
      isDiff: true,
      diffContent: '--- a\n+++ b',
      originalContent: 'original code',
      modifiedContent: 'modified code',
    })

    useCodeStore.getState().resolveDiff('src/test.ts', false)

    const tab = useCodeStore.getState().tabs.find((t) => t.path === 'src/test.ts')!
    expect(tab.content).toBe('original code')
    expect(tab.isDiff).toBe(true)
    expect(tab.modifiedContent).toBe('modified code')
  })

  it('an ACKNOWLEDGED keep is what clears the diff fields', () => {
    useCodeStore.getState().openFile({
      path: 'src/test.ts',
      content: 'original code',
      language: 'typescript',
      isDiff: true,
      diffContent: '--- a\n+++ b',
      originalContent: 'original code',
      modifiedContent: 'modified code',
    })

    useCodeStore.getState().resolveDiff('src/test.ts', true)
    const sent = useCodeStore.getState().takePendingDecisions()
    useCodeStore.getState().settleDecisions({
      reviewId: null,
      applied: ['src/test.ts'],
      revisions: { 'src/test.ts': sent[0].revision },
    })

    const tab = useCodeStore.getState().tabs.find((t) => t.path === 'src/test.ts')!
    expect(tab.content).toBe('modified code')
    expect(tab.isDiff).toBe(false)
    expect(tab.diffContent).toBeUndefined()
    expect(tab.originalContent).toBeUndefined()
    expect(tab.modifiedContent).toBeUndefined()
  })
})

/**
 * The defect this covers: resolveDiff() moved a tab's fields around and stopped
 * there. "Accept" and "reject" lived in browser state alone, so what the user
 * saw and what could actually be kept or put back in their project were two
 * different things — and closing the tab lost the decision with nothing said.
 *
 * The server side is src/agents/multi/workspace-change-review.ts: it computes
 * what an undo would do to each path (including "a human edited this after the
 * run published it") and performs it. This store's job is to show that and to
 * make sure every decision leaves the browser.
 */
describe('useCodeStore — change review and undo decisions', () => {
  beforeEach(() => useCodeStore.getState().reset())

  const review = {
    reviewId: '9f3a1c2d',
    createdAt: 1_700_000_000_000,
    historyCommits: 2,
    complete: false,
    entries: [
      { path: 'src/ready.ts', action: 'restore' as const, state: 'ready' as const },
      {
        path: 'src/mine.ts',
        action: 'restore' as const,
        state: 'changed-since' as const,
        detail: 'someone changed this file after the run published it',
      },
    ],
  }

  function openDiff(path: string) {
    useCodeStore.getState().openFile({
      path,
      content: 'run version',
      language: 'typescript',
      isDiff: true,
      diffContent: '--- a\n+++ b',
      originalContent: 'my version',
      modifiedContent: 'run version',
    })
  }

  it('queues a server-bound decision instead of only mutating the tab', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')

    useCodeStore.getState().resolveDiff('src/ready.ts', false)

    const queued = useCodeStore.getState().pendingDecisions
    expect(queued).toHaveLength(1)
    expect(queued[0].path).toBe('src/ready.ts')
    expect(queued[0].decision).toBe('undo')
    expect(queued[0].reviewId).toBe('9f3a1c2d')
    expect(queued[0].needsConfirm).toBe(false)
  })

// ROUND 11 #20. Rejecting used to swap the tab to the original and dismiss the
  // diff on the spot, while the run's bytes were still in the project: the revert
  // existed only on screen. Nothing may present it as done before the server has
  // actually put the file back.
  it('rejecting a diff does NOT put the original back until the server applied it', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')

    useCodeStore.getState().resolveDiff('src/ready.ts', false)

    const tab = useCodeStore.getState().tabs[0]
    expect(tab.content).toBe('run version')
    expect(tab.isDiff).toBe(true)
    expect(tab.originalContent).toBe('my version')
    expect(useCodeStore.getState().pendingDecisions[0].status).toBe('pending')
  })

  it('an applied undo is what puts the original back and dismisses the diff', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().markTouched('src/ready.ts', 'modified')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    const sent = useCodeStore.getState().takePendingDecisions()

    useCodeStore.getState().settleDecisions({
      reviewId: '9f3a1c2d',
      applied: ['src/ready.ts'],
      revisions: { 'src/ready.ts': sent[0].revision },
    })

    const tab = useCodeStore.getState().tabs[0]
    expect(tab.content).toBe('my version')
    expect(tab.isDiff).toBe(false)
    expect(tab.diffContent).toBeUndefined()
    // The decision reached the server, so it leaves the queue…
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
    // …and the file is not a changed file any more.
    expect(useCodeStore.getState().touchedFiles['src/ready.ts']).toBeUndefined()
  })

  it('a decision the server refused keeps the diff, keeps the decision, and says why', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    const sent = useCodeStore.getState().takePendingDecisions()

    useCodeStore.getState().settleDecisions({
      reviewId: '9f3a1c2d',
      refused: ['src/ready.ts'],
      reason: 'nothing was undone: 1 path(s) are not in the state this run left them in',
      revisions: { 'src/ready.ts': sent[0].revision },
    })

    const tab = useCodeStore.getState().tabs[0]
    expect(tab.isDiff).toBe(true)
    expect(tab.content).toBe('run version')
    const decision = useCodeStore.getState().pendingDecisions[0]
    expect(decision.status).toBe('refused')
    expect(decision.error).toContain('not in the state this run left them in')
    // …and it is offered again, so a retry (or a confirmed undo) can carry it.
    expect(useCodeStore.getState().takePendingDecisions().map((d) => d.path)).toEqual(['src/ready.ts'])
  })

  it('an applied keep shows the run\'s version — which is what is already on disk', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', true)
    const sent = useCodeStore.getState().takePendingDecisions()

    useCodeStore.getState().settleDecisions({
      reviewId: '9f3a1c2d',
      applied: ['src/ready.ts'],
      revisions: { 'src/ready.ts': sent[0].revision },
    })

    expect(useCodeStore.getState().tabs[0].content).toBe('run version')
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(false)
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
  })

  it('an answer that names neither the path nor a reason leaves the decision alone', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    useCodeStore.getState().takePendingDecisions()

    useCodeStore.getState().settleDecisions({ reviewId: '9f3a1c2d', applied: ['src/somethingelse.ts'] })

    const decision = useCodeStore.getState().pendingDecisions[0]
    expect(decision.path).toBe('src/ready.ts')
    expect(decision.status).toBe('sending')
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
  })

  it('accepting queues a keep decision and leaves the diff up until it is applied', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', true)
    expect(useCodeStore.getState().tabs[0].content).toBe('run version')
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
    expect(useCodeStore.getState().pendingDecisions[0].decision).toBe('keep')
    expect(useCodeStore.getState().pendingDecisions[0].needsConfirm).toBe(false)
  })

  it('an undo for a path a human edited after the run has to be confirmed', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/mine.ts')

    useCodeStore.getState().resolveDiff('src/mine.ts', false)

    const queued = useCodeStore.getState().pendingDecisions[0]
    expect(queued.needsConfirm).toBe(true)
    expect(useCodeStore.getState().review!.entries[1].detail).toContain('after the run published it')
  })

  it('an undo with no server-side review to act on has to be confirmed too', () => {
    openDiff('src/unknown.ts')
    useCodeStore.getState().resolveDiff('src/unknown.ts', false)
    const queued = useCodeStore.getState().pendingDecisions[0]
    expect(queued.reviewId).toBeNull()
    expect(queued.needsConfirm).toBe(true)
  })

  it('re-deciding a path replaces its queued decision instead of sending both', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    useCodeStore.getState().resolveDiff('src/ready.ts', true)

    const queued = useCodeStore.getState().pendingDecisions
    expect(queued).toHaveLength(1)
    expect(queued[0].decision).toBe('keep')
  })

  it('a decision outlives the tab it was made in', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    useCodeStore.getState().closeFile('src/ready.ts')

    expect(useCodeStore.getState().tabs).toHaveLength(0)
    expect(useCodeStore.getState().pendingDecisions).toHaveLength(1)
  })

// ROUND 11 #20: it used to EMPTY the queue. A decision dropped at send time is
  // a decision lost the moment the request fails — which is how a rejection
  // could disappear with nothing said. It now marks them in flight and keeps
  // them until settleDecisions.
  it('takePendingDecisions hands them over once, marks them in flight, and keeps them', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    openDiff('src/mine.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    useCodeStore.getState().resolveDiff('src/mine.ts', true)

    const taken = useCodeStore.getState().takePendingDecisions()
    expect(taken.map((d) => d.path)).toEqual(['src/ready.ts', 'src/mine.ts'])
    expect(taken.every((d) => d.status === 'sending')).toBe(true)
    // Still there, in flight — not dropped.
    expect(useCodeStore.getState().pendingDecisions.map((d) => d.status)).toEqual(['sending', 'sending'])
    // …and not handed out a second time while they are in flight.
    expect(useCodeStore.getState().takePendingDecisions()).toEqual([])
  })

  it('clearPendingDecision drops one without sending it', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    useCodeStore.getState().clearPendingDecision('src/ready.ts')
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
  })

  it('a new review does not inherit the previous run’s decisions', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)

    useCodeStore.getState().setChangeReview({ ...review, reviewId: 'another-run' })

    expect(useCodeStore.getState().pendingDecisions).toEqual([])
    expect(useCodeStore.getState().review!.reviewId).toBe('another-run')
  })

  it('reset clears the review and every undecided decision', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)

    useCodeStore.getState().reset()

    expect(useCodeStore.getState().review).toBeNull()
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
  })
})

/**
 * Codex round 12 #17 and #18: the queue settled by PATH and the keep that
 * dismissed itself.
 *
 * Both are about a decision the user can still change, or a review they have
 * moved on from, being overwritten by an answer that was about something else.
 * A path is not an identity here: a decision belongs to one review and to one
 * revision of the user's mind, and only the answer to THAT may settle it.
 */
describe('useCodeStore — an acknowledgement belongs to one review (round 12 #17)', () => {
  beforeEach(() => useCodeStore.getState().reset())

  const r1 = {
    reviewId: 'run-1',
    createdAt: 1_700_000_000_000,
    historyCommits: 1,
    complete: true,
    entries: [{ path: 'a.cs', action: 'restore' as const, state: 'ready' as const }],
  }
  const r2 = { ...r1, reviewId: 'run-2', createdAt: 1_700_000_100_000 }

  function openDiff(path: string) {
    useCodeStore.getState().openFile({
      path,
      content: 'run version',
      language: 'csharp',
      isDiff: true,
      diffContent: '--- a\n+++ b',
      originalContent: 'my version',
      modifiedContent: 'run version',
    })
  }

  // THE DEFECT. R1's undo is in flight; a new run publishes; the user rejects
  // R2's a.cs; R1's answer finally arrives. Settling by path alone cleared R2's
  // pending decision and dismissed its diff — the newer rejection was silently
  // dropped and the file looked reverted when nothing had reverted it.
  it('an older review’s answer does not settle a newer review’s decision', () => {
    useCodeStore.getState().setChangeReview(r1)
    openDiff('a.cs')
    useCodeStore.getState().resolveDiff('a.cs', false)
    const inFlight = useCodeStore.getState().takePendingDecisions()
    expect(inFlight[0].reviewId).toBe('run-1')

    // A new run publishes and the user rejects its version of the same file.
    useCodeStore.getState().setChangeReview(r2)
    useCodeStore.getState().resolveDiff('a.cs', false)

    // R1's answer, late.
    useCodeStore.getState().settleDecisions({
      reviewId: 'run-1',
      applied: ['a.cs'],
      revisions: { 'a.cs': inFlight[0].revision },
    })

    const pending = useCodeStore.getState().pendingDecisions
    expect(pending).toHaveLength(1)
    expect(pending[0].reviewId).toBe('run-2')
    expect(pending[0].status).toBe('pending')
    // Nothing reverted R2's change, so its diff is still up.
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
    expect(useCodeStore.getState().tabs[0].content).toBe('run version')
  })

  // The review id is the correlation on its own: an answer that carries no
  // revisions at all still may not reach into another run's decisions.
  it('an answer that names only a review settles nothing from another review', () => {
    useCodeStore.getState().setChangeReview(r1)
    openDiff('a.cs')
    useCodeStore.getState().resolveDiff('a.cs', false)
    useCodeStore.getState().takePendingDecisions()
    useCodeStore.getState().setChangeReview(r2)
    useCodeStore.getState().resolveDiff('a.cs', false)

    useCodeStore.getState().settleDecisions({ reviewId: 'run-1', applied: ['a.cs'] })

    const pending = useCodeStore.getState().pendingDecisions
    expect(pending).toHaveLength(1)
    expect(pending[0].reviewId).toBe('run-2')
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
  })

  it('an answer to an older revision of the same decision does not settle the newer one', () => {
    useCodeStore.getState().setChangeReview(r1)
    openDiff('a.cs')
    useCodeStore.getState().resolveDiff('a.cs', false)
    const firstSend = useCodeStore.getState().takePendingDecisions()
    // The user changes their mind while that request is in flight.
    useCodeStore.getState().resolveDiff('a.cs', true)

    useCodeStore.getState().settleDecisions({
      reviewId: 'run-1',
      applied: ['a.cs'],
      revisions: { 'a.cs': firstSend[0].revision },
    })

    const pending = useCodeStore.getState().pendingDecisions
    expect(pending).toHaveLength(1)
    expect(pending[0].decision).toBe('keep')
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(true)
  })

  it('the answer to the decision actually sent settles it', () => {
    useCodeStore.getState().setChangeReview(r1)
    openDiff('a.cs')
    useCodeStore.getState().resolveDiff('a.cs', false)
    const sent = useCodeStore.getState().takePendingDecisions()

    useCodeStore.getState().settleDecisions({
      reviewId: 'run-1',
      applied: ['a.cs'],
      revisions: { 'a.cs': sent[0].revision },
    })

    expect(useCodeStore.getState().pendingDecisions).toEqual([])
    expect(useCodeStore.getState().tabs[0].isDiff).toBe(false)
    expect(useCodeStore.getState().tabs[0].content).toBe('my version')
  })
})

describe('useCodeStore — a mixed review stays changeable (round 12 #18)', () => {
  beforeEach(() => useCodeStore.getState().reset())

  const review = {
    reviewId: 'run-1',
    createdAt: 1_700_000_000_000,
    historyCommits: 0,
    complete: true,
    entries: [
      { path: 'A.cs', action: 'restore' as const, state: 'ready' as const },
      { path: 'B.cs', action: 'restore' as const, state: 'ready' as const },
    ],
  }

  function openDiff(path: string) {
    useCodeStore.getState().openFile({
      path,
      content: 'run version',
      language: 'csharp',
      isDiff: true,
      diffContent: '--- a\n+++ b',
      originalContent: 'my version',
      modifiedContent: 'run version',
    })
  }

  // THE DEFECT. Keep A, then revert B: the server refuses a mixed set (an undo
  // restores the whole review), but keeping A had already dismissed its diff and
  // with it the controls — so A could never be changed to revert, and the review
  // could not be decided at all. The decision is not final until the server has
  // acknowledged the whole review.
  it('keeping one path leaves its diff and controls in place until the server acknowledges', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('A.cs')
    openDiff('B.cs')

    useCodeStore.getState().resolveDiff('A.cs', true)

    const a = useCodeStore.getState().tabs.find((t) => t.path === 'A.cs')!
    expect(a.isDiff).toBe(true)
    expect(a.originalContent).toBe('my version')
    expect(a.modifiedContent).toBe('run version')
    expect(useCodeStore.getState().pendingDecisions[0].decision).toBe('keep')
  })

  it('so the user can change that keep into a revert after the server refuses the mixed set', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('A.cs')
    openDiff('B.cs')
    useCodeStore.getState().resolveDiff('A.cs', true)
    useCodeStore.getState().resolveDiff('B.cs', false)
    const sent = useCodeStore.getState().takePendingDecisions()
    // The server refuses the mixed set — nothing was applied.
    useCodeStore.getState().settleDecisions({
      reviewId: 'run-1',
      refused: sent.map((d) => d.path),
      reason: 'A change review is undone as a whole',
      revisions: Object.fromEntries(sent.map((d) => [d.path, d.revision])),
    })

    // A is still a diff, so the controls are still there to change the decision.
    expect(useCodeStore.getState().tabs.find((t) => t.path === 'A.cs')!.isDiff).toBe(true)
    useCodeStore.getState().resolveDiff('A.cs', false)
    const queued = useCodeStore.getState().pendingDecisions
    expect(queued.map((d) => d.decision)).toEqual(['undo', 'undo'])
    expect(queued.every((d) => d.status === 'pending' || d.status === 'refused')).toBe(true)
    // …and both are offered to the sender again.
    expect(useCodeStore.getState().takePendingDecisions().map((d) => d.path).sort()).toEqual(['A.cs', 'B.cs'])
  })

  it('an acknowledged keep is what finally shows the run’s version without a diff', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('A.cs')
    openDiff('B.cs')
    useCodeStore.getState().resolveDiff('A.cs', true)
    useCodeStore.getState().resolveDiff('B.cs', true)
    const sent = useCodeStore.getState().takePendingDecisions()

    useCodeStore.getState().settleDecisions({
      reviewId: 'run-1',
      applied: ['A.cs', 'B.cs'],
      revisions: Object.fromEntries(sent.map((d) => [d.path, d.revision])),
    })

    for (const path of ['A.cs', 'B.cs']) {
      const tab = useCodeStore.getState().tabs.find((t) => t.path === path)!
      expect(tab.isDiff).toBe(false)
      expect(tab.content).toBe('run version')
      expect(tab.originalContent).toBeUndefined()
      expect(tab.modifiedContent).toBeUndefined()
    }
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
  })
})
