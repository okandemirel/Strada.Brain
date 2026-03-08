/**
 * Chain module barrel exports
 *
 * Re-exports chain types, schemas, and core classes.
 */

export {
  ChainStepMappingSchema,
  ChainMetadataSchema,
  LLMChainOutputSchema,
  computeSuccessRate,
  COMPOSITE_TOOL_METADATA,
  computeCompositeMetadata,
  parseLLMJsonOutput,
  safeStringify,
  isContiguousSubsequence,
  type ChainStepMapping,
  type ChainMetadata,
  type LLMChainOutput,
  type CandidateChain,
  type ToolChainConfig,
} from "./chain-types.js";

export { ChainDetector } from "./chain-detector.js";
export { ChainSynthesizer } from "./chain-synthesizer.js";
export { CompositeTool, type CompositeToolMetadata } from "./composite-tool.js";
export { ChainManager } from "./chain-manager.js";
