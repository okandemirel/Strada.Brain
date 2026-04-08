/** A connection between two cards on the canvas */
export interface CanvasConnection {
  id: string
  from: string
  to: string
  label?: string
}

/** Internal canvas shape with resolved position */
export interface ResolvedShape {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  props: Record<string, unknown>
  source?: 'agent' | 'user'
}

/** Viewport state for the canvas */
export interface ViewportState {
  x: number
  y: number
  zoom: number
}

/** Get default dimensions for a card type */
const DEFAULT_DIMENSIONS: Record<string, { w: number; h: number }> = {
    'code-block': { w: 400, h: 240 },
    'diff-block': { w: 420, h: 260 },
    'file-card': { w: 240, h: 100 },
    'diagram-node': { w: 200, h: 100 },
    'terminal-block': { w: 420, h: 200 },
    'image-block': { w: 320, h: 240 },
    'task-card': { w: 240, h: 130 },
    'note-block': { w: 280, h: 160 },
    'goal-summary': { w: 340, h: 200 },
    'error-card': { w: 400, h: 220 },
    'test-result': { w: 300, h: 180 },
    'link-card': { w: 300, h: 120 },
    'metric-card': { w: 200, h: 140 },
  'connection-arrow': { w: 120, h: 40 },
}

export function getDefaultDimensions(type: string): { w: number; h: number } {
  return DEFAULT_DIMENSIONS[type] ?? { w: 240, h: 120 }
}

import type { Node, Edge } from '@xyflow/react'

/** ReactFlow node carrying a canvas shape's data. */
export interface CanvasNode extends Node {
  type: 'baseCard'
  data: {
    cardType: string
    props: Record<string, unknown>
    source?: 'agent' | 'user'
  }
}

/** ReactFlow edge carrying a canvas connection's data. */
export interface CanvasEdge extends Edge {
  type: 'gradientBezier'
  data?: {
    label?: string
  }
}

/** Layout modes for the canvas workspace. */
export type LayoutMode = 'flow' | 'kanban' | 'freeform'
