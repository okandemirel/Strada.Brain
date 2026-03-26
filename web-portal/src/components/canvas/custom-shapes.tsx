/* eslint-disable react-refresh/only-export-components */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  type TLBaseShape,
} from 'tldraw'

import './canvas-styles.css'

const uiFont = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'
const monoFont = '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
const primaryText = '#f5f7fb'
const secondaryText = '#97a1b5'
const tertiaryText = '#667085'
const panelRadius = 24

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
  borderRadius: panelRadius,
  overflow: 'hidden',
  fontFamily: uiFont,
  fontSize: 13,
  pointerEvents: 'all',
  position: 'relative',
}

function createPanelStyle({
  border,
  glow,
  background,
}: {
  border: string
  glow: string
  background?: string
}): React.CSSProperties {
  return {
    ...baseContainerStyle,
    background: background ?? 'linear-gradient(180deg, rgba(12, 18, 29, 0.98), rgba(8, 12, 20, 0.96))',
    border: `1px solid ${border}`,
    boxShadow: `0 18px 56px ${glow}`,
    backdropFilter: 'blur(18px)',
  }
}

function createHeaderStyle(borderColor: string): React.CSSProperties {
  return {
    padding: '12px 14px',
    borderBottom: `1px solid ${borderColor}`,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.01))',
  }
}

function createPillStyle({
  color,
  background,
  border,
}: {
  color: string
  background: string
  border: string
}): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    padding: '4px 9px',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color,
    background,
    border: `1px solid ${border}`,
  }
}

function createMonoBodyStyle(): React.CSSProperties {
  return {
    flex: 1,
    margin: 0,
    padding: 14,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 1.65,
    color: '#d7deea',
  }
}

function getSafeHexColor(color: string, fallback: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : fallback
}

function getStatusTone(status: string): { dot: string; background: string; border: string; label: string } {
  const tones: Record<string, { dot: string; background: string; border: string; label: string }> = {
    idle: {
      dot: '#94a3b8',
      background: 'rgba(148, 163, 184, 0.12)',
      border: 'rgba(148, 163, 184, 0.18)',
      label: '#cbd5e1',
    },
    active: {
      dot: '#34d399',
      background: 'rgba(52, 211, 153, 0.12)',
      border: 'rgba(52, 211, 153, 0.18)',
      label: '#a7f3d0',
    },
    error: {
      dot: '#f87171',
      background: 'rgba(248, 113, 113, 0.12)',
      border: 'rgba(248, 113, 113, 0.18)',
      label: '#fecaca',
    },
    pending: {
      dot: '#fbbf24',
      background: 'rgba(251, 191, 36, 0.12)',
      border: 'rgba(251, 191, 36, 0.18)',
      label: '#fde68a',
    },
  }
  return tones[status] ?? tones.idle
}

function getPriorityTone(priority: string): { bar: string; background: string; border: string; label: string } {
  const tones: Record<string, { bar: string; background: string; border: string; label: string }> = {
    low: {
      bar: '#34d399',
      background: 'rgba(52, 211, 153, 0.12)',
      border: 'rgba(52, 211, 153, 0.18)',
      label: '#a7f3d0',
    },
    medium: {
      bar: '#fbbf24',
      background: 'rgba(251, 191, 36, 0.12)',
      border: 'rgba(251, 191, 36, 0.18)',
      label: '#fde68a',
    },
    high: {
      bar: '#fb923c',
      background: 'rgba(251, 146, 60, 0.12)',
      border: 'rgba(251, 146, 60, 0.18)',
      label: '#fdba74',
    },
    critical: {
      bar: '#f87171',
      background: 'rgba(248, 113, 113, 0.12)',
      border: 'rgba(248, 113, 113, 0.18)',
      label: '#fecaca',
    },
  }
  return tones[priority] ?? tones.medium
}

function diffLineColor(line: string): string {
  if (line.startsWith('+')) return '#86efac'
  if (line.startsWith('-')) return '#fca5a5'
  if (line.startsWith('@')) return '#7dd3fc'
  return '#d7deea'
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
          style={createPanelStyle({
            border: 'rgba(125, 211, 252, 0.18)',
            glow: 'rgba(14, 165, 233, 0.12)',
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={createHeaderStyle('rgba(125, 211, 252, 0.12)')}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ ...createPillStyle({ color: '#bae6fd', background: 'rgba(125, 211, 252, 0.1)', border: 'rgba(125, 211, 252, 0.16)' }), marginBottom: 10 }}>
                  Code Surface
                </div>
                <div style={{ color: primaryText, fontSize: 16, fontWeight: 600, letterSpacing: '-0.03em' }}>
                  {shape.props.title}
                </div>
              </div>
              <span style={createPillStyle({ color: '#dbeafe', background: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)' })}>
                {shape.props.language}
              </span>
            </div>
          </div>
          <pre style={createMonoBodyStyle()}>{shape.props.code}</pre>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: CodeBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
          style={createPanelStyle({
            border: 'rgba(251, 191, 36, 0.16)',
            glow: 'rgba(251, 191, 36, 0.1)',
            background: 'linear-gradient(180deg, rgba(16, 17, 24, 0.98), rgba(12, 12, 18, 0.96))',
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={createHeaderStyle('rgba(251, 191, 36, 0.12)')}>
            <div style={createPillStyle({ color: '#fde68a', background: 'rgba(251, 191, 36, 0.1)', border: 'rgba(251, 191, 36, 0.16)' })}>
              Review Diff
            </div>
            <div style={{ marginTop: 10, color: primaryText, fontSize: 15, fontWeight: 600, letterSpacing: '-0.03em' }}>
              {shape.props.filePath || 'diff'}
            </div>
          </div>
          <div style={{ ...createMonoBodyStyle(), paddingTop: 12 }}>
            {shape.props.diff.split('\n').map((line, index) => (
              <div key={`${shape.id}-diff-${index}`} style={{ color: diffLineColor(line), minHeight: 20 }}>
                {line || ' '}
              </div>
            ))}
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: DiffBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
    const tone = getStatusTone(shape.props.status)

    return (
      <HTMLContainer>
        <div
          style={createPanelStyle({
            border: tone.border,
            glow: `${tone.dot}22`,
            background: 'linear-gradient(180deg, rgba(14, 19, 29, 0.98), rgba(8, 12, 19, 0.96))',
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={{ display: 'flex', height: '100%', flexDirection: 'column', justifyContent: 'space-between', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span style={createPillStyle({ color: tone.label, background: tone.background, border: tone.border })}>
                {shape.props.status}
              </span>
              <span style={{ fontSize: 10, color: tertiaryText, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
                {shape.props.nodeType}
              </span>
            </div>
            <div style={{ color: primaryText, fontSize: 18, fontWeight: 600, letterSpacing: '-0.04em' }}>
              {shape.props.label}
            </div>
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: DiagramNodeShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
    const safeColor = getSafeHexColor(shape.props.color, '#fbbf24')

    return (
      <HTMLContainer>
        <div
          style={createPanelStyle({
            border: `${safeColor}44`,
            glow: `${safeColor}18`,
            background: `linear-gradient(180deg, ${safeColor}18, rgba(17, 14, 9, 0.92))`,
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={{ padding: 16 }}>
            <div style={createPillStyle({ color: safeColor, background: `${safeColor}12`, border: `${safeColor}33` })}>
              Review Note
            </div>
            <div style={{ marginTop: 14, color: primaryText, fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {shape.props.content}
            </div>
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: NoteBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
          style={createPanelStyle({
            border: 'rgba(52, 211, 153, 0.16)',
            glow: 'rgba(52, 211, 153, 0.1)',
            background: 'linear-gradient(180deg, rgba(7, 11, 15, 0.98), rgba(5, 8, 12, 0.98))',
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={createHeaderStyle('rgba(52, 211, 153, 0.12)')}>
            <div style={createPillStyle({ color: '#a7f3d0', background: 'rgba(52, 211, 153, 0.1)', border: 'rgba(52, 211, 153, 0.16)' })}>
              Terminal
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, color: primaryText, fontFamily: monoFont, fontSize: 12 }}>
              <span style={{ color: '#34d399' }}>$</span>
              <span>{shape.props.command}</span>
            </div>
          </div>
          <pre style={{ ...createMonoBodyStyle(), color: '#b8c3d9' }}>{shape.props.output}</pre>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: TerminalBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
          style={createPanelStyle({
            border: 'rgba(255, 255, 255, 0.1)',
            glow: 'rgba(255, 255, 255, 0.06)',
            background: 'linear-gradient(180deg, rgba(14, 18, 28, 0.98), rgba(9, 12, 19, 0.96))',
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={{ display: 'flex', height: '100%', flexDirection: 'column', justifyContent: 'space-between', padding: 16 }}>
            <div>
              <div style={createPillStyle({ color: '#dbeafe', background: 'rgba(125, 211, 252, 0.08)', border: 'rgba(125, 211, 252, 0.14)' })}>
                File
              </div>
              <div style={{ marginTop: 12, color: primaryText, fontSize: 16, fontWeight: 600, letterSpacing: '-0.03em' }}>
                {filename}
              </div>
              <div style={{ marginTop: 6, color: secondaryText, fontSize: 11, lineHeight: 1.55 }}>
                {shape.props.filePath}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={createPillStyle({ color: '#cbd5e1', background: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)' })}>
                {shape.props.language || 'File'}
              </span>
              <span style={createPillStyle({ color: '#cbd5e1', background: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)' })}>
                {shape.props.lineCount} lines
              </span>
            </div>
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: FileCardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
          style={createPanelStyle({
            border: 'rgba(255, 255, 255, 0.1)',
            glow: 'rgba(125, 211, 252, 0.08)',
            background: 'linear-gradient(180deg, rgba(10, 13, 20, 0.98), rgba(7, 10, 16, 0.96))',
          })}
        >
          <AiBadge source={shape.props.source} />
          {safeSrc ? (
            <img
              src={safeSrc}
              alt={shape.props.alt}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ display: 'flex', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <div style={createPillStyle({ color: '#dbeafe', background: 'rgba(125, 211, 252, 0.08)', border: 'rgba(125, 211, 252, 0.14)' })}>
                Image Slot
              </div>
              <span style={{ color: secondaryText, fontSize: 12 }}>{shape.props.alt || 'No image'}</span>
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ImageBlockShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
    const tone = getPriorityTone(shape.props.priority)

    return (
      <HTMLContainer>
        <div
          style={createPanelStyle({
            border: tone.border,
            glow: `${tone.bar}22`,
            background: 'linear-gradient(180deg, rgba(14, 18, 27, 0.98), rgba(10, 12, 18, 0.96))',
          })}
        >
          <AiBadge source={shape.props.source} />
          <div style={{ height: 4, background: `linear-gradient(90deg, ${tone.bar}, transparent)` }} />
          <div style={{ padding: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <span style={createPillStyle({ color: '#cbd5e1', background: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.08)' })}>
                {shape.props.status}
              </span>
              <span style={createPillStyle({ color: tone.label, background: tone.background, border: tone.border })}>
                {shape.props.priority}
              </span>
            </div>
            <div style={{ marginTop: 14, color: primaryText, fontSize: 16, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.35 }}>
              {shape.props.title}
            </div>
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: TaskCardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={panelRadius} />
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
            ...createPanelStyle({
              border: 'rgba(255, 255, 255, 0.08)',
              glow: 'rgba(255, 255, 255, 0.04)',
              background: 'rgba(255, 255, 255, 0.03)',
            }),
            alignItems: 'center',
            justifyContent: 'center',
            display: 'flex',
            borderStyle: 'dashed',
            color: secondaryText,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          <AiBadge source={shape.props.source} />
          {shape.props.label || 'link'}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ConnectionArrowShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={16} />
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
