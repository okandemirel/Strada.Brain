import type { ComponentType } from 'react'
import { lazy } from 'react'

export interface RendererProps {
  type: string
  props: Record<string, unknown>
}

const TextContentRenderer = lazy(() => import('./renderers/TextContentRenderer'))
const CodeContentRenderer = lazy(() => import('./renderers/CodeContentRenderer'))
const StatusContentRenderer = lazy(() => import('./renderers/StatusContentRenderer'))
const DataContentRenderer = lazy(() => import('./renderers/DataContentRenderer'))
const MediaContentRenderer = lazy(() => import('./renderers/MediaContentRenderer'))

export const CARD_RENDERERS: Record<string, ComponentType<RendererProps>> = {
  'note-block': TextContentRenderer,
  'goal-summary': TextContentRenderer,
  'link-card': TextContentRenderer,
  'code-block': CodeContentRenderer,
  'diff-block': CodeContentRenderer,
  'terminal-block': CodeContentRenderer,
  'task-card': StatusContentRenderer,
  'error-card': StatusContentRenderer,
  'test-result': StatusContentRenderer,
  'metric-card': DataContentRenderer,
  'diagram-node': DataContentRenderer,
  'image-block': MediaContentRenderer,
  'file-card': MediaContentRenderer,
}
