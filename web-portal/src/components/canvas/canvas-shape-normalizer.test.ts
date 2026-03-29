import { describe, expect, it } from 'vitest'
import { normalizeCanvasIncomingShape, normalizeCanvasConnection } from './canvas-shape-normalizer'

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

  it('returns null for shapes without an id', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: '',
      type: 'code-block',
      props: { code: 'test' },
    })
    expect(normalized).toBeNull()
  })

  // -- goal-summary ---------------------------------------------------------

  it('normalizes goal-summary with all fields', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'gs-1',
      type: 'goal-summary',
      source: 'agent',
      props: {
        title: 'Deploy v2',
        taskCount: 8,
        completedCount: 5,
        failedCount: 1,
        executingCount: 2,
        skippedCount: 0,
      },
    })

    expect(normalized).toMatchObject({
      id: 'gs-1',
      type: 'goal-summary',
      source: 'agent',
      props: {
        w: 340,
        h: 200,
        title: 'Deploy v2',
        taskCount: 8,
        completedCount: 5,
        failedCount: 1,
        executingCount: 2,
        skippedCount: 0,
        source: 'agent',
      },
    })
  })

  it('fills goal-summary defaults for missing fields', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'gs-2',
      type: 'goal-summary',
      props: {},
    })

    expect(normalized).toMatchObject({
      id: 'gs-2',
      type: 'goal-summary',
      props: {
        title: 'Goal',
        taskCount: 0,
        completedCount: 0,
        failedCount: 0,
        executingCount: 0,
        skippedCount: 0,
      },
    })
  })

  // -- error-card -----------------------------------------------------------

  it('normalizes error-card with message and stack', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'ec-1',
      type: 'error-card',
      source: 'agent',
      props: {
        message: 'ECONNREFUSED',
        stack: 'Error: connect ECONNREFUSED\n    at TCPConnectWrap',
        severity: 'error',
      },
    })

    expect(normalized).toMatchObject({
      id: 'ec-1',
      type: 'error-card',
      props: {
        w: 400,
        h: 220,
        message: 'ECONNREFUSED',
        stack: 'Error: connect ECONNREFUSED\n    at TCPConnectWrap',
        severity: 'error',
        source: 'agent',
      },
    })
  })

  it('falls back to title for error-card message', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'ec-2',
      type: 'error-card',
      props: { title: 'Timeout' },
    })

    expect(normalized!.props.message).toBe('Timeout')
  })

  it('fills error-card defaults when props are empty', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'ec-3',
      type: 'error-card',
      props: {},
    })

    expect(normalized).toMatchObject({
      props: {
        message: 'Error',
        stack: '',
        severity: 'error',
      },
    })
  })

  // -- test-result ----------------------------------------------------------

  it('normalizes test-result with all counters', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'tr-1',
      type: 'test-result',
      source: 'agent',
      props: {
        passed: 42,
        failed: 3,
        skipped: 1,
        coverage: 87,
        failedTests: ['test_a', 'test_b'],
      },
    })

    expect(normalized).toMatchObject({
      id: 'tr-1',
      type: 'test-result',
      props: {
        w: 300,
        h: 180,
        passed: 42,
        failed: 3,
        skipped: 1,
        coverage: 87,
        failedTests: ['test_a', 'test_b'],
        source: 'agent',
      },
    })
  })

  it('fills test-result defaults when props are empty', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'tr-2',
      type: 'test-result',
      props: {},
    })

    expect(normalized).toMatchObject({
      props: {
        passed: 0,
        failed: 0,
        skipped: 0,
        coverage: 0,
        failedTests: [],
      },
    })
  })

  it('coerces non-array failedTests to empty array', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'tr-3',
      type: 'test-result',
      props: { failedTests: 'not-an-array' },
    })

    expect(normalized!.props.failedTests).toEqual([])
  })

  // -- link-card ------------------------------------------------------------

  it('normalizes link-card with url and description', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'lc-1',
      type: 'link-card',
      source: 'agent',
      props: {
        url: 'https://example.com/docs',
        title: 'API Reference',
        description: 'Full API documentation',
      },
    })

    expect(normalized).toMatchObject({
      id: 'lc-1',
      type: 'link-card',
      props: {
        w: 300,
        h: 120,
        url: 'https://example.com/docs',
        title: 'API Reference',
        description: 'Full API documentation',
        source: 'agent',
      },
    })
  })

  it('fills link-card defaults when props are empty', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'lc-2',
      type: 'link-card',
      props: {},
    })

    expect(normalized).toMatchObject({
      props: {
        url: '',
        title: 'Link',
        description: '',
      },
    })
  })

  // -- metric-card ----------------------------------------------------------

  it('normalizes metric-card with label, value, unit, trend', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'mc-1',
      type: 'metric-card',
      source: 'agent',
      props: {
        label: 'Latency p99',
        value: 42,
        unit: 'ms',
        trend: 'down',
      },
    })

    expect(normalized).toMatchObject({
      id: 'mc-1',
      type: 'metric-card',
      props: {
        w: 200,
        h: 140,
        label: 'Latency p99',
        value: 42,
        unit: 'ms',
        trend: 'down',
        source: 'agent',
      },
    })
  })

  it('fills metric-card defaults when props are empty', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'mc-2',
      type: 'metric-card',
      props: {},
    })

    expect(normalized).toMatchObject({
      props: {
        label: 'Metric',
        value: 0,
        unit: '',
        trend: '',
      },
    })
  })

  it('handles numeric value passed as number in metric-card', () => {
    const normalized = normalizeCanvasIncomingShape({
      id: 'mc-3',
      type: 'metric-card',
      props: { value: 99.5 },
    })

    expect(normalized!.props.value).toBe(99.5)
  })
})

// -- normalizeCanvasConnection ------------------------------------------------

describe('normalizeCanvasConnection', () => {
  it('returns a valid connection with auto-generated id', () => {
    const conn = normalizeCanvasConnection({ from: 'a', to: 'b' })
    expect(conn).toEqual({
      id: 'conn-a-b',
      from: 'a',
      to: 'b',
      label: undefined,
    })
  })

  it('preserves explicit id and label', () => {
    const conn = normalizeCanvasConnection({ id: 'custom-id', from: 'x', to: 'y', label: 'depends on' })
    expect(conn).toEqual({
      id: 'custom-id',
      from: 'x',
      to: 'y',
      label: 'depends on',
    })
  })

  it('returns null when from is missing', () => {
    expect(normalizeCanvasConnection({ to: 'b' })).toBeNull()
  })

  it('returns null when to is missing', () => {
    expect(normalizeCanvasConnection({ from: 'a' })).toBeNull()
  })

  it('returns null when both from and to are missing', () => {
    expect(normalizeCanvasConnection({})).toBeNull()
  })
})
