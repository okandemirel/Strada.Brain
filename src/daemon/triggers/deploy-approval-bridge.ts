import type { IEventBus } from "../../core/event-bus.js";
import type { DaemonEventMap } from "../daemon-events.js";
import type { ApprovalQueue } from "../security/approval-queue.js";

interface DeployApprovalHandler {
  onApprovalDecided(
    decision: "approved" | "denied",
    proposalId: string,
    decidedBy?: string,
  ): Promise<unknown> | unknown;
}

interface DeployApprovalBridgeLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function registerDeployApprovalBridge(
  eventBus: IEventBus<DaemonEventMap>,
  approvalQueue: ApprovalQueue,
  deployTrigger: DeployApprovalHandler,
  logger: DeployApprovalBridgeLogger,
): () => void {
  const listener = (event: DaemonEventMap["daemon:approval_decided"]): void => {
    const approval = approvalQueue.getById(event.approvalId);
    if (!approval || approval.toolName !== "deployment" || approval.triggerName !== "deploy-readiness") {
      return;
    }

    if (event.decision !== "approved" && event.decision !== "denied") {
      return;
    }

    const proposalId = typeof approval.params["proposalId"] === "string"
      ? approval.params["proposalId"]
      : undefined;

    if (!proposalId) {
      logger.warn("Deployment approval decision missing proposalId", {
        approvalId: event.approvalId,
      });
      return;
    }

    void Promise.resolve(
      deployTrigger.onApprovalDecided(event.decision, proposalId, event.decidedBy),
    ).catch((error) => {
      logger.error("Failed to process deployment approval decision", {
        approvalId: event.approvalId,
        proposalId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  eventBus.on("daemon:approval_decided", listener);
  return () => {
    eventBus.off("daemon:approval_decided", listener);
  };
}
