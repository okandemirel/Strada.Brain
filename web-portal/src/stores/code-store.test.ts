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

  it('resolveDiff with accepted=true updates content to modifiedContent', () => {
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
    expect(tab.content).toBe('modified code')
  })

  it('resolveDiff with accepted=false keeps original content', () => {
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
  })

  it('resolveDiff clears diff fields (isDiff, diffContent, originalContent, modifiedContent)', () => {
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

  it('rejecting a diff puts the original content back on screen', () => {
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    expect(useCodeStore.getState().tabs[0].content).toBe('my version')
  })

  it('accepting queues a keep decision and shows the modified content', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', true)
    expect(useCodeStore.getState().tabs[0].content).toBe('run version')
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

  it('takePendingDecisions hands them over once and empties the queue', () => {
    useCodeStore.getState().setChangeReview(review)
    openDiff('src/ready.ts')
    openDiff('src/mine.ts')
    useCodeStore.getState().resolveDiff('src/ready.ts', false)
    useCodeStore.getState().resolveDiff('src/mine.ts', true)

    const taken = useCodeStore.getState().takePendingDecisions()
    expect(taken.map((d) => d.path)).toEqual(['src/ready.ts', 'src/mine.ts'])
    expect(useCodeStore.getState().pendingDecisions).toEqual([])
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
