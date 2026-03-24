import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  type TLBaseShape,
} from 'tldraw'

import './canvas-styles.css'

/** Renders a small "AI" badge when source is 'agent'. */
export function AiBadge({ source }: { source?: string }) {
  if (source !== 'agent') return null
  return <span className="strada-ai-badge">AI</span>
}

// ---------------------------------------------------------------------------
// Shape type identifiers
// ---------------------------------------------------------------------------

export const SHAPE_TYPES = {
  codeBlock: 'code-block',
  diffBlock: 'diff-block',
  fileCard: 'file-card',
  diagramNode: 'diagram-node',
  terminalBlock: 'terminal-block',
  imageBlock: 'image-block',
  taskCard: 'task-card',
  noteBlock: 'note-block',
  connectionArrow: 'connection-arrow',
} as const

// ---------------------------------------------------------------------------
// Shape type definitions
// ---------------------------------------------------------------------------

type CodeBlockShape = TLBaseShape<
  typeof SHAPE_TYPES.codeBlock,
  { w: number; h: number; code: string; language: string; title: string; source?: string }
>

type DiffBlockShape = TLBaseShape<
  typeof SHAPE_TYPES.diffBlock,
  { w: number; h: number; diff: string; filePath: string; source?: string }
>

type FileCardShape = TLBaseShape<
  typeof SHAPE_TYPES.fileCard,
  { w: number; h: number; filePath: string; language: string; lineCount: number; source?: string }
>

type DiagramNodeShape = TLBaseShape<
  typeof SHAPE_TYPES.diagramNode,
  { w: number; h: number; label: string; nodeType: string; status: string; source?: string }
>

type TerminalBlockShape = TLBaseShape<
  typeof SHAPE_TYPES.terminalBlock,
  { w: number; h: number; command: string; output: string; source?: string }
>

type ImageBlockShape = TLBaseShape<
  typeof SHAPE_TYPES.imageBlock,
  { w: number; h: number; src: string; alt: string; source?: string }
>

type TaskCardShape = TLBaseShape<
  typeof SHAPE_TYPES.taskCard,
  { w: number; h: number; title: string; status: string; priority: string; source?: string }
>

type NoteBlockShape = TLBaseShape<
  typeof SHAPE_TYPES.noteBlock,
  { w: number; h: number; content: string; color: string; source?: string }
>

type ConnectionArrowShape = TLBaseShape<
  typeof SHAPE_TYPES.connectionArrow,
  { w: number; h: number; label: string; source?: string }
>

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const baseContainerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  borderRadius: 8,
  overflow: 'hidden',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 13,
  pointerEvents: 'all',
}

// ---------------------------------------------------------------------------
// CodeBlockShapeUtil
// ---------------------------------------------------------------------------

export class CodeBlockShapeUtil extends BaseBoxShapeUtil<CodeBlockShape> {
  static override type = SHAPE_TYPES.codeBlock as string
  static override props = {
    w: T.number,
    h: T.number,
    code: T.string,
    language: T.string,
    title: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): CodeBlockShape['props'] {
    return { w: 400, h: 240, code: '', language: 'typescript', title: 'Untitled', source: undefined }
  }

  component(shape: CodeBlockShape) {
    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <AiBadge source={shape.props.source} />
          <div
            style={{
              padding: '6px 10px',
              background: '#181825',
              color: '#cdd6f4',
              fontSize: 11,
              borderBottom: '1px solid #45475a',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>{shape.props.title}</span>
            <span style={{ color: '#a6adc8' }}>{shape.props.language}</span>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: 10,
              color: '#cdd6f4',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {shape.props.code}
          </pre>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: CodeBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// DiffBlockShapeUtil
// ---------------------------------------------------------------------------

export class DiffBlockShapeUtil extends BaseBoxShapeUtil<DiffBlockShape> {
  static override type = SHAPE_TYPES.diffBlock as string
  static override props = {
    w: T.number,
    h: T.number,
    diff: T.string,
    filePath: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): DiffBlockShape['props'] {
    return { w: 420, h: 260, diff: '', filePath: '', source: undefined }
  }

  component(shape: DiffBlockShape) {
    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <AiBadge source={shape.props.source} />
          <div
            style={{
              padding: '6px 10px',
              background: '#181825',
              color: '#a6adc8',
              fontSize: 11,
              borderBottom: '1px solid #45475a',
            }}
          >
            {shape.props.filePath || 'diff'}
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: 10,
              color: '#cdd6f4',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {shape.props.diff}
          </pre>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: DiffBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// DiagramNodeShapeUtil
// ---------------------------------------------------------------------------

export class DiagramNodeShapeUtil extends BaseBoxShapeUtil<DiagramNodeShape> {
  static override type = SHAPE_TYPES.diagramNode as string
  static override props = {
    w: T.number,
    h: T.number,
    label: T.string,
    nodeType: T.string,
    status: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): DiagramNodeShape['props'] {
    return { w: 180, h: 80, label: 'Node', nodeType: 'default', status: 'idle', source: undefined }
  }

  component(shape: DiagramNodeShape) {
    const statusColor: Record<string, string> = {
      idle: '#6c7086',
      active: '#a6e3a1',
      error: '#f38ba8',
      pending: '#f9e2af',
    }
    const dotColor = statusColor[shape.props.status] ?? '#6c7086'

    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <AiBadge source={shape.props.source} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: dotColor,
              }}
            />
            <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 13 }}>
              {shape.props.label}
            </span>
          </div>
          <span style={{ color: '#a6adc8', fontSize: 11 }}>{shape.props.nodeType}</span>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: DiagramNodeShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// NoteBlockShapeUtil
// ---------------------------------------------------------------------------

export class NoteBlockShapeUtil extends BaseBoxShapeUtil<NoteBlockShape> {
  static override type = SHAPE_TYPES.noteBlock as string
  static override props = {
    w: T.number,
    h: T.number,
    content: T.string,
    color: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): NoteBlockShape['props'] {
    return { w: 240, h: 160, content: '', color: '#f9e2af', source: undefined }
  }

  component(shape: NoteBlockShape) {
    const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(shape.props.color) ? shape.props.color : '#f9e2af'
    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: safeColor + '22',
            border: `1px solid ${safeColor}66`,
            padding: 12,
            color: '#cdd6f4',
            lineHeight: 1.5,
          }}
        >
          <AiBadge source={shape.props.source} />
          {shape.props.content}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: NoteBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// TerminalBlockShapeUtil
// ---------------------------------------------------------------------------

export class TerminalBlockShapeUtil extends BaseBoxShapeUtil<TerminalBlockShape> {
  static override type = SHAPE_TYPES.terminalBlock as string
  static override props = {
    w: T.number,
    h: T.number,
    command: T.string,
    output: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): TerminalBlockShape['props'] {
    return { w: 420, h: 200, command: '', output: '', source: undefined }
  }

  component(shape: TerminalBlockShape) {
    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#11111b',
            border: '1px solid #45475a',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <AiBadge source={shape.props.source} />
          <div
            style={{
              padding: '6px 10px',
              background: '#181825',
              color: '#a6adc8',
              fontSize: 11,
              borderBottom: '1px solid #313244',
              display: 'flex',
              gap: 6,
            }}
          >
            <span style={{ color: '#f38ba8' }}>{'>'}</span>
            <span style={{ color: '#cdd6f4' }}>{shape.props.command}</span>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: 10,
              color: '#a6adc8',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {shape.props.output}
          </pre>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: TerminalBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// FileCardShapeUtil
// ---------------------------------------------------------------------------

export class FileCardShapeUtil extends BaseBoxShapeUtil<FileCardShape> {
  static override type = SHAPE_TYPES.fileCard as string
  static override props = {
    w: T.number,
    h: T.number,
    filePath: T.string,
    language: T.string,
    lineCount: T.number,
    source: T.string.optional(),
  }

  override getDefaultProps(): FileCardShape['props'] {
    return { w: 240, h: 100, filePath: '', language: '', lineCount: 0, source: undefined }
  }

  component(shape: FileCardShape) {
    const filename = shape.props.filePath.split('/').pop() ?? shape.props.filePath

    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <AiBadge source={shape.props.source} />
          <span style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>{filename}</span>
          <span style={{ color: '#a6adc8', fontSize: 11 }}>{shape.props.filePath}</span>
          <div style={{ display: 'flex', gap: 12, color: '#6c7086', fontSize: 11 }}>
            <span>{shape.props.language}</span>
            <span>{shape.props.lineCount} lines</span>
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: FileCardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// ImageBlockShapeUtil
// ---------------------------------------------------------------------------

export class ImageBlockShapeUtil extends BaseBoxShapeUtil<ImageBlockShape> {
  static override type = SHAPE_TYPES.imageBlock as string
  static override props = {
    w: T.number,
    h: T.number,
    src: T.string,
    alt: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): ImageBlockShape['props'] {
    return { w: 320, h: 240, src: '', alt: '', source: undefined }
  }

  component(shape: ImageBlockShape) {
    const safeSrc = /^(data:image\/|blob:)/.test(shape.props.src) ? shape.props.src : ''
    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AiBadge source={shape.props.source} />
          {safeSrc ? (
            <img
              src={safeSrc}
              alt={shape.props.alt}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          ) : (
            <span style={{ color: '#6c7086' }}>{shape.props.alt || 'No image'}</span>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ImageBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// TaskCardShapeUtil
// ---------------------------------------------------------------------------

export class TaskCardShapeUtil extends BaseBoxShapeUtil<TaskCardShape> {
  static override type = SHAPE_TYPES.taskCard as string
  static override props = {
    w: T.number,
    h: T.number,
    title: T.string,
    status: T.string,
    priority: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): TaskCardShape['props'] {
    return { w: 240, h: 120, title: 'Task', status: 'todo', priority: 'medium', source: undefined }
  }

  component(shape: TaskCardShape) {
    const priorityColor: Record<string, string> = {
      low: '#a6e3a1',
      medium: '#f9e2af',
      high: '#fab387',
      critical: '#f38ba8',
    }
    const barColor = priorityColor[shape.props.priority] ?? '#6c7086'

    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <AiBadge source={shape.props.source} />
          <div style={{ height: 3, background: barColor }} />
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 13 }}>
              {shape.props.title}
            </span>
            <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
              <span
                style={{
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: '#313244',
                  color: '#cdd6f4',
                }}
              >
                {shape.props.status}
              </span>
              <span style={{ color: barColor }}>{shape.props.priority}</span>
            </div>
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: TaskCardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ---------------------------------------------------------------------------
// ConnectionArrowShapeUtil (placeholder — renders as a labeled box for now)
// ---------------------------------------------------------------------------

export class ConnectionArrowShapeUtil extends BaseBoxShapeUtil<ConnectionArrowShape> {
  static override type = SHAPE_TYPES.connectionArrow as string
  static override props = {
    w: T.number,
    h: T.number,
    label: T.string,
    source: T.string.optional(),
  }

  override getDefaultProps(): ConnectionArrowShape['props'] {
    return { w: 120, h: 40, label: '', source: undefined }
  }

  component(shape: ConnectionArrowShape) {
    return (
      <HTMLContainer>
        <div
          style={{
            ...baseContainerStyle,
            background: '#31324433',
            border: '1px dashed #45475a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#a6adc8',
            fontSize: 11,
          }}
        >
          <AiBadge source={shape.props.source} />
          {shape.props.label || '---'}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ConnectionArrowShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={4} />
  }
}

// ---------------------------------------------------------------------------
// Aggregated array of all custom shape utils for registration
// ---------------------------------------------------------------------------

export const customShapeUtils = [
  CodeBlockShapeUtil,
  DiffBlockShapeUtil,
  FileCardShapeUtil,
  DiagramNodeShapeUtil,
  TerminalBlockShapeUtil,
  ImageBlockShapeUtil,
  TaskCardShapeUtil,
  NoteBlockShapeUtil,
  ConnectionArrowShapeUtil,
] as const
