import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useMonitorStore } from '../../stores/monitor-store'
import { dispatchWorkspaceMessage } from '../../hooks/use-dashboard-socket'

// The real monitor store and dispatcher; only the socket and drag-and-drop are faked.
const mockSendRawJSON = vi.fn().mockReturnValue(true)
vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({ sendRawJSON: mockSendRawJSON }),
}))

let capturedOnDragEnd: ((event: unknown) => void) | undefined
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children?: React.ReactNode; onDragEnd?: (e: unknown) => void }) => {
    capturedOnDragEnd = onDragEnd
    return <div>{children}</div>
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: 'vertical',
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: null, isDragging: false }),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => undefined } } }))
vi.mock('../ui/number-ticker', () => ({ NumberTicker: ({ value }: { value: number }) => <span>{value}</span> }))

import KanbanBoard from './KanbanBoard'

// WEB-8: after the optimistic move the card's status already differs from
// the old one, so ANY store update (an activity entry) was taken for the
// server's confirmation and the rollback never happened.
describe('KanbanBoard optimistic move (WEB-8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useMonitorStore.getState().clearMonitor()
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      payload: { rootId: 'root-1', nodes: [{ id: 't1', task: 'Fix it', status: 'failed', reviewStatus: 'none' }], edges: [] },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useMonitorStore.getState().clearMonitor()
  })

  it('rolls the move back when only unrelated updates arrive', () => {
    render(<KanbanBoard />)
    act(() => { capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 'backlog' } }) })
    expect(useMonitorStore.getState().tasks.t1!.status).toBe('pending')

    act(() => {
      dispatchWorkspaceMessage({ type: 'monitor:agent_activity', payload: { action: 'tool_call', detail: 'reading', timestamp: 1 } })
    })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(useMonitorStore.getState().tasks.t1!.status).toBe('failed')
  })

  it('keeps the move once the server confirms it (guard)', () => {
    render(<KanbanBoard />)
    act(() => { capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 'backlog' } }) })
    act(() => {
      dispatchWorkspaceMessage({ type: 'monitor:task_update', payload: { rootId: 'root-1', nodeId: 't1', status: 'pending', reviewStatus: 'none' } })
    })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(useMonitorStore.getState().tasks.t1!.status).toBe('pending')
  })
})
