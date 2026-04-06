import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeployTrigger } from "./deploy-trigger.js";
import type { ReadinessResult, DeploymentConfig, DeployResult } from "../deployment/deployment-types.js";
import type { ReadinessChecker } from "../deployment/readiness-checker.js";
import type { DeploymentExecutor } from "../deployment/deployment-executor.js";
import type { ApprovalQueue } from "../security/approval-queue.js";
import type { CircuitBreaker } from "../resilience/circuit-breaker.js";

function createMockReadinessChecker(): ReadinessChecker {
  return {
    checkReadiness: vi.fn(),
    invalidateCache: vi.fn(),
    validateScriptPath: vi.fn(),
  } as unknown as ReadinessChecker;
}

function createMockApprovalQueue(): ApprovalQueue {
  return {
    enqueue: vi.fn().mockReturnValue({
      id: "approval-1",
      toolName: "deployment",
      params: {},
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 1800000,
    }),
    approve: vi.fn(),
    deny: vi.fn(),
    getPending: vi.fn().mockReturnValue([]),
  } as unknown as ApprovalQueue;
}

function createMockCircuitBreaker(isOpen = false): CircuitBreaker {
  return {
    isOpen: vi.fn().mockReturnValue(isOpen),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    reset: vi.fn(),
    getState: vi.fn().mockReturnValue(isOpen ? "OPEN" : "CLOSED"),
    serialize: vi.fn(),
  } as unknown as CircuitBreaker;
}

function createMockExecutor(): DeploymentExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      signal: null,
      stdout: "Deployed!",
      stderr: "",
      durationMs: 5000,
    } satisfies DeployResult),
    cancel: vi.fn(),
    isInProgress: vi.fn().mockReturnValue(false),
    logProposal: vi.fn().mockReturnValue("proposal-1"),
    getHistory: vi.fn().mockReturnValue([]),
    getStats: vi.fn(),
  } as unknown as DeploymentExecutor;
}

function createDefaultConfig(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    enabled: true,
    scriptPath: "scripts/deploy.sh",
    testCommand: "npm test",
    targetBranch: "main",
    requireCleanGit: true,
    testTimeoutMs: 300000,
    executionTimeoutMs: 600000,
    cooldownMinutes: 30,
    notificationUrgency: "high",
    ...overrides,
  };
}

function createReadyResult(overrides: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    ready: true,
    testPassed: true,
    gitClean: true,
    branchMatch: true,
    timestamp: Date.now(),
    cached: false,
    ...overrides,
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("DeployTrigger", () => {
  let trigger: DeployTrigger;
  let readinessChecker: ReturnType<typeof createMockReadinessChecker>;
  let approvalQueue: ReturnType<typeof createMockApprovalQueue>;
  let circuitBreaker: ReturnType<typeof createMockCircuitBreaker>;
  let executor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    readinessChecker = createMockReadinessChecker();
    approvalQueue = createMockApprovalQueue();
    circuitBreaker = createMockCircuitBreaker(false);
    executor = createMockExecutor();

    trigger = new DeployTrigger(
      readinessChecker,
      approvalQueue,
      circuitBreaker,
      executor,
      createDefaultConfig(),
      mockLogger,
    );
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(trigger.metadata.name).toBe("deploy-readiness");
      expect(trigger.metadata.type).toBe("deploy");
    });
  });

  describe("shouldFire", () => {
    it("returns true when readiness is cached as ready and no blockers", () => {
      trigger.setCachedReadiness(createReadyResult());
      expect(trigger.shouldFire(new Date())).toBe(true);
    });

    it("returns false when circuit breaker is open", () => {
      circuitBreaker = createMockCircuitBreaker(true);
      trigger = new DeployTrigger(
        readinessChecker,
        approvalQueue,
        circuitBreaker,
        executor,
        createDefaultConfig(),
        mockLogger,
      );
      trigger.setCachedReadiness(createReadyResult());

      expect(trigger.shouldFire(new Date())).toBe(false);
    });

    it("returns false when deployment is in progress", () => {
      vi.mocked(executor.isInProgress).mockReturnValue(true);
      trigger.setCachedReadiness(createReadyResult());

      expect(trigger.shouldFire(new Date())).toBe(false);
    });

    it("returns false when proposal is pending", () => {
      trigger.setCachedReadiness(createReadyResult());
      trigger.onFired(new Date());

      // Mock getPending to return a matching entry so proposalPending stays true
      vi.mocked(approvalQueue.getPending).mockReturnValue([
        { triggerName: "deploy-readiness", id: "approval-1", toolName: "deployment", params: {}, status: "pending" as const, createdAt: Date.now(), expiresAt: Date.now() + 1800000 },
      ]);
      expect(trigger.shouldFire(new Date())).toBe(false);
    });

    it("returns false when in cooldown after rejection", async () => {
      trigger.setCachedReadiness(createReadyResult());

      // Simulate a denial
      await trigger.onApprovalDecided("denied", "proposal-1");

      // Should be in cooldown
      expect(trigger.shouldFire(new Date())).toBe(false);
    });

    it("returns false when readiness is not ready", () => {
      trigger.setCachedReadiness(createReadyResult({ ready: false }));

      expect(trigger.shouldFire(new Date())).toBe(false);
    });

    it("returns false when no cached readiness exists", () => {
      expect(trigger.shouldFire(new Date())).toBe(false);
    });

    it("returns true after cooldown period expires", async () => {
      const config = createDefaultConfig({ cooldownMinutes: 0 }); // 0 minute cooldown for test
      trigger = new DeployTrigger(
        readinessChecker,
        approvalQueue,
        circuitBreaker,
        executor,
        config,
        mockLogger,
      );
      trigger.setCachedReadiness(createReadyResult());

      await trigger.onApprovalDecided("denied", "proposal-1");

      // Cooldown is 0 minutes, so it should fire immediately at a future time
      const futureDate = new Date(Date.now() + 1000);
      expect(trigger.shouldFire(futureDate)).toBe(true);
    });
  });

  describe("onFired", () => {
    it("logs proposal and enqueues in approval queue", () => {
      trigger.setCachedReadiness(createReadyResult());
      trigger.onFired(new Date());

      expect(executor.logProposal).toHaveBeenCalled();
      expect(approvalQueue.enqueue).toHaveBeenCalledWith(
        "deployment",
        expect.objectContaining({
          proposalId: "proposal-1",
          testPassed: true,
          gitClean: true,
        }),
        "deploy-readiness",
      );
    });

    it("sets proposalPending flag", () => {
      trigger.setCachedReadiness(createReadyResult());
      trigger.onFired(new Date());

      // Mock getPending to return a matching entry so proposalPending stays true
      vi.mocked(approvalQueue.getPending).mockReturnValue([
        { triggerName: "deploy-readiness", id: "approval-1", toolName: "deployment", params: {}, status: "pending" as const, createdAt: Date.now(), expiresAt: Date.now() + 1800000 },
      ]);
      expect(trigger.shouldFire(new Date())).toBe(false);
    });
  });

  describe("getNextRun", () => {
    it("returns null (event-driven)", () => {
      expect(trigger.getNextRun()).toBeNull();
    });
  });

  describe("getState", () => {
    it("returns active when no blockers", () => {
      expect(trigger.getState()).toBe("active");
    });

    it("returns disabled when circuit breaker is open", () => {
      circuitBreaker = createMockCircuitBreaker(true);
      trigger = new DeployTrigger(
        readinessChecker,
        approvalQueue,
        circuitBreaker,
        executor,
        createDefaultConfig(),
        mockLogger,
      );

      expect(trigger.getState()).toBe("disabled");
    });

    it("returns paused when in cooldown", async () => {
      trigger.setCachedReadiness(createReadyResult());
      await trigger.onApprovalDecided("denied", "proposal-1");

      expect(trigger.getState()).toBe("paused");
    });
  });

  describe("onApprovalDecided", () => {
    it("executes deployment on approval", async () => {
      const result = await trigger.onApprovalDecided("approved", "proposal-1", "admin");

      expect(executor.execute).toHaveBeenCalledWith({
        id: "proposal-1",
        approvedBy: "admin",
      });
      expect(result).toBeTruthy();
      expect(result?.success).toBe(true);
    });

    it("records success on circuit breaker after successful deploy", async () => {
      await trigger.onApprovalDecided("approved", "proposal-1");

      expect(circuitBreaker.recordSuccess).toHaveBeenCalled();
    });

    it("records failure on circuit breaker after failed deploy", async () => {
      vi.mocked(executor.execute).mockResolvedValueOnce({
        success: false,
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "Build failed",
        durationMs: 1000,
      });

      await trigger.onApprovalDecided("approved", "proposal-1");

      expect(circuitBreaker.recordFailure).toHaveBeenCalled();
    });

    it("sets cooldown on denial", async () => {
      const result = await trigger.onApprovalDecided("denied", "proposal-1");

      expect(result).toBeNull();
      expect(readinessChecker.invalidateCache).toHaveBeenCalled();
    });

    it("clears proposalPending on decision", async () => {
      trigger.setCachedReadiness(createReadyResult());
      trigger.onFired(new Date());

      // Mock getPending to return a matching entry so proposalPending stays true
      vi.mocked(approvalQueue.getPending).mockReturnValue([
        { triggerName: "deploy-readiness", id: "approval-1", toolName: "deployment", params: {}, status: "pending" as const, createdAt: Date.now(), expiresAt: Date.now() + 1800000 },
      ]);
      expect(trigger.shouldFire(new Date())).toBe(false);

      await trigger.onApprovalDecided("approved", "proposal-1");

      // After approval + execution, should be able to fire again
      trigger.setCachedReadiness(createReadyResult());
      expect(trigger.shouldFire(new Date())).toBe(true);
    });

    it("invalidates readiness cache after deployment", async () => {
      await trigger.onApprovalDecided("approved", "proposal-1");

      expect(readinessChecker.invalidateCache).toHaveBeenCalled();
    });

    it("handles execution error gracefully", async () => {
      vi.mocked(executor.execute).mockRejectedValueOnce(new Error("spawn error"));

      const result = await trigger.onApprovalDecided("approved", "proposal-1");

      expect(result).toBeNull();
      expect(circuitBreaker.recordFailure).toHaveBeenCalled();
      expect(readinessChecker.invalidateCache).toHaveBeenCalled();
    });
  });

  describe("triggerReadinessCheck", () => {
    it("forces a readiness check and updates cache", async () => {
      const readyResult = createReadyResult();
      vi.mocked(readinessChecker.checkReadiness).mockResolvedValueOnce(readyResult);

      const result = await trigger.triggerReadinessCheck();

      expect(readinessChecker.checkReadiness).toHaveBeenCalledWith(true);
      expect(result.ready).toBe(true);

      // After updating cache, shouldFire should return true
      expect(trigger.shouldFire(new Date())).toBe(true);
    });

    it("caches not-ready result so shouldFire returns false", async () => {
      vi.mocked(readinessChecker.checkReadiness).mockResolvedValueOnce(
        createReadyResult({ ready: false }),
      );

      await trigger.triggerReadinessCheck();

      expect(trigger.shouldFire(new Date())).toBe(false);
    });
  });

  describe("setCachedReadiness", () => {
    it("toggles shouldFire based on readiness", () => {
      trigger.setCachedReadiness(createReadyResult({ ready: true }));
      expect(trigger.shouldFire(new Date())).toBe(true);

      trigger.setCachedReadiness(createReadyResult({ ready: false }));
      expect(trigger.shouldFire(new Date())).toBe(false);
    });
  });

  describe("shouldFire — proposal expiry cleanup", () => {
    it("clears pending flag and allows fire when approval expired from queue", () => {
      trigger.setCachedReadiness(createReadyResult());

      // Fire to set proposalPending
      trigger.onFired(new Date());

      // Empty queue = proposal expired
      vi.mocked(approvalQueue.getPending).mockReturnValue([]);

      expect(trigger.shouldFire(new Date())).toBe(true);
    });
  });

  describe("onFired — defaults for missing readiness", () => {
    it("defaults payload fields when cachedReadiness is null", () => {
      // Do not set cached readiness
      trigger.onFired(new Date());

      expect(approvalQueue.enqueue).toHaveBeenCalledWith(
        "deployment",
        expect.objectContaining({
          testPassed: false,
          gitClean: false,
          branchMatch: false,
          readinessTimestamp: 0,
        }),
        "deploy-readiness",
      );
    });
  });

  describe("onApprovalDecided — executor not called on denial", () => {
    it("does not invoke executor.execute on denial", async () => {
      await trigger.onApprovalDecided("denied", "proposal-x", "reviewer");

      expect(executor.execute).not.toHaveBeenCalled();
    });
  });
});
