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
}
