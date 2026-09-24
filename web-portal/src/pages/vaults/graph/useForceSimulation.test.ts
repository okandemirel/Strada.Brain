import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useForceSimulation } from './useForceSimulation'
import type { GraphNode } from './graph-types'

const originalWorker = globalThis.Worker

const node = (id: string): GraphNode => ({ id, label: id, kind: null, color: '#fff', val: 1, file: null, line: null })

// WEB-4: a browser that refuses the worker synchronously (a CSP block) made
// the lifecycle effect throw, which took the graph panel into its error
// boundary instead of leaving a still minimap.
describe('useForceSimulation when the worker cannot be created (WEB-4)', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', { value: originalWorker, configurable: true, writable: true })
    vi.restoreAllMocks()
  })

  it('renders without a simulation instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.defineProperty(globalThis, 'Worker', {
      value: class {
        constructor() {
          throw new DOMException('blocked by CSP', 'SecurityError')
        }
      },
      configurable: true,
      writable: true,
    })

    const { result } = renderHook(() => useForceSimulation({ nodes: [node('a'), node('b')], links: [{ source: 'a', target: 'b' }] }))
    expect(result.current.running).toBe(false)
    expect(result.current.getPosition('a')).toBeUndefined()
  })
})
