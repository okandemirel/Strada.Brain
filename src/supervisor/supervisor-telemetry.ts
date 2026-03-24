/**
 * Supervisor Brain - Telemetry Event Definitions
 *
 * Typed event map for all supervisor lifecycle events.
 * Used with TypedEventBus for structured observability across
 * triage, execution, verification, and conflict resolution phases.
 */

// =============================================================================
// SUPERVISOR EVENT MAP
// =============================================================================

/** Event map for all supervisor telemetry events */
export interface SupervisorEventMap {
  [key: string]: unknown;

  /** Supervisor activated for a complex task */
  "supervisor:activated": {
    taskId: string;
    complexity: string;
    nodeCount: number;
  };

  /** DAG plan ready with provider assignments */
  "supervisor:plan_ready": {
    dag: { rootId: string; nodeCount: number };
    assignments: Record<string, { provider: string; model: string }>;
  };

  /** A wave of parallel nodes begins execution */
  "supervisor:wave_start": {
    waveIndex: number;
    nodes: Array<{ nodeId: string; provider: string }>;
  };

  /** A single node begins execution */
  "supervisor:node_start": {
    nodeId: string;
    provider: string;
    model: string;
    wave: number;
  };

  /** A single node completes execution */
  "supervisor:node_complete": {
    nodeId: string;
    status: "ok" | "failed" | "skipped";
    duration: number;
    cost: number;
  };

  /** A node execution failed */
  "supervisor:node_failed": {
    nodeId: string;
    error: string;
    failureLevel: 1 | 2 | 3 | 4;
    nextAction: string;
  };

  /** A node is escalated to a different provider after failure */
  "supervisor:escalation": {
    nodeId: string;
    fromProvider: string;
    toProvider: string;
    reason: string;
  };

  /** A wave of parallel nodes completes */
  "supervisor:wave_done": {
    waveIndex: number;
    results: Array<{ nodeId: string; status: string }>;
    totalCost: number;
  };

  /** Cross-provider verification begins for a node */
  "supervisor:verify_start": {
    nodeId: string;
    verifierProvider: string;
  };

  /** Cross-provider verification completes for a node */
  "supervisor:verify_done": {
    nodeId: string;
    verdict: "approve" | "flag_issues" | "reject";
    issues?: string[];
  };

  /** File conflict detected between parallel node outputs */
  "supervisor:conflict": {
    fileConflicts: string[];
    resolution: string;
  };

  /** Supervisor execution completes */
  "supervisor:complete": {
    totalNodes: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cost: number;
    duration: number;
  };

  /** Supervisor execution aborted */
  "supervisor:aborted": {
    reason: string;
    completedNodes: number;
    partialResult: boolean;
  };
}
