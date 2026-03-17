import { afterEach, describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../../core/event-bus.js";
import type { DaemonEventMap } from "../daemon-events.js";
import { registerDeployApprovalBridge } from "./deploy-approval-bridge.js";

describe("registerDeployApprovalBridge", () => {
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards deployment approval decisions to the deploy trigger", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-1",
        toolName: "deployment",
        triggerName: "deploy-readiness",
        params: { proposalId: "proposal-1" },
      }),
    };
    const deployTrigger = {
      onApprovalDecided: vi.fn().mockResolvedValue(null),
    };

    const unsubscribe = registerDeployApprovalBridge(
      eventBus,
      approvalQueue as never,
      deployTrigger,
      logger,
    );

    eventBus.emit("daemon:approval_decided", {
      approvalId: "approval-1",
      decision: "approved",
      decidedBy: "admin",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).toHaveBeenCalledWith(
      "approved",
      "proposal-1",
      "admin",
    );

    unsubscribe();
  });

  it("ignores non-deployment approvals", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-1",
        toolName: "file_write",
        triggerName: "daily-sync",
        params: { path: "/tmp/test.txt" },
      }),
    };
    const deployTrigger = {
      onApprovalDecided: vi.fn().mockResolvedValue(null),
    };

    registerDeployApprovalBridge(
      eventBus,
      approvalQueue as never,
      deployTrigger,
      logger,
    );

    eventBus.emit("daemon:approval_decided", {
      approvalId: "approval-1",
      decision: "approved",
      decidedBy: "admin",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
  });

  it("warns and skips deployment approvals without a proposalId", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-1",
        toolName: "deployment",
        triggerName: "deploy-readiness",
        params: {},
      }),
    };
    const deployTrigger = {
      onApprovalDecided: vi.fn().mockResolvedValue(null),
    };

    registerDeployApprovalBridge(
      eventBus,
      approvalQueue as never,
      deployTrigger,
      logger,
    );

    eventBus.emit("daemon:approval_decided", {
      approvalId: "approval-1",
      decision: "approved",
      decidedBy: "admin",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Deployment approval decision missing proposalId",
      { approvalId: "approval-1" },
    );
  });

  it("ignores expired approval decisions", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-1",
        toolName: "deployment",
        triggerName: "deploy-readiness",
        params: { proposalId: "proposal-1" },
      }),
    };
    const deployTrigger = {
      onApprovalDecided: vi.fn().mockResolvedValue(null),
    };

    registerDeployApprovalBridge(
      eventBus,
      approvalQueue as never,
      deployTrigger,
      logger,
    );

    eventBus.emit("daemon:approval_decided", {
      approvalId: "approval-1",
      decision: "expired",
      decidedBy: "system",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
  });
});
