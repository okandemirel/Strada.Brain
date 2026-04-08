import type { CanvasShape } from '../../stores/canvas-store'
import type { CanvasConnection } from './canvas-types'
import { getDefaultDimensions } from './canvas-types'

type RawCanvasShape = {
  type?: string
  id: string
  props?: Record<string, unknown>
  position?: { x: number; y: number }
  source?: 'agent' | 'user'
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function asPosition(
  position: RawCanvasShape['position'],
): { x: number; y: number } | undefined {
  if (!position) return undefined
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return undefined
  return { x: position.x, y: position.y }
}

function withSource(
  props: Record<string, unknown>,
  source: RawCanvasShape['source'],
): Record<string, unknown> {
  return source ? { ...props, source } : props
}

export function normalizeCanvasIncomingShape(shape: RawCanvasShape): CanvasShape | null {
  if (!shape.id) return null

  const props = asRecord(shape.props)
  const source = shape.source
  const position = asPosition(shape.position)

  let type = shape.type
  let normalizedProps: Record<string, unknown>

  const dims = getDefaultDimensions(shape.type ?? 'note-block')

  switch (shape.type) {
    case 'diagram-node':
      if (typeof props.content === 'string' && !('label' in props)) {
        type = 'code-block'
        const codeDims = getDefaultDimensions('code-block')
        normalizedProps = withSource({
          w: asNumber(props.w, codeDims.w),
          h: asNumber(props.h, codeDims.h),
          code: props.content,
          language: asString(props.language, 'mermaid'),
          title: asString(props.title, 'Generated diagram'),
        }, source)
        break
      }
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        label: asString(props.label, asString(props.title, 'Diagram')),
        nodeType: asString(props.nodeType, 'diagram'),
        status: asString(props.status, 'active'),
      }, source)
      break

    case 'diff-block':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        diff: asString(props.diff, asString(props.content, '')),
        filePath: asString(props.filePath, asString(props.title, 'Generated diff')),
      }, source)
      break

    case 'code-block':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        code: asString(props.code, asString(props.content, '')),
        language: asString(props.language, 'text'),
        title: asString(props.title, 'Snippet'),
      }, source)
      break

    case 'task-card':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        title: asString(props.title, 'Task'),
        status: asString(props.status, 'pending'),
        priority: asString(props.priority, 'medium'),
      }, source)
      break

    case 'note-block':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        content: asString(props.content, ''),
        color: asString(props.color, '#7dd3fc'),
      }, source)
      break

    case 'terminal-block':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        command: asString(props.command, asString(props.title, 'Command')),
        output: asString(props.output, asString(props.content, '')),
      }, source)
      break

    case 'file-card':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        filePath: asString(props.filePath, asString(props.title, 'Unknown file')),
        language: asString(props.language, 'text'),
        lineCount: asNumber(props.lineCount, 0),
      }, source)
      break

    case 'image-block':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        src: asString(props.src, ''),
        alt: asString(props.alt, 'Image'),
      }, source)
      break

    case 'goal-summary':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        title: asString(props.title, 'Goal'),
        taskCount: asNumber(props.taskCount, 0),
        completedCount: asNumber(props.completedCount, 0),
        failedCount: asNumber(props.failedCount, 0),
        executingCount: asNumber(props.executingCount, 0),
        skippedCount: asNumber(props.skippedCount, 0),
      }, source)
      break

    case 'error-card':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        message: asString(props.message, asString(props.title, 'Error')),
        stack: asString(props.stack, asString(props.content, '')),
        severity: asString(props.severity, 'error'),
      }, source)
      break

    case 'test-result':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        passed: asNumber(props.passed, 0),
        failed: asNumber(props.failed, 0),
        skipped: asNumber(props.skipped, 0),
        coverage: asNumber(props.coverage, 0),
        failedTests: Array.isArray(props.failedTests) ? props.failedTests.map(String) : [],
      }, source)
      break

    case 'link-card': {
      const rawUrl = asString(props.url, '')
      const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        url: safeUrl,
        title: asString(props.title, 'Link'),
        description: asString(props.description, ''),
      }, source)
      break
    }

    case 'metric-card':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        label: asString(props.label, 'Metric'),
        value: typeof props.value === 'number' ? props.value : asNumber(props.value, 0),
        unit: asString(props.unit, ''),
        trend: asString(props.trend, ''),
      }, source)
      break

    case 'connection-arrow':
      normalizedProps = withSource({
        w: asNumber(props.w, dims.w),
        h: asNumber(props.h, dims.h),
        label: asString(props.label, ''),
      }, source)
      break

    default:
      normalizedProps = withSource(props, source)
      break
  }

  return {
    id: shape.id,
    ...(type ? { type } : {}),
    props: normalizedProps,
    ...(source ? { source } : {}),
    ...(position ? { position } : {}),
  }
}

export function normalizeCanvasIncomingShapes(shapes: RawCanvasShape[]): CanvasShape[] {
  return shapes
    .map((shape) => normalizeCanvasIncomingShape(shape))
    .filter((shape): shape is CanvasShape => Boolean(shape))
}

export function normalizeCanvasConnection(raw: { id?: string; from?: string; to?: string; label?: string }): CanvasConnection | null {
  if (!raw.from || !raw.to) return null
  return {
    id: raw.id ?? `conn-${raw.from}-${raw.to}`,
    from: raw.from,
    to: raw.to,
    label: raw.label,
  }
}
