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

  it("ignores events when getById returns null (approval not found)", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue(null),
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
      approvalId: "nonexistent",
      decision: "approved",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
  });

  it("correctly forwards denied decisions", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-1",
        toolName: "deployment",
        triggerName: "deploy-readiness",
        params: { proposalId: "proposal-deny" },
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
      decision: "denied",
      decidedBy: "reviewer",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).toHaveBeenCalledWith(
      "denied",
      "proposal-deny",
      "reviewer",
    );
  });

  it("ignores deployment tool with wrong trigger name", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-1",
        toolName: "deployment",
        triggerName: "some-other-trigger",
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
      decision: "approved",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
  });

  it("logs error when onApprovalDecided rejects", async () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-err",
        toolName: "deployment",
        triggerName: "deploy-readiness",
        params: { proposalId: "proposal-err" },
      }),
    };
    const deployTrigger = {
      onApprovalDecided: vi.fn().mockRejectedValue(new Error("exec boom")),
    };

    registerDeployApprovalBridge(
      eventBus,
      approvalQueue as never,
      deployTrigger,
      logger,
    );

    eventBus.emit("daemon:approval_decided", {
      approvalId: "approval-err",
      decision: "approved",
      timestamp: Date.now(),
    });

    // Wait for promise rejection handler
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to process deployment approval decision",
      expect.objectContaining({
        approvalId: "approval-err",
        proposalId: "proposal-err",
        error: "exec boom",
      }),
    );
  });

  it("unsubscribe prevents future event handling", () => {
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

    const unsub = registerDeployApprovalBridge(
      eventBus,
      approvalQueue as never,
      deployTrigger,
      logger,
    );

    unsub();

    eventBus.emit("daemon:approval_decided", {
      approvalId: "approval-1",
      decision: "approved",
      timestamp: Date.now(),
    });

    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
  });

  it("handles non-string proposalId (number) by warning", () => {
    const eventBus = new TypedEventBus<DaemonEventMap>();
    const approvalQueue = {
      getById: vi.fn().mockReturnValue({
        id: "approval-num",
        toolName: "deployment",
        triggerName: "deploy-readiness",
        params: { proposalId: 12345 },
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
      approvalId: "approval-num",
      decision: "approved",
      timestamp: Date.now(),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "Deployment approval decision missing proposalId",
      { approvalId: "approval-num" },
    );
    expect(deployTrigger.onApprovalDecided).not.toHaveBeenCalled();
  });
});
