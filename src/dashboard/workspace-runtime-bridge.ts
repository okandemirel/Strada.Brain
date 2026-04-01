import type { GoalStatus } from "../goals/types.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { WorkspaceBus } from "./workspace-bus.js";
import { getLogger } from "../utils/logger.js";

const GOAL_NODE_STATUSES = new Set<GoalStatus>([
  "pending",
  "executing",
  "completed",
  "failed",
  "skipped",
]);

interface TaskActionPayload {
  rootId?: string;
  nodeId?: string;
  taskId?: string;
}

interface RuntimeBridge {
  start(): void;
  stop(): void;
}

function extractActionPayload(payload: unknown): TaskActionPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const bag = payload as Record<string, unknown>;
  return {
    ...(typeof bag.rootId === "string" ? { rootId: bag.rootId } : {}),
    ...(typeof bag.nodeId === "string" ? { nodeId: bag.nodeId } : {}),
    ...(typeof bag.taskId === "string" ? { taskId: bag.taskId } : {}),
  };
}

function emitNotification(
  workspaceBus: WorkspaceBus,
  severity: "info" | "warning" | "error",
  title: string,
  message: string,
): void {
  workspaceBus.emit("workspace:notification", {
    title,
    message,
    severity,
  });
}

export function createWorkspaceRuntimeBridge(params: {
  workspaceBus: WorkspaceBus;
  goalStorage?: GoalStorage;
  taskManager: TaskManager;
}): RuntimeBridge {
  const { workspaceBus, goalStorage, taskManager } = params;
  const listeners: Array<() => void> = [];

  return {
    start() {
      const handleTaskUpdate = (payload: unknown) => {
        if (!goalStorage || !payload || typeof payload !== "object") {
          return;
        }
        const bag = payload as Record<string, unknown>;
        if (typeof bag.rootId !== "string" || typeof bag.nodeId !== "string") {
          return;
        }
        if (typeof bag.status !== "string" || !GOAL_NODE_STATUSES.has(bag.status as GoalStatus)) {
          return;
        }

        const tree = goalStorage.getTree(bag.rootId as never);
        const node = tree?.nodes.get(bag.nodeId as never);
        if (!tree || !node) {
          getLogger().debug("monitor:task_update dropped — goal tree or node not found in storage", {
            rootId: bag.rootId,
            nodeId: bag.nodeId,
            treeFound: !!tree,
          });
          return;
        }

        goalStorage.updateNodeStatus(
          node.id,
          bag.status as GoalStatus,
          node.result,
          typeof bag.error === "string" ? bag.error : node.error,
          node.retryCount,
          node.redecompositionCount,
          typeof bag.reviewStatus === "string" ? bag.reviewStatus : (node.reviewStatus ?? "none"),
          node.reviewIterations ?? 0,
        );
      };

      const handleRetry = (payload: unknown) => {
        const action = extractActionPayload(payload);
        const nextTask = action.taskId
          ? taskManager.retryTask(action.taskId as never)
          : action.rootId
            ? taskManager.retryGoalRoot(action.rootId, action.nodeId)
            : null;

        if (!nextTask) {
          emitNotification(
            workspaceBus,
            "warning",
            "Retry unavailable",
            "The selected task could not be retried. It may already be running or no saved checkpoint was found.",
          );
          return;
        }

        emitNotification(
          workspaceBus,
          "info",
          "Retry queued",
          "I queued a new recovery attempt for the selected task.",
        );
      };

      const handleResume = (payload: unknown) => {
        const action = extractActionPayload(payload);
        const nextTask = action.taskId
          ? taskManager.resumeTask(action.taskId as never)
          : action.rootId
            ? taskManager.resumeGoalRoot(action.rootId)
            : null;

        if (!nextTask) {
          emitNotification(
            workspaceBus,
            "warning",
            "Resume unavailable",
            "The selected task could not be resumed. It may already be active or the checkpoint is no longer available.",
          );
          return;
        }

        emitNotification(
          workspaceBus,
          "info",
          "Resume queued",
          "I queued a resume run from the strongest saved checkpoint.",
        );
      };

      const handleCancel = (payload: unknown) => {
        const action = extractActionPayload(payload);
        const cancelled = action.taskId
          ? taskManager.cancel(action.taskId as never)
          : action.rootId
            ? taskManager.cancelGoalRoot(action.rootId)
            : false;

        if (!cancelled) {
          emitNotification(
            workspaceBus,
            "warning",
            "Cancel unavailable",
            "The selected task could not be cancelled. It may already be finished.",
          );
          return;
        }

        emitNotification(
          workspaceBus,
          "info",
          "Task cancelled",
          "The selected task was cancelled.",
        );
      };

      const handleMoveTask = (payload: unknown) => {
        if (!goalStorage) return;
        const action = extractActionPayload(payload);
        if (!action.rootId || !action.nodeId) {
          getLogger().debug("monitor:move_task dropped — missing rootId or nodeId", action);
          return;
        }

        const bag = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
        const newStatus = typeof bag.newStatus === "string" ? bag.newStatus : undefined;
        const toColumn = typeof bag.toColumn === "string" ? bag.toColumn : undefined;

        if (!newStatus || !GOAL_NODE_STATUSES.has(newStatus as GoalStatus)) {
          getLogger().debug("monitor:move_task dropped — missing or invalid newStatus", { newStatus });
          return;
        }

        const tree = goalStorage.getTree(action.rootId as never);
        const node = tree?.nodes.get(action.nodeId as never);
        if (!tree || !node) {
          getLogger().debug("monitor:move_task dropped — goal tree or node not found", {
            rootId: action.rootId,
            nodeId: action.nodeId,
          });
          return;
        }

        const newReviewStatus = typeof bag.reviewStatus === "string" ? bag.reviewStatus :
          (newStatus === "pending" ? "none" : undefined);
        goalStorage.updateNodeStatus(
          node.id,
          newStatus as GoalStatus,
          node.result,
          node.error,
          node.retryCount,
          node.redecompositionCount,
          newReviewStatus ?? node.reviewStatus ?? "none",
          node.reviewIterations ?? 0,
        );

        workspaceBus.emit("monitor:task_update", {
          rootId: action.rootId!,
          nodeId: action.nodeId!,
          status: newStatus,
          ...(newReviewStatus ? { reviewStatus: newReviewStatus } : {}),
        });

        emitNotification(
          workspaceBus,
          "info",
          "Task moved",
          `Task moved to ${toColumn ?? newStatus} by user.`,
        );
      };

      const bindings = [
        ["monitor:task_update", handleTaskUpdate],
        ["monitor:retry_task", handleRetry],
        ["monitor:resume_task", handleResume],
        ["monitor:cancel_task", handleCancel],
        ["monitor:move_task", handleMoveTask],
      ] as const;

      for (const [event, handler] of bindings) {
        workspaceBus.on(event, handler as (payload: unknown) => void);
        listeners.push(() => workspaceBus.off(event, handler as (payload: unknown) => void));
      }
    },

    stop() {
      for (const unsubscribe of listeners) {
        unsubscribe();
      }
      listeners.length = 0;
    },
  };
}
