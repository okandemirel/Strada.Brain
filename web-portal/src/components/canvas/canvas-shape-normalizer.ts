import type { CanvasShape } from '../../stores/canvas-store'

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

  switch (shape.type) {
    case 'diagram-node':
      if (typeof props.content === 'string' && !('label' in props)) {
        type = 'code-block'
        normalizedProps = withSource({
          w: asNumber(props.w, 420),
          h: asNumber(props.h, 260),
          code: props.content,
          language: asString(props.language, 'mermaid'),
          title: asString(props.title, 'Generated diagram'),
        }, source)
        break
      }
      normalizedProps = withSource({
        w: asNumber(props.w, 220),
        h: asNumber(props.h, 120),
        label: asString(props.label, asString(props.title, 'Diagram')),
        nodeType: asString(props.nodeType, 'diagram'),
        status: asString(props.status, 'active'),
      }, source)
      break

    case 'diff-block':
      normalizedProps = withSource({
        w: asNumber(props.w, 420),
        h: asNumber(props.h, 260),
        diff: asString(props.diff, asString(props.content, '')),
        filePath: asString(props.filePath, asString(props.title, 'Generated diff')),
      }, source)
      break

    case 'code-block':
      normalizedProps = withSource({
        w: asNumber(props.w, 420),
        h: asNumber(props.h, 260),
        code: asString(props.code, asString(props.content, '')),
        language: asString(props.language, 'text'),
        title: asString(props.title, 'Snippet'),
      }, source)
      break

    case 'task-card':
      normalizedProps = withSource({
        w: asNumber(props.w, 220),
        h: asNumber(props.h, 120),
        title: asString(props.title, 'Task'),
        status: asString(props.status, 'pending'),
        priority: asString(props.priority, 'medium'),
      }, source)
      break

    case 'note-block':
      normalizedProps = withSource({
        w: asNumber(props.w, 320),
        h: asNumber(props.h, 180),
        content: asString(props.content, ''),
        color: asString(props.color, '#7dd3fc'),
      }, source)
      break

    case 'terminal-block':
      normalizedProps = withSource({
        w: asNumber(props.w, 420),
        h: asNumber(props.h, 240),
        command: asString(props.command, asString(props.title, 'Command')),
        output: asString(props.output, asString(props.content, '')),
      }, source)
      break

    case 'file-card':
      normalizedProps = withSource({
        w: asNumber(props.w, 260),
        h: asNumber(props.h, 120),
        filePath: asString(props.filePath, asString(props.title, 'Unknown file')),
        language: asString(props.language, 'text'),
        lineCount: asNumber(props.lineCount, 0),
      }, source)
      break

    case 'image-block':
      normalizedProps = withSource({
        w: asNumber(props.w, 280),
        h: asNumber(props.h, 200),
        src: asString(props.src, ''),
        alt: asString(props.alt, 'Image'),
      }, source)
      break

    case 'connection-arrow':
      normalizedProps = withSource({
        w: asNumber(props.w, 160),
        h: asNumber(props.h, 24),
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
