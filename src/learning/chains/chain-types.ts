/**
 * Chain Types -- Zod schemas and TypeScript types for tool chain synthesis
 *
 * Defines the contract layer for chain detection, synthesis, and composite tools.
 * Plans 02 and 03 build against these types.
 */

import { z } from "zod";
import type { TrajectoryStep } from "../types.js";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/**
 * Schema for a parameter mapping between chain steps.
 * Describes how data flows from one tool to the next in a chain.
 */
export const ChainStepMappingSchema = z.object({
  /** Which step in the chain this mapping applies to (0-indexed) */
  stepIndex: z.number().int().min(0),
  /** Name of the parameter being mapped */
  parameterName: z.string(),
  /** Where the parameter value comes from */
  source: z.enum(["userInput", "previousOutput", "constant"]),
  /** Key to extract from the source (e.g., a field name in the previous output) */
  sourceKey: z.string().optional(),
  /** Default value if the source is unavailable */
  defaultValue: z.unknown().optional(),
});

/**
 * Schema for chain metadata stored as an instinct's action field.
 * Describes a complete tool chain pattern.
 */
export const ChainMetadataSchema = z.object({
  /** Ordered sequence of tool names in the chain (2-10 tools) */
  toolSequence: z.array(z.string()).min(2).max(10),
  /** How parameters flow between steps */
  parameterMappings: z.array(ChainStepMappingSchema),
  /** Observed success rate of this chain pattern (0-1) */
  successRate: z.number().min(0).max(1),
  /** Number of times this chain pattern was observed */
  occurrences: z.number().int().min(1),
  /** Trajectory IDs that sourced this chain */
  sourceTrajectoryIds: z.array(z.string()).optional(),
});

/**
 * Schema for LLM-generated chain output during synthesis.
 * The LLM produces a name, description, and parameter mappings for a new composite tool.
 */
export const LLMChainOutputSchema = z.object({
  /** Snake_case name for the composite tool (3-50 chars, lowercase) */
  name: z.string().min(3).max(50).regex(/^[a-z][a-z0-9_]*$/),
  /** Human-readable description (10-300 chars) */
  description: z.string().min(10).max(300),
  /** Parameter mappings for the chain */
  parameterMappings: z.array(ChainStepMappingSchema),
  /** Optional JSON schema for the composite tool's input */
  inputSchema: z.record(z.unknown()).optional(),
});

// =============================================================================
// INFERRED TYPES
// =============================================================================

/** A single parameter mapping between chain steps */
export type ChainStepMapping = z.infer<typeof ChainStepMappingSchema>;

/** Metadata describing a tool chain pattern (stored in instinct.action) */
export type ChainMetadata = z.infer<typeof ChainMetadataSchema>;

/** Output produced by the LLM during chain synthesis */
export type LLMChainOutput = z.infer<typeof LLMChainOutputSchema>;

// =============================================================================
// HELPERS
// =============================================================================

/** Compute success rate from a candidate chain */
export function computeSuccessRate(candidate: { occurrences: number; successCount: number }): number {
  return candidate.occurrences > 0 ? candidate.successCount / candidate.occurrences : 0;
}

/** Default metadata for composite tools in the registry */
export const COMPOSITE_TOOL_METADATA = {
  category: "composite" as const,
  dangerous: true,
  requiresConfirmation: false,
  readOnly: false,
} as const;

/** Compute composite tool metadata inheriting the most restrictive flags from component tools */
export function computeCompositeMetadata(
  componentMeta: Array<{ dangerous?: boolean; requiresConfirmation?: boolean } | undefined>,
): { category: "composite"; dangerous: boolean; requiresConfirmation: boolean; readOnly: false } {
  const dangerous = componentMeta.some((m) => m?.dangerous);
  const requiresConfirmation = componentMeta.some((m) => m?.requiresConfirmation);
  return { category: "composite" as const, dangerous, requiresConfirmation, readOnly: false };
}

/**
 * Parse and validate LLM JSON output against a Zod schema.
 * Strips markdown code fences before parsing.
 */
export function parseLLMJsonOutput<T>(text: string, schema: z.ZodSchema<T>): T | null {
  try {
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch?.[1]) {
      cleaned = fenceMatch[1].trim();
    }
    const parsed = JSON.parse(cleaned);
    const result = schema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

/** Truncate a string to maxLen, appending "..." if truncated */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "...";
}

/** Safely stringify a value for LLM prompts (truncated to limit) */
export function safeStringify(value: unknown, maxLen = 500): string {
  try {
    return truncate(JSON.stringify(value), maxLen);
  } catch {
    return truncate(String(value), maxLen);
  }
}

/** Check if shorter toolNames appear as a contiguous subsequence within longer toolNames */
export function isContiguousSubsequence(shorter: string[], longer: string[]): boolean {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    let match = true;
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// =============================================================================
// V2 ZOD SCHEMAS (Phase 22 -- Chain Resilience)
// =============================================================================

/**
 * Schema for a compensating action that can undo a chain step.
 * Generated by LLM at synthesis time.
 */
export const CompensatingActionSchema = z.object({
  /** Tool name to execute for compensation */
  toolName: z.string(),
  /** Maps compensation input params to source step output keys */
  inputMappings: z.record(z.string()),
});

/**
 * Schema for a single step in a chain DAG.
 * Describes dependencies, reversibility, and compensation.
 */
export const ChainStepNodeSchema = z.object({
  /** Unique identifier for this step within the chain */
  stepId: z.string(),
  /** Name of the tool to execute */
  toolName: z.string(),
  /** Step IDs this step depends on (default: no dependencies) */
  dependsOn: z.array(z.string()).default([]),
  /** Whether this step can be reversed (default: false) */
  reversible: z.boolean().default(false),
  /** Optional compensating action to undo this step */
  compensatingAction: CompensatingActionSchema.optional(),
});

/**
 * V2 chain metadata schema with DAG structure and reversibility info.
 * V1 ChainMetadataSchema remains untouched for backward compatibility.
 */
export const ChainMetadataV2Schema = z.object({
  /** Schema version -- must be 2 */
  version: z.literal(2),
  /** Ordered sequence of tool names (backward compat) */
  toolSequence: z.array(z.string()).min(2).max(10),
  /** DAG step nodes with dependencies and compensation */
  steps: z.array(ChainStepNodeSchema).min(2).max(10),
  /** How parameters flow between steps */
  parameterMappings: z.array(ChainStepMappingSchema),
  /** Whether all steps in the chain are reversible */
  isFullyReversible: z.boolean(),
  /** Observed success rate of this chain pattern (0-1) */
  successRate: z.number().min(0).max(1),
  /** Number of times this chain pattern was observed */
  occurrences: z.number().int().min(1),
  /** Trajectory IDs that sourced this chain */
  sourceTrajectoryIds: z.array(z.string()).optional(),
});

/**
 * V2 LLM chain output schema -- extends V1 with steps and reversibility.
 */
export const LLMChainOutputV2Schema = LLMChainOutputSchema.extend({
  /** DAG step nodes generated by LLM */
  steps: z.array(ChainStepNodeSchema),
  /** Whether all steps are reversible */
  isFullyReversible: z.boolean(),
});

// =============================================================================
// V2 INFERRED TYPES
// =============================================================================

/** A compensating action for a chain step */
export type CompensatingAction = z.infer<typeof CompensatingActionSchema>;

/** A single step node in the chain DAG */
export type ChainStepNode = z.infer<typeof ChainStepNodeSchema>;

/** V2 chain metadata with DAG and reversibility */
export type ChainMetadataV2 = z.infer<typeof ChainMetadataV2Schema>;

/** V2 LLM chain output with steps and reversibility */
export type LLMChainOutputV2 = z.infer<typeof LLMChainOutputV2Schema>;

// =============================================================================
// V2 RUNTIME INTERFACES
// =============================================================================

/** Result of a single step's rollback attempt */
export interface RollbackStepResult {
  readonly stepId: string;
  readonly tool: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly state: "rolledBack" | "rollbackFailed";
}

/** Complete rollback report for a chain execution failure */
export interface RollbackReport {
  /** Step IDs that completed before failure */
  readonly stepsCompleted: string[];
  /** Results of each step's rollback attempt */
  readonly stepsRolledBack: RollbackStepResult[];
  /** Step IDs where rollback failed */
  readonly rollbackFailures: string[];
  /** Overall rollback outcome */
  readonly finalState: "fully_rolled_back" | "partially_rolled_back" | "rollback_failed";
}

/** Configuration for chain resilience features */
export interface ChainResilienceConfig {
  readonly rollbackEnabled: boolean;
  readonly parallelEnabled: boolean;
  readonly maxParallelBranches: number;
  readonly compensationTimeoutMs: number;
}

// =============================================================================
// V1 -> V2 MIGRATION
// =============================================================================

/**
 * Migrate V1 ChainMetadata to V2 format.
 * Generates sequential steps from toolSequence with dependency chaining.
 * All steps are marked as non-reversible (no compensation data in V1).
 * In-memory only -- original instinct is unchanged.
 */
export function migrateV1toV2(v1: ChainMetadata): ChainMetadataV2 {
  const steps: ChainStepNode[] = v1.toolSequence.map((toolName, i) => ({
    stepId: `step_${i}`,
    toolName,
    dependsOn: i > 0 ? [`step_${i - 1}`] : [],
    reversible: false,
  }));

  return {
    version: 2,
    toolSequence: v1.toolSequence,
    steps,
    parameterMappings: v1.parameterMappings,
    isFullyReversible: false,
    successRate: v1.successRate,
    occurrences: v1.occurrences,
    sourceTrajectoryIds: v1.sourceTrajectoryIds,
  };
}

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * A candidate chain pattern discovered by the detector.
 * Represents a recurring tool sequence that may be worth synthesizing.
 */
export interface CandidateChain {
  /** Ordered tool names in the sequence */
  readonly toolNames: string[];
  /** How many times this sequence was observed */
  readonly occurrences: number;
  /** How many of those occurrences were successful */
  readonly successCount: number;
  /** Sample trajectory steps for LLM analysis */
  readonly sampleSteps: TrajectoryStep[][];
  /** Unique key for deduplication (e.g., "file_read->file_write") */
  readonly key: string;
}

/**
 * Configuration for the tool chain synthesis system.
 * All fields are configurable via environment variables.
 */
export interface ToolChainConfig {
  /** Master toggle for tool chain detection and synthesis */
  readonly enabled: boolean;
  /** Minimum occurrences before a chain is considered for synthesis */
  readonly minOccurrences: number;
  /** Minimum success rate threshold for chain synthesis */
  readonly successRateThreshold: number;
  /** Maximum number of active composite tools */
  readonly maxActive: number;
  /** Maximum age in days before a chain is invalidated */
  readonly maxAgeDays: number;
  /** Maximum LLM calls per detection cycle */
  readonly llmBudgetPerCycle: number;
  /** Minimum number of tools in a chain */
  readonly minChainLength: number;
  /** Maximum number of tools in a chain */
  readonly maxChainLength: number;
  /** Interval between detection cycles in milliseconds */
  readonly detectionIntervalMs: number;
  /** Chain resilience configuration (Phase 22) */
  readonly resilience: ChainResilienceConfig;
}
