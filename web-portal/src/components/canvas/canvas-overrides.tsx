/* eslint-disable react-refresh/only-export-components */
import {
  DefaultToolbar,
  DefaultToolbarContent,
  DefaultContextMenu,
  DefaultContextMenuContent,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  useEditor,
  type TLUiContextMenuProps,
} from 'tldraw'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SHAPE_TYPES } from './custom-shapes'

/** Export JSON callback — set by CanvasPanel so context menu can trigger export */
let _exportJsonFn: (() => void) | null = null
export function setExportJsonFn(fn: () => void): void { _exportJsonFn = fn }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createShapeAtCenter(editor: ReturnType<typeof useEditor>, type: string): void {
  const center = editor.getViewportPageBounds().center
  editor.createShape({ type, x: center.x - 100, y: center.y - 50 })
}

function createShapeAtPointer(editor: ReturnType<typeof useEditor>, type: string): void {
  const point = editor.inputs.currentPagePoint
  editor.createShape({ type, x: point.x - 100, y: point.y - 50 })
}

// ---------------------------------------------------------------------------
// Toolbar shape button definitions
// ---------------------------------------------------------------------------

export const TOOLBAR_SHAPES = [
  {
    type: SHAPE_TYPES.codeBlock,
    label: '</>',
    title: 'Code Block',
    hint: 'Snippets, APIs, and implementation notes',
    description: 'Paste implementation details, snippets, or API notes with code context.',
  },
  {
    type: SHAPE_TYPES.diagramNode,
    label: '\u25C7',
    title: 'Diagram Node',
    hint: 'Features, services, and flow anchors',
    description: 'Mark a feature, service, screen, or architecture node on the board.',
  },
  {
    type: SHAPE_TYPES.taskCard,
    label: '\u2610',
    title: 'Task Card',
    hint: 'Work items with status and priority',
    description: 'Track a work item with status and priority in the same canvas.',
  },
  {
    type: SHAPE_TYPES.noteBlock,
    label: '\u270E',
    title: 'Note Block',
    hint: 'Review notes and decisions',
    description: 'Drop short review notes, decisions, or reminders next to related items.',
  },
  {
    type: SHAPE_TYPES.terminalBlock,
    label: '>_',
    title: 'Terminal',
    hint: 'Commands and shell output',
    description: 'Capture commands, logs, or shell output without leaving the board.',
  },
  {
    type: SHAPE_TYPES.fileCard,
    label: '\uD83D\uDCC4',
    title: 'File Card',
    hint: 'File references and artifacts',
    description: 'Reference a file or artifact so review context stays attached to the canvas.',
  },
] as const

// ---------------------------------------------------------------------------
// CustomToolbar
// ---------------------------------------------------------------------------

export function CustomToolbar() {
  const editor = useEditor()

  return (
    <DefaultToolbar>
      <DefaultToolbarContent />
      <div className="strada-toolbar-separator" />
      {TOOLBAR_SHAPES.map(({ type, label, title, description }) => (
        <Tooltip key={type}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="strada-toolbar-btn"
              data-testid={`strada-btn-${type}`}
              title={title}
              aria-label={title}
              onClick={() => createShapeAtCenter(editor, type)}
            >
              {label}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-[220px]">
            <div className="font-medium text-text">{title}</div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">{description}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </DefaultToolbar>
  )
}

// ---------------------------------------------------------------------------
// Context menu shape definitions (all 9 shapes, categorized)
// ---------------------------------------------------------------------------

const CTX_CATEGORIES = [
  {
    id: 'strada-code',
    label: 'Code',
    shapes: [
      { type: SHAPE_TYPES.codeBlock, label: 'Code Block' },
      { type: SHAPE_TYPES.diffBlock, label: 'Diff Block' },
      { type: SHAPE_TYPES.terminalBlock, label: 'Terminal Block' },
    ],
  },
  {
    id: 'strada-diagram',
    label: 'Diagram',
    shapes: [
      { type: SHAPE_TYPES.diagramNode, label: 'Diagram Node' },
      { type: SHAPE_TYPES.connectionArrow, label: 'Connection Arrow' },
      { type: SHAPE_TYPES.fileCard, label: 'File Card' },
    ],
  },
  {
    id: 'strada-planning',
    label: 'Planning',
    shapes: [
      { type: SHAPE_TYPES.taskCard, label: 'Task Card' },
      { type: SHAPE_TYPES.noteBlock, label: 'Note Block' },
    ],
  },
  {
    id: 'strada-media',
    label: 'Media',
    shapes: [
      { type: SHAPE_TYPES.imageBlock, label: 'Image Block' },
    ],
  },
]

// ---------------------------------------------------------------------------
// CustomContextMenu
// ---------------------------------------------------------------------------

export function CustomContextMenu(props: TLUiContextMenuProps) {
  const editor = useEditor()

  return (
    <DefaultContextMenu {...props}>
      <TldrawUiMenuGroup id="strada-shapes">
        <TldrawUiMenuSubmenu id="strada-add-shape" label="Add Shape">
          {CTX_CATEGORIES.map((cat) => (
            <TldrawUiMenuSubmenu key={cat.id} id={cat.id} label={cat.label}>
              {cat.shapes.map((shape) => (
                <TldrawUiMenuItem
                  key={shape.type}
                  id={`strada-add-${shape.type}`}
                  label={shape.label}
                  onSelect={() => createShapeAtPointer(editor, shape.type)}
                />
              ))}
            </TldrawUiMenuSubmenu>
          ))}
        </TldrawUiMenuSubmenu>
        <TldrawUiMenuItem
          id="strada-select-all"
          label="Select All"
          onSelect={() => { editor.selectAll() }}
        />
        <TldrawUiMenuItem
          id="strada-zoom-to-fit"
          label="Zoom to Fit"
          onSelect={() => { editor.zoomToFit() }}
        />
        <TldrawUiMenuItem
          id="strada-export-json"
          label="Export JSON"
          onSelect={() => _exportJsonFn?.()}
        />
      </TldrawUiMenuGroup>
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  )
}
