import type React from 'react'
import type { ResolvedShape } from './canvas-types'
import {
  CodeBlockCard,
  DiffBlockCard,
  FileCardCard,
  DiagramNodeCard,
  TerminalBlockCard,
  ImageBlockCard,
  TaskCardCard,
  NoteBlockCard,
  GoalSummaryCard,
  ErrorCardComponent,
  TestResultCard,
  LinkCardComponent,
  MetricCardComponent,
} from './canvas-cards'

/** Map card type string to component */
export const CARD_COMPONENTS: Record<string, React.FC<{ shape: ResolvedShape }>> = {
  'code-block': CodeBlockCard,
  'diff-block': DiffBlockCard,
  'file-card': FileCardCard,
  'diagram-node': DiagramNodeCard,
  'terminal-block': TerminalBlockCard,
  'image-block': ImageBlockCard,
  'task-card': TaskCardCard,
  'note-block': NoteBlockCard,
  'goal-summary': GoalSummaryCard,
  'error-card': ErrorCardComponent,
  'test-result': TestResultCard,
  'link-card': LinkCardComponent,
  'metric-card': MetricCardComponent,
}
