/**
 * Chain module barrel exports
 *
 * Re-exports chain types, schemas, and core classes.
 */

export {
  ChainStepMappingSchema,
  ChainMetadataSchema,
  LLMChainOutputSchema,
  CompensatingActionSchema,
  ChainStepNodeSchema,
  ChainMetadataV2Schema,
  LLMChainOutputV2Schema,
  migrateV1toV2,
  computeSuccessRate,
  COMPOSITE_TOOL_METADATA,
  computeCompositeMetadata,
  parseLLMJsonOutput,
  safeStringify,
  isContiguousSubsequence,
  type ChainStepMapping,
  type ChainMetadata,
  type LLMChainOutput,
  type CompensatingAction,
  type ChainStepNode,
  type ChainMetadataV2,
  type LLMChainOutputV2,
  type RollbackReport,
  type RollbackStepResult,
  type ChainResilienceConfig,
  type CandidateChain,
  type ToolChainConfig,
} from "./chain-types.js";

export { validateChainDAG, computeChainWaves, type ChainDAGValidationResult } from "./chain-dag.js";
export { executeRollback } from "./chain-rollback.js";

export { ChainDetector } from "./chain-detector.js";
export { ChainSynthesizer } from "./chain-synthesizer.js";
export { CompositeTool, type CompositeToolMetadata } from "./composite-tool.js";
export { ChainManager } from "./chain-manager.js";
export { ChainValidator } from "./chain-validator.js";
