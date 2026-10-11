import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { TypedEventBus } from '../../core/event-bus.js'
import type { WorkspaceEventMap } from '../../dashboard/workspace-events.js'
import { createTaskWorkspaceBridge } from '../../dashboard/task-workspace-bridge.js'

describe('createTaskWorkspaceBridge', () => {
  let taskManager: EventEmitter
  let workspaceBus: TypedEventBus<WorkspaceEventMap>
  let activities: WorkspaceEventMap['monitor:agent_activity'][]

  beforeEach(() => {
    taskManager = new EventEmitter()
    workspaceBus = new TypedEventBus<WorkspaceEventMap>()
    activities = []
    workspaceBus.on('monitor:agent_activity', (ev) => activities.push(ev))
  })

  it('forwards task:created as monitor:agent_activity', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:created', { id: 'task_1', title: 'Fix bug', prompt: 'fix the bug' })

    expect(activities).toHaveLength(1)
    expect(activities[0].action).toBe('task_created')
    expect(activities[0].taskId).toBe('task_1')
    expect(activities[0].detail).toContain('Fix bug')
  })

  it('forwards task:completed as monitor:agent_activity', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:completed', 'task_2', 'All done')

    expect(activities).toHaveLength(1)
    expect(activities[0].action).toBe('task_completed')
    expect(activities[0].taskId).toBe('task_2')
  })

  it('forwards task:failed as monitor:agent_activity', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:failed', 'task_3', 'Out of budget')

    expect(activities).toHaveLength(1)
    expect(activities[0].action).toBe('task_failed')
    expect(activities[0].detail).toContain('Out of budget')
  })

  it('forwards task:blocked as monitor:agent_activity', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:blocked', 'task_4', 'Needs approval')

    expect(activities).toHaveLength(1)
    expect(activities[0].action).toBe('task_blocked')
  })

  it('forwards task:cancelled as monitor:agent_activity', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:cancelled', 'task_5')

    expect(activities).toHaveLength(1)
    expect(activities[0].action).toBe('task_cancelled')
  })

  it('forwards task:progress as monitor:agent_activity', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:progress', 'task_6', 'Analyzing files')

    expect(activities).toHaveLength(1)
    expect(activities[0].action).toBe('task_progress')
    expect(activities[0].detail).toBe('Analyzing files')
  })

  it('forwards task:progress with structured message', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:progress', 'task_7', { kind: 'analysis', message: 'Running', userSummary: 'Analyzing project' })

    expect(activities).toHaveLength(1)
    expect(activities[0].detail).toBe('Running')
  })

  it('stop() removes all listeners', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    bridge.stop()
    taskManager.emit('task:created', { id: 'task_8', title: 'Should not appear' })

    expect(activities).toHaveLength(0)
  })

  // dashboard#3: the frames name whose request they quote, so the monitor bridge
  // can stamp an origin and the transport can keep them from other identities.
  it('names the task owner\'s scope on every frame of a task it saw created', () => {
    const bridge = createTaskWorkspaceBridge(taskManager, workspaceBus)
    bridge.start()
    taskManager.emit('task:created', { id: 'task_9', chatId: 'chat-9', userId: 'profile-9', title: 'Fix it' })
    taskManager.emit('task:progress', 'task_9', 'Reading files')
    taskManager.emit('task:blocked', 'task_9', 'Needs approval')
    taskManager.emit('task:failed', 'task_9', 'Out of budget')

    expect(activities.map((a) => a.conversationId)).toEqual(['profile-9', 'profile-9', 'profile-9', 'profile-9'])
  })

  it('asks the task manager for the scope of a task it did not see created (one recovered after a restart)', () => {
    const lookup = Object.assign(taskManager, {
      getStatus: (taskId: string) => (taskId === 'task_10' ? { id: taskId, chatId: 'chat-10', userId: 'profile-10' } : null),
    })
    const bridge = createTaskWorkspaceBridge(lookup, workspaceBus)
    bridge.start()
    taskManager.emit('task:failed', 'task_10', 'Out of budget')
    taskManager.emit('task:failed', 'task_unknown', 'Out of budget')

    expect(activities[0].conversationId).toBe('profile-10')
    // Nothing to attribute it to: no scope is invented.
    expect(activities[1]).not.toHaveProperty('conversationId')
  })
})
