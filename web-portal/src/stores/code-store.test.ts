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
    expect(state.touchedFiles.size).toBe(0)
  })

  it('markTouched sets file status', () => {
    useCodeStore.getState().markTouched('src/index.ts', 'modified')
    expect(useCodeStore.getState().touchedFiles.get('src/index.ts')).toBe('modified')
  })

  it('markTouched overwrites previous status', () => {
    useCodeStore.getState().markTouched('src/app.ts', 'new')
    expect(useCodeStore.getState().touchedFiles.get('src/app.ts')).toBe('new')

    useCodeStore.getState().markTouched('src/app.ts', 'deleted')
    expect(useCodeStore.getState().touchedFiles.get('src/app.ts')).toBe('deleted')
  })

  it('reset clears touchedFiles', () => {
    useCodeStore.getState().markTouched('a.ts', 'modified')
    useCodeStore.getState().markTouched('b.ts', 'new')
    expect(useCodeStore.getState().touchedFiles.size).toBe(2)

    useCodeStore.getState().reset()
    expect(useCodeStore.getState().touchedFiles.size).toBe(0)
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
