import type { Editor } from 'tldraw'
import { SHAPE_TYPES } from './custom-shapes'

export type TemplateId = 'architecture' | 'code-review' | 'task-planning' | 'unity-scene' | 'brainstorm' | 'blank'

export interface TemplateInfo {
  id: TemplateId
  title: string
  description: string
  icon: string
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'architecture', title: 'Architecture Diagram', description: 'System components with connections', icon: '\u25C7' },
  { id: 'code-review', title: 'Code Review', description: 'Code blocks, diffs, and annotations', icon: '</>' },
  { id: 'task-planning', title: 'Task Planning', description: 'Sprint board with task cards', icon: '\u2610' },
  { id: 'unity-scene', title: 'Unity Scene Map', description: 'GameObject hierarchy tree', icon: '\uD83C\uDFAE' },
  { id: 'brainstorm', title: 'Brainstorm', description: 'Mind map for ideation', icon: '\uD83D\uDCA1' },
  { id: 'blank', title: 'Blank Canvas', description: 'Start from scratch', icon: '+' },
]

export function applyTemplate(editor: Editor, id: TemplateId): void {
  if (id === 'blank') return
  const fns: Record<string, (e: Editor) => void> = {
    'architecture': applyArchitecture,
    'code-review': applyCodeReview,
    'task-planning': applyTaskPlanning,
    'unity-scene': applyUnityScene,
    'brainstorm': applyBrainstorm,
  }
  fns[id]?.(editor)
  editor.zoomToFit({ animation: { duration: 300 } })
}

function applyArchitecture(editor: Editor): void {
  const cx = 0
  editor.run(() => {
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 90, y: 0, props: { w: 180, h: 80, label: 'API Gateway', nodeType: 'gateway', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 290, y: 140, props: { w: 180, h: 80, label: 'Auth Service', nodeType: 'service', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx + 110, y: 140, props: { w: 180, h: 80, label: 'Game Service', nodeType: 'service', status: 'idle' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 290, y: 280, props: { w: 180, h: 80, label: 'Database', nodeType: 'database', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx + 110, y: 280, props: { w: 180, h: 80, label: 'Redis Cache', nodeType: 'cache', status: 'idle' } })
    editor.createShape({ type: SHAPE_TYPES.connectionArrow, x: cx - 50, y: 90, props: { w: 120, h: 40, label: 'routes' } })
    editor.createShape({ type: SHAPE_TYPES.connectionArrow, x: cx + 50, y: 90, props: { w: 120, h: 40, label: 'routes' } })
    editor.createShape({ type: SHAPE_TYPES.connectionArrow, x: cx - 250, y: 230, props: { w: 120, h: 40, label: 'queries' } })
    editor.createShape({ type: SHAPE_TYPES.connectionArrow, x: cx + 150, y: 230, props: { w: 120, h: 40, label: 'reads' } })
  })
}

function applyCodeReview(editor: Editor): void {
  editor.run(() => {
    editor.createShape({ type: SHAPE_TYPES.codeBlock, x: 0, y: 0, props: { w: 400, h: 240, code: 'export function processTask(task: Task) {\n  validate(task)\n  const result = execute(task)\n  return summarize(result)\n}', language: 'typescript', title: 'task-processor.ts' } })
    editor.createShape({ type: SHAPE_TYPES.diffBlock, x: 440, y: 0, props: { w: 420, h: 240, diff: '- const result = execute(task)\n+ const result = await execute(task)\n+ if (!result.ok) throw new TaskError(result)', filePath: 'src/task-processor.ts' } })
    editor.createShape({ type: SHAPE_TYPES.noteBlock, x: 900, y: 0, props: { w: 240, h: 160, content: 'Review notes:\n- Add async/await\n- Error handling needed\n- Add retry logic?', color: '#f9e2af' } })
    editor.createShape({ type: SHAPE_TYPES.fileCard, x: 0, y: 280, props: { w: 240, h: 100, filePath: 'src/task-processor.ts', language: 'TypeScript', lineCount: 142 } })
  })
}

function applyTaskPlanning(editor: Editor): void {
  const colW = 260
  const gap = 20
  editor.run(() => {
    editor.createShape({ type: SHAPE_TYPES.noteBlock, x: 0, y: 0, props: { w: colW, h: 40, content: 'Todo', color: '#f38ba8' } })
    editor.createShape({ type: SHAPE_TYPES.noteBlock, x: colW + gap, y: 0, props: { w: colW, h: 40, content: 'In Progress', color: '#f9e2af' } })
    editor.createShape({ type: SHAPE_TYPES.noteBlock, x: (colW + gap) * 2, y: 0, props: { w: colW, h: 40, content: 'Done', color: '#a6e3a1' } })
    editor.createShape({ type: SHAPE_TYPES.taskCard, x: 0, y: 60, props: { w: colW, h: 120, title: 'Setup project structure', status: 'todo', priority: 'high' } })
    editor.createShape({ type: SHAPE_TYPES.taskCard, x: 0, y: 200, props: { w: colW, h: 120, title: 'Design database schema', status: 'todo', priority: 'medium' } })
    editor.createShape({ type: SHAPE_TYPES.taskCard, x: colW + gap, y: 60, props: { w: colW, h: 120, title: 'Implement auth flow', status: 'in-progress', priority: 'critical' } })
    editor.createShape({ type: SHAPE_TYPES.taskCard, x: colW + gap, y: 200, props: { w: colW, h: 120, title: 'Write API endpoints', status: 'in-progress', priority: 'high' } })
    editor.createShape({ type: SHAPE_TYPES.taskCard, x: (colW + gap) * 2, y: 60, props: { w: colW, h: 120, title: 'Configure CI pipeline', status: 'done', priority: 'medium' } })
    editor.createShape({ type: SHAPE_TYPES.taskCard, x: (colW + gap) * 2, y: 200, props: { w: colW, h: 120, title: 'Setup linting rules', status: 'done', priority: 'low' } })
  })
}

function applyUnityScene(editor: Editor): void {
  const cx = 0
  editor.run(() => {
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 90, y: 0, props: { w: 180, h: 80, label: 'GameScene', nodeType: 'scene', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 350, y: 140, props: { w: 180, h: 80, label: 'UICanvas', nodeType: 'canvas', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx + 170, y: 140, props: { w: 180, h: 80, label: 'GameWorld', nodeType: 'gameobject', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 450, y: 280, props: { w: 160, h: 70, label: 'HUDPanel', nodeType: 'panel', status: 'idle' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx - 250, y: 280, props: { w: 160, h: 70, label: 'MenuPanel', nodeType: 'panel', status: 'idle' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx + 100, y: 280, props: { w: 160, h: 70, label: 'Player', nodeType: 'gameobject', status: 'active' } })
    editor.createShape({ type: SHAPE_TYPES.diagramNode, x: cx + 300, y: 280, props: { w: 160, h: 70, label: 'Environment', nodeType: 'gameobject', status: 'idle' } })
    editor.createShape({ type: SHAPE_TYPES.fileCard, x: cx - 450, y: 390, props: { w: 220, h: 90, filePath: 'Assets/Scripts/UI/HUDPanel.cs', language: 'C#', lineCount: 87 } })
    editor.createShape({ type: SHAPE_TYPES.fileCard, x: cx + 100, y: 390, props: { w: 220, h: 90, filePath: 'Assets/Scripts/Player/PlayerController.cs', language: 'C#', lineCount: 234 } })
  })
}

function applyBrainstorm(editor: Editor): void {
  const cx = 0
  const cy = 0
  const radius = 250
  const topics = [
    { label: 'Core Feature', nodeType: 'idea' },
    { label: 'User Flow', nodeType: 'idea' },
    { label: 'Tech Stack', nodeType: 'idea' },
    { label: 'Timeline', nodeType: 'idea' },
    { label: 'Risks', nodeType: 'idea' },
  ]
  editor.run(() => {
    editor.createShape({ type: SHAPE_TYPES.noteBlock, x: cx - 120, y: cy - 80, props: { w: 240, h: 160, content: 'Project Idea\n\nDescribe your concept here...', color: '#89b4fa' } })
    topics.forEach((t, i) => {
      const angle = (i / topics.length) * Math.PI * 2 - Math.PI / 2
      const nx = cx + Math.cos(angle) * radius - 90
      const ny = cy + Math.sin(angle) * radius - 40
      editor.createShape({ type: SHAPE_TYPES.diagramNode, x: nx, y: ny, props: { w: 180, h: 80, label: t.label, nodeType: t.nodeType, status: 'idle' } })
    })
  })
}
