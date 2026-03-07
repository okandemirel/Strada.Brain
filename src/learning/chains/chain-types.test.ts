import { describe, it, expect } from "vitest";
import {
  ChainStepMappingSchema,
  ChainMetadataSchema,
  LLMChainOutputSchema,
  type ChainMetadata,
  type LLMChainOutput,
  type ChainStepMapping,
  type CandidateChain,
  type ToolChainConfig,
} from "./chain-types.ts";
import type { InstinctType } from "../types.ts";
import type { LearningEventMap } from "../../core/event-bus.ts";
import { ToolCategories, type ToolCategory } from "../../core/tool-registry.ts";

describe("ChainStepMappingSchema", () => {
  it("should validate a valid step mapping", () => {
    const valid = {
      stepIndex: 0,
      parameterName: "filePath",
      source: "userInput" as const,
    };
    const result = ChainStepMappingSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should accept optional sourceKey and defaultValue", () => {
    const valid = {
      stepIndex: 1,
      parameterName: "content",
      source: "previousOutput" as const,
      sourceKey: "outputPath",
      defaultValue: "fallback",
    };
    const result = ChainStepMappingSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should reject negative stepIndex", () => {
    const invalid = {
      stepIndex: -1,
      parameterName: "filePath",
      source: "userInput" as const,
    };
    const result = ChainStepMappingSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject non-integer stepIndex", () => {
    const invalid = {
      stepIndex: 1.5,
      parameterName: "filePath",
      source: "userInput" as const,
    };
    const result = ChainStepMappingSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject invalid source enum value", () => {
    const invalid = {
      stepIndex: 0,
      parameterName: "filePath",
      source: "unknown",
    };
    const result = ChainStepMappingSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe("ChainMetadataSchema", () => {
  it("should validate a valid chain metadata", () => {
    const valid = {
      toolSequence: ["file_read", "file_write"],
      parameterMappings: [],
      successRate: 0.85,
      occurrences: 5,
    };
    const result = ChainMetadataSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should accept optional sourceTrajectoryIds", () => {
    const valid = {
      toolSequence: ["file_read", "file_write"],
      parameterMappings: [],
      successRate: 0.85,
      occurrences: 5,
      sourceTrajectoryIds: ["traj_1", "traj_2"],
    };
    const result = ChainMetadataSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should reject toolSequence with fewer than 2 tools", () => {
    const invalid = {
      toolSequence: ["file_read"],
      parameterMappings: [],
      successRate: 0.85,
      occurrences: 1,
    };
    const result = ChainMetadataSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject toolSequence with more than 10 tools", () => {
    const invalid = {
      toolSequence: Array.from({ length: 11 }, (_, i) => `tool_${i}`),
      parameterMappings: [],
      successRate: 0.85,
      occurrences: 1,
    };
    const result = ChainMetadataSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject successRate outside 0-1 range", () => {
    const result = ChainMetadataSchema.safeParse({
      toolSequence: ["a", "b"],
      parameterMappings: [],
      successRate: 1.5,
      occurrences: 1,
    });
    expect(result.success).toBe(false);
  });

  it("should reject occurrences less than 1", () => {
    const result = ChainMetadataSchema.safeParse({
      toolSequence: ["a", "b"],
      parameterMappings: [],
      successRate: 0.8,
      occurrences: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("LLMChainOutputSchema", () => {
  it("should validate a valid LLM output", () => {
    const valid = {
      name: "read_and_write",
      description: "Reads a file then writes the content to another location",
      parameterMappings: [],
    };
    const result = LLMChainOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should accept optional inputSchema", () => {
    const valid = {
      name: "build_and_test",
      description: "Build the project then run test suite on the result",
      parameterMappings: [],
      inputSchema: { filePath: "string", outputDir: "string" },
    };
    const result = LLMChainOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should reject name shorter than 3 chars", () => {
    const result = LLMChainOutputSchema.safeParse({
      name: "ab",
      description: "A valid description that is long enough",
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });

  it("should reject name longer than 50 chars", () => {
    const result = LLMChainOutputSchema.safeParse({
      name: "a".repeat(51),
      description: "A valid description that is long enough",
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });

  it("should reject name not matching snake_case pattern", () => {
    const result = LLMChainOutputSchema.safeParse({
      name: "CamelCase",
      description: "A valid description that is long enough",
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });

  it("should reject description shorter than 10 chars", () => {
    const result = LLMChainOutputSchema.safeParse({
      name: "valid_name",
      description: "Too short",
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });

  it("should reject description longer than 300 chars", () => {
    const result = LLMChainOutputSchema.safeParse({
      name: "valid_name",
      description: "x".repeat(301),
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("CandidateChain type", () => {
  it("should have the correct shape", () => {
    const candidate: CandidateChain = {
      toolNames: ["file_read", "file_write"],
      occurrences: 3,
      successCount: 2,
      sampleSteps: [],
      key: "file_read->file_write",
    };
    expect(candidate.toolNames).toHaveLength(2);
    expect(candidate.occurrences).toBe(3);
    expect(candidate.successCount).toBe(2);
    expect(candidate.key).toBe("file_read->file_write");
  });
});

describe("ToolChainConfig type", () => {
  it("should have all 9 fields", () => {
    const config: ToolChainConfig = {
      enabled: true,
      minOccurrences: 3,
      successRateThreshold: 0.8,
      maxActive: 10,
      maxAgeDays: 30,
      llmBudgetPerCycle: 3,
      minChainLength: 2,
      maxChainLength: 5,
      detectionIntervalMs: 300000,
    };
    expect(Object.keys(config)).toHaveLength(9);
  });
});

describe("InstinctType includes 'tool_chain'", () => {
  it("should accept 'tool_chain' as a valid InstinctType", () => {
    const type: InstinctType = "tool_chain";
    expect(type).toBe("tool_chain");
  });
});

describe("LearningEventMap includes chain events", () => {
  it("should include chain:detected event type", () => {
    // Type assertion -- if ChainDetectedEvent doesn't exist, TS compilation fails
    const eventMap: LearningEventMap = {} as LearningEventMap;
    type DetectedType = LearningEventMap["chain:detected"];
    // Verify the event key exists by checking a valid assignment compiles
    const _detected: DetectedType = {
      chainName: "test",
      toolSequence: ["a", "b"],
      occurrences: 1,
      successRate: 0.9,
      instinctId: "instinct_1",
      timestamp: Date.now(),
    };
    expect(_detected.chainName).toBe("test");
  });

  it("should include chain:executed event type", () => {
    type ExecutedType = LearningEventMap["chain:executed"];
    const _executed: ExecutedType = {
      chainName: "test",
      success: true,
      stepResults: [{ tool: "a", success: true, durationMs: 100 }],
      totalDurationMs: 100,
      timestamp: Date.now(),
    };
    expect(_executed.success).toBe(true);
  });

  it("should include chain:invalidated event type", () => {
    type InvalidatedType = LearningEventMap["chain:invalidated"];
    const _invalidated: InvalidatedType = {
      chainName: "test",
      reason: "success rate dropped",
      timestamp: Date.now(),
    };
    expect(_invalidated.reason).toBe("success rate dropped");
  });
});

describe("ToolCategories includes COMPOSITE", () => {
  it("should have COMPOSITE category", () => {
    expect(ToolCategories.COMPOSITE).toBe("composite");
  });

  it("should accept 'composite' as ToolCategory", () => {
    const category: ToolCategory = "composite";
    expect(category).toBe("composite");
  });
});
