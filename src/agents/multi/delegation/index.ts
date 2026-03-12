/**
 * Delegation Module - Public Exports
 *
 * Re-exports all public types and classes from the delegation subsystem.
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

// Types and constants
export type {
  ModelTier,
  DelegationMode,
  DelegationStatus,
  DelegationTypeConfig,
  DelegationConfig,
  DelegationRequest,
  DelegationResult,
  DelegationStartedEvent,
  DelegationCompletedEvent,
  DelegationFailedEvent,
} from "./delegation-types.js";

export {
  DEFAULT_DELEGATION_TYPES,
  ESCALATION_CHAIN,
} from "./delegation-types.js";

// Tier Router
export { TierRouter } from "./tier-router.js";

// Delegation Log
export { DelegationLog } from "./delegation-log.js";
export type { DelegationLogEntry, DelegationStats } from "./delegation-log.js";

// Delegation Tool
export { DelegationTool, createDelegationTools } from "./delegation-tool.js";

// Delegation Manager
export { DelegationManager } from "./delegation-manager.js";
export type { DelegationManagerOptions } from "./delegation-manager.js";
