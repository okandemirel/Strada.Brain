import { describe, it, expect, vi } from 'vitest'

// Mock tldraw with minimal stubs so custom-shapes.tsx can be loaded in jsdom
vi.mock('tldraw', () => {
  class MockBaseBoxShapeUtil {
    static type = ''
    static props = {}
    getDefaultProps() { return {} }
    component() { return null }
    indicator() { return null }
  }

  return {
    BaseBoxShapeUtil: MockBaseBoxShapeUtil,
    HTMLContainer: ({ children }: { children: unknown }) => children,
    T: {
      string: { validate: (v: unknown) => typeof v === 'string' },
      number: { validate: (v: unknown) => typeof v === 'number' },
    },
  }
})

import {
  SHAPE_TYPES,
  customShapeUtils,
  CodeBlockShapeUtil,
  DiffBlockShapeUtil,
  DiagramNodeShapeUtil,
  NoteBlockShapeUtil,
  TerminalBlockShapeUtil,
  FileCardShapeUtil,
  ImageBlockShapeUtil,
  TaskCardShapeUtil,
  ConnectionArrowShapeUtil,
} from './custom-shapes'

describe('SHAPE_TYPES', () => {
  it('defines 9 shape type identifiers', () => {
    expect(Object.keys(SHAPE_TYPES)).toHaveLength(9)
  })

  it('uses kebab-case identifiers', () => {
    for (const value of Object.values(SHAPE_TYPES)) {
      expect(value).toMatch(/^[a-z]+-[a-z]+$/)
    }
  })
})

describe('customShapeUtils', () => {
  it('exports 9 shape util classes', () => {
    expect(customShapeUtils).toHaveLength(9)
  })

  it('each util has a static type matching SHAPE_TYPES', () => {
    const expectedTypes = new Set<string>(Object.values(SHAPE_TYPES))
    for (const Util of customShapeUtils) {
      expect(expectedTypes.has(Util.type)).toBe(true)
    }
  })

  it('each util has static props defined', () => {
    for (const Util of customShapeUtils) {
      expect(Util.props).toBeDefined()
      expect(typeof Util.props).toBe('object')
    }
  })
})

describe('Individual shape utils', () => {
  const utilClasses = [
    { Util: CodeBlockShapeUtil, type: 'code-block', propKeys: ['w', 'h', 'code', 'language', 'title'] },
    { Util: DiffBlockShapeUtil, type: 'diff-block', propKeys: ['w', 'h', 'diff', 'filePath'] },
    { Util: DiagramNodeShapeUtil, type: 'diagram-node', propKeys: ['w', 'h', 'label', 'nodeType', 'status'] },
    { Util: NoteBlockShapeUtil, type: 'note-block', propKeys: ['w', 'h', 'content', 'color'] },
    { Util: TerminalBlockShapeUtil, type: 'terminal-block', propKeys: ['w', 'h', 'command', 'output'] },
    { Util: FileCardShapeUtil, type: 'file-card', propKeys: ['w', 'h', 'filePath', 'language', 'lineCount'] },
    { Util: ImageBlockShapeUtil, type: 'image-block', propKeys: ['w', 'h', 'src', 'alt'] },
    { Util: TaskCardShapeUtil, type: 'task-card', propKeys: ['w', 'h', 'title', 'status', 'priority'] },
    { Util: ConnectionArrowShapeUtil, type: 'connection-arrow', propKeys: ['w', 'h', 'label'] },
  ]

  for (const { Util, type, propKeys } of utilClasses) {
    describe(type, () => {
      it(`has static type "${type}"`, () => {
        expect(Util.type).toBe(type)
      })

      it('declares all expected prop validators', () => {
        const keys = Object.keys(Util.props ?? {})
        for (const key of propKeys) {
          expect(keys).toContain(key)
        }
      })
    })
  }
})
