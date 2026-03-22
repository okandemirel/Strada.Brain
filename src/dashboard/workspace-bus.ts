import { TypedEventBus } from '../core/event-bus.js'
import type { WorkspaceEventMap } from './workspace-events.js'

export type WorkspaceBus = TypedEventBus<WorkspaceEventMap>

export function createWorkspaceBus(): WorkspaceBus {
  return new TypedEventBus<WorkspaceEventMap>()
}
