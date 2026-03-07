/**
 * Chain module barrel exports
 *
 * Re-exports chain types and schemas.
 * Will be extended in Plan 02 with ChainDetector, ChainSynthesizer, CompositeTool.
 */

export {
  ChainStepMappingSchema,
  ChainMetadataSchema,
  LLMChainOutputSchema,
  type ChainStepMapping,
  type ChainMetadata,
  type LLMChainOutput,
  type CandidateChain,
  type ToolChainConfig,
} from "./chain-types.js";
