/**
 * DeployTrigger
 *
 * Implements ITrigger for deployment readiness detection.
 * When the project is ready (tests pass + git clean + correct branch),
 * proposes deployment via ApprovalQueue for human approval.
 *
 * Features:
 * - Readiness-based proposal (not scheduled)
 * - Approval queue integration for human gate
 * - Cooldown after rejection
 * - Circuit breaker auto-disable after consecutive failures
 *
 * Requirements: DEPLOY-01 (detection + proposal), DEPLOY-02 (human approval)
 */

import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
} from "../daemon-types.js";
import type { ReadinessChecker } from "../deployment/readiness-checker.js";
import type { ReadinessResult, DeploymentConfig, DeployResult } from "../deployment/deployment-types.js";
import type { DeploymentExecutor } from "../deployment/deployment-executor.js";
import type { ApprovalQueue } from "../security/approval-queue.js";
import type { CircuitBreaker } from "../resilience/circuit-breaker.js";

export interface DeployTriggerLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export class DeployTrigger implements ITrigger {
  readonly metadata: TriggerMetadata = {
    name: "deploy-readiness",
    description: "Deployment readiness detection",
    type: "deploy",
  };

  private readonly readinessChecker: ReadinessChecker;
  private readonly approvalQueue: ApprovalQueue;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly executor: DeploymentExecutor;
  private readonly config: DeploymentConfig;
  private readonly logger: DeployTriggerLogger;
  private proposalPending = false;
  private lastRejectionTime = 0;
  private cachedReadiness: ReadinessResult | null = null;

  /** Cooldown duration in ms, derived from config */
  private get cooldownMs(): number {
    return this.config.cooldownMinutes * 60_000;
  }

  constructor(
    readinessChecker: ReadinessChecker,
    approvalQueue: ApprovalQueue,
    circuitBreaker: CircuitBreaker,
    executor: DeploymentExecutor,
    config: DeploymentConfig,
    logger: DeployTriggerLogger,
  ) {
    this.readinessChecker = readinessChecker;
    this.approvalQueue = approvalQueue;
    this.circuitBreaker = circuitBreaker;
    this.executor = executor;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Check if the trigger should fire.
   *
   * Returns true when:
   * - Cached readiness shows ready=true
   * - No proposal currently pending
   * - Cooldown period has elapsed since last rejection
   * - Circuit breaker is not open
   * - Executor is not running a deployment
   */
  shouldFire(now: Date): boolean {
    // Circuit breaker open = auto-disabled
    if (this.circuitBreaker.isOpen()) {
      return false;
    }

    // Deployment already in progress
    if (this.executor.isInProgress()) {
      return false;
    }

    // Proposal already pending -- but check if it expired in the approval queue
    if (this.proposalPending) {
      const pendingApprovals = this.approvalQueue.getPending();
      const stillPending = pendingApprovals.some(
        (entry) => entry.triggerName === "deploy-readiness",
      );
      if (stillPending) {
        return false;
      }
      // Proposal expired or was decided without callback -- clean up
      this.proposalPending = false;
    }

    // Cooldown after rejection
    if (this.lastRejectionTime > 0 && now.getTime() < this.lastRejectionTime + this.cooldownMs) {
      return false;
    }

    // Check cached readiness
    if (!this.cachedReadiness || !this.cachedReadiness.ready) {
      return false;
    }

    return true;
  }

  /**
   * Called when the trigger fires. Logs proposal and enqueues for approval.
   */
  onFired(_now: Date): void {
    const proposalId = this.executor.logProposal();

    this.approvalQueue.enqueue(
      "deployment",
      {
        proposalId,
        testPassed: this.cachedReadiness?.testPassed ?? false,
        gitClean: this.cachedReadiness?.gitClean ?? false,
        branchMatch: this.cachedReadiness?.branchMatch ?? false,
        readinessTimestamp: this.cachedReadiness?.timestamp ?? 0,
      },
      "deploy-readiness",
    );

    this.proposalPending = true;
    this.logger.info("Deployment proposed", { proposalId });
  }

  /** Event-driven trigger -- no scheduled next run */
  getNextRun(): Date | null {
    return null;
  }

  /** Get current trigger state based on circuit breaker and cooldown */
  getState(): TriggerState {
    if (this.circuitBreaker.isOpen()) {
      return "disabled";
    }
    if (this.lastRejectionTime > 0 && Date.now() < this.lastRejectionTime + this.cooldownMs) {
      return "paused";
    }
    return "active";
  }

  /**
   * Handle approval queue decision for a deployment proposal.
   *
   * - Approved: execute deployment, record result on circuit breaker
   * - Denied: set cooldown, clear pending, invalidate readiness cache
   */
  async onApprovalDecided(
    decision: "approved" | "denied",
    proposalId: string,
    decidedBy?: string,
  ): Promise<DeployResult | null> {
    this.proposalPending = false;

    if (decision === "denied") {
      this.lastRejectionTime = Date.now();
      this.readinessChecker.invalidateCache();
      this.logger.info("Deployment denied", { proposalId, decidedBy });
      return null;
    }

    // Approved -- execute
    this.logger.info("Deployment approved, executing", { proposalId, decidedBy });

    try {
      const result = await this.executor.execute({
        id: proposalId,
        approvedBy: decidedBy,
      });

      if (result.success) {
        this.circuitBreaker.recordSuccess();
      } else {
        this.circuitBreaker.recordFailure();
      }

      // Invalidate readiness cache after deployment attempt
      this.readinessChecker.invalidateCache();

      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure();
      this.readinessChecker.invalidateCache();
      this.logger.error("Deployment execution error", { proposalId, error: String(err) });
      return null;
    }
  }

  /**
   * Force a readiness check and update cached result.
   * Called by heartbeat after task/goal completion.
   */
  async triggerReadinessCheck(): Promise<ReadinessResult> {
    const result = await this.readinessChecker.checkReadiness(true);
    this.cachedReadiness = result;
    return result;
  }

  /** Update cached readiness from external source */
  setCachedReadiness(result: ReadinessResult): void {
    this.cachedReadiness = result;
  }
}
