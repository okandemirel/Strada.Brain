import { describe, it, expect } from 'vitest'
import { shapesToNodes, connectionsToEdges, nodeChangeToStoreUpdate } from './use-canvas-bridge'

describe('use-canvas-bridge', () => {
  describe('shapesToNodes', () => {
    it('converts ResolvedShape to ReactFlow Node', () => {
      const nodes = shapesToNodes([{
        id: 'shape-1', type: 'task-card', x: 100, y: 200, w: 240, h: 130,
        props: { title: 'Test', status: 'pending' }, source: 'agent' as const,
      }])
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toMatchObject({
        id: 'shape-1', type: 'baseCard',
        position: { x: 100, y: 200 },
        style: { width: 240, height: 130 },
        data: { cardType: 'task-card', props: { title: 'Test', status: 'pending' }, source: 'agent' },
      })
    })

    it('filters out connection-arrow shapes', () => {
      const nodes = shapesToNodes([{
        id: 'arrow-1', type: 'connection-arrow', x: 0, y: 0, w: 120, h: 40,
        props: { from: 'a', to: 'b' },
      }])
      expect(nodes).toHaveLength(0)
    })
  })

  describe('connectionsToEdges', () => {
    it('converts CanvasConnection to ReactFlow Edge', () => {
      const edges = connectionsToEdges([{ id: 'conn-1', from: 'shape-1', to: 'shape-2', label: 'depends on' }])
      expect(edges).toHaveLength(1)
      expect(edges[0]).toMatchObject({
        id: 'conn-1', source: 'shape-1', target: 'shape-2',
        type: 'gradientBezier', data: { label: 'depends on' },
      })
    })

    it('handles connections without labels', () => {
      const edges = connectionsToEdges([{ id: 'conn-1', from: 'a', to: 'b' }])
      expect(edges[0]!.data).toBeUndefined()
    })
  })

  describe('nodeChangeToStoreUpdate', () => {
    it('extracts position from node position change', () => {
      const update = nodeChangeToStoreUpdate({ id: 's1', type: 'position', position: { x: 300, y: 400 } })
      expect(update).toEqual({ id: 's1', x: 300, y: 400 })
    })

    it('extracts dimensions from node dimensions change', () => {
      const update = nodeChangeToStoreUpdate({ id: 's1', type: 'dimensions', dimensions: { width: 500, height: 300 } })
      expect(update).toEqual({ id: 's1', w: 500, h: 300 })
    })

    it('returns null for select changes', () => {
      const update = nodeChangeToStoreUpdate({ id: 's1', type: 'select', selected: true })
      expect(update).toBeNull()
    })
  })
})
