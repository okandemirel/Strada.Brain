import { describe, it, expect } from 'vitest'
import { applyLayout } from './layout-engine'
import type { Node, Edge } from '@xyflow/react'

const makeNode = (id: string, w = 240, h = 130, data: Record<string, unknown> = {}): Node => ({
  id,
  type: 'baseCard',
  position: { x: 0, y: 0 },
  style: { width: w, height: h },
  data: { cardType: 'task-card', props: {}, ...data },
})

const makeEdge = (id: string, source: string, target: string): Edge => ({
  id, source, target, type: 'gradientBezier',
})

describe('layout-engine', () => {
  describe('flow layout', () => {
    it('positions nodes left-to-right based on edges', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')]
      const edges = [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c')]
      const result = applyLayout(nodes, edges, 'flow')
      expect(result.nodes[0]!.position.x).toBeLessThan(result.nodes[1]!.position.x)
      expect(result.nodes[1]!.position.x).toBeLessThan(result.nodes[2]!.position.x)
    })

    it('handles nodes without edges', () => {
      const nodes = [makeNode('a'), makeNode('b')]
      const result = applyLayout(nodes, [], 'flow')
      expect(result.nodes).toHaveLength(2)
      for (const n of result.nodes) {
        expect(Number.isFinite(n.position.x)).toBe(true)
        expect(Number.isFinite(n.position.y)).toBe(true)
      }
    })
  })

  describe('kanban layout', () => {
    it('groups task-cards by status into columns', () => {
      const nodes = [
        makeNode('a', 240, 130, { cardType: 'task-card', props: { status: 'pending' } }),
        makeNode('b', 240, 130, { cardType: 'task-card', props: { status: 'completed' } }),
        makeNode('c', 240, 130, { cardType: 'task-card', props: { status: 'pending' } }),
      ]
      const result = applyLayout(nodes, [], 'kanban')
      const ax = result.nodes.find((n) => n.id === 'a')!.position.x
      const bx = result.nodes.find((n) => n.id === 'b')!.position.x
      const cx = result.nodes.find((n) => n.id === 'c')!.position.x
      expect(ax).toBe(cx)
      expect(ax).not.toBe(bx)
    })
  })

  describe('freeform layout', () => {
    it('arranges overlapping nodes in collision-free grid', () => {
      const nodes = [
        { ...makeNode('a'), position: { x: 0, y: 0 } },
        { ...makeNode('b'), position: { x: 0, y: 0 } },
        { ...makeNode('c'), position: { x: 0, y: 0 } },
      ]
      const result = applyLayout(nodes, [], 'freeform')
      const positions = result.nodes.map((n) => `${n.position.x},${n.position.y}`)
      expect(new Set(positions).size).toBe(3)
    })

    it('preserves positions of non-overlapping nodes', () => {
      const nodes = [
        { ...makeNode('a'), position: { x: 0, y: 0 } },
        { ...makeNode('b'), position: { x: 500, y: 500 } },
      ]
      const result = applyLayout(nodes, [], 'freeform')
      expect(result.nodes[0]!.position).toEqual({ x: 0, y: 0 })
      expect(result.nodes[1]!.position).toEqual({ x: 500, y: 500 })
    })

    it('returns empty arrays for empty input', () => {
      const result = applyLayout([], [], 'freeform')
      expect(result.nodes).toHaveLength(0)
    })
  })
})
