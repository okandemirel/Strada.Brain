import { describe, expect, it } from 'vitest'
import { normalizeCanvasIncomingShape } from './canvas-shape-normalizer'

describe('normalizeCanvasIncomingShape', () => {
  it('rewrites legacy diagram payloads into code blocks', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'diagram-1',
      type: 'diagram-node',
      source: 'agent',
      props: {
        content: '```mermaid\ngraph TD\nA-->B\n```',
        language: 'mermaid',
      },
    })

    expect(normalized).toMatchObject({
      id: 'diagram-1',
      type: 'code-block',
      source: 'agent',
      props: {
        code: '```mermaid\ngraph TD\nA-->B\n```',
        language: 'mermaid',
        title: 'Generated diagram',
        source: 'agent',
      },
    })
  })

  it('fills diff block defaults for legacy content payloads', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'diff-1',
      type: 'diff-block',
      source: 'agent',
      props: {
        content: '@@ -1,2 +1,2 @@\n-old\n+new',
      },
    })

    expect(normalized).toMatchObject({
      id: 'diff-1',
      type: 'diff-block',
      props: {
        diff: '@@ -1,2 +1,2 @@\n-old\n+new',
        filePath: 'Generated diff',
      },
    })
  })

  it('preserves valid task-card payloads', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'task-1',
      type: 'task-card',
      source: 'agent',
      props: {
        w: 240,
        h: 100,
        title: 'Inventory editors',
        status: 'active',
        priority: 'high',
      },
      position: { x: 20, y: 40 },
    })

    expect(normalized).toMatchObject({
      id: 'task-1',
      type: 'task-card',
      position: { x: 20, y: 40 },
      props: {
        w: 240,
        h: 100,
        title: 'Inventory editors',
        status: 'active',
        priority: 'high',
        source: 'agent',
      },
    })
  })
})
