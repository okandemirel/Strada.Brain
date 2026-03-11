import { describe, it, expect } from "vitest";
import {
  ChainStepMappingSchema,
  ChainMetadataSchema,
  LLMChainOutputSchema,
  CompensatingActionSchema,
  ChainStepNodeSchema,
  ChainMetadataV2Schema,
  LLMChainOutputV2Schema,
  migrateV1toV2,
  type ChainMetadata,
  type ChainMetadataV2,
  type LLMChainOutput,
  type LLMChainOutputV2,
  type ChainStepMapping,
  type ChainStepNode,
  type CompensatingAction,
  type CandidateChain,
  type ToolChainConfig,
  type RollbackReport,
  type RollbackStepResult,
  type ChainResilienceConfig,
} from "./chain-types.ts";
import type { InstinctType } from "../types.ts";
import type { LearningEventMap, ChainRollbackEvent } from "../../core/event-bus.ts";
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
  it("should have all 10 fields", () => {
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
      resilience: {
        rollbackEnabled: true,
        parallelEnabled: true,
        maxParallelBranches: 4,
        compensationTimeoutMs: 30000,
      },
    };
    expect(Object.keys(config)).toHaveLength(10);
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

// =========================================================================
// V2 Type Schemas (Phase 22)
// =========================================================================

describe("CompensatingActionSchema", () => {
  it("should validate a valid compensating action", () => {
    const valid = {
      toolName: "file_delete",
      inputMappings: { filePath: "outputPath" },
    };
    const result = CompensatingActionSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should accept empty inputMappings", () => {
    const valid = { toolName: "undo_create", inputMappings: {} };
    const result = CompensatingActionSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should reject missing toolName", () => {
    const invalid = { inputMappings: {} };
    const result = CompensatingActionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe("ChainStepNodeSchema", () => {
  it("should validate a minimal step node with defaults", () => {
    const valid = { stepId: "step_1", toolName: "file_read" };
    const result = ChainStepNodeSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual([]);
      expect(result.data.reversible).toBe(false);
      expect(result.data.compensatingAction).toBeUndefined();
    }
  });

  it("should validate a fully specified step node", () => {
    const valid = {
      stepId: "step_2",
      toolName: "file_write",
      dependsOn: ["step_1"],
      reversible: true,
      compensatingAction: {
        toolName: "file_delete",
        inputMappings: { path: "outputPath" },
      },
    };
    const result = ChainStepNodeSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reversible).toBe(true);
      expect(result.data.compensatingAction?.toolName).toBe("file_delete");
    }
  });

  it("should reject missing stepId", () => {
    const invalid = { toolName: "file_read" };
    const result = ChainStepNodeSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject missing toolName", () => {
    const invalid = { stepId: "step_1" };
    const result = ChainStepNodeSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe("ChainMetadataV2Schema", () => {
  const validV2 = {
    version: 2,
    toolSequence: ["file_read", "file_write"],
    steps: [
      { stepId: "step_0", toolName: "file_read" },
      { stepId: "step_1", toolName: "file_write", dependsOn: ["step_0"] },
    ],
    parameterMappings: [],
    isFullyReversible: false,
    successRate: 0.85,
    occurrences: 5,
  };

  it("should validate valid V2 metadata", () => {
    const result = ChainMetadataV2Schema.safeParse(validV2);
    expect(result.success).toBe(true);
  });

  it("should reject V1 metadata (missing version:2)", () => {
    const v1Data = {
      toolSequence: ["file_read", "file_write"],
      parameterMappings: [],
      successRate: 0.85,
      occurrences: 5,
    };
    const result = ChainMetadataV2Schema.safeParse(v1Data);
    expect(result.success).toBe(false);
  });

  it("should reject version:1", () => {
    const result = ChainMetadataV2Schema.safeParse({ ...validV2, version: 1 });
    expect(result.success).toBe(false);
  });

  it("should reject fewer than 2 steps", () => {
    const result = ChainMetadataV2Schema.safeParse({
      ...validV2,
      steps: [{ stepId: "step_0", toolName: "file_read" }],
    });
    expect(result.success).toBe(false);
  });

  it("should reject more than 10 steps", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      stepId: `step_${i}`,
      toolName: `tool_${i}`,
    }));
    const result = ChainMetadataV2Schema.safeParse({ ...validV2, steps });
    expect(result.success).toBe(false);
  });

  it("should accept optional sourceTrajectoryIds", () => {
    const result = ChainMetadataV2Schema.safeParse({
      ...validV2,
      sourceTrajectoryIds: ["traj_1"],
    });
    expect(result.success).toBe(true);
  });
});

describe("LLMChainOutputV2Schema", () => {
  it("should validate a valid V2 LLM output", () => {
    const valid = {
      name: "read_and_write",
      description: "Reads a file then writes the content to another location",
      parameterMappings: [],
      steps: [
        { stepId: "step_0", toolName: "file_read" },
        { stepId: "step_1", toolName: "file_write", dependsOn: ["step_0"] },
      ],
      isFullyReversible: false,
    };
    const result = LLMChainOutputV2Schema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("should reject missing steps array", () => {
    const invalid = {
      name: "read_and_write",
      description: "Reads a file then writes the content to another location",
      parameterMappings: [],
      isFullyReversible: false,
    };
    const result = LLMChainOutputV2Schema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject missing isFullyReversible", () => {
    const invalid = {
      name: "read_and_write",
      description: "Reads a file then writes the content to another location",
      parameterMappings: [],
      steps: [
        { stepId: "step_0", toolName: "file_read" },
        { stepId: "step_1", toolName: "file_write", dependsOn: ["step_0"] },
      ],
    };
    const result = LLMChainOutputV2Schema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe("migrateV1toV2", () => {
  it("should convert V1 metadata to valid V2 with sequential steps", () => {
    const v1: ChainMetadata = {
      toolSequence: ["file_read", "file_write", "git_commit"],
      parameterMappings: [],
      successRate: 0.85,
      occurrences: 5,
    };
    const v2 = migrateV1toV2(v1);

    expect(v2.version).toBe(2);
    expect(v2.steps).toHaveLength(3);
    expect(v2.isFullyReversible).toBe(false);

    // Step 0 has no dependencies
    expect(v2.steps[0].stepId).toBe("step_0");
    expect(v2.steps[0].toolName).toBe("file_read");
    expect(v2.steps[0].dependsOn).toEqual([]);
    expect(v2.steps[0].reversible).toBe(false);

    // Step 1 depends on step 0
    expect(v2.steps[1].stepId).toBe("step_1");
    expect(v2.steps[1].toolName).toBe("file_write");
    expect(v2.steps[1].dependsOn).toEqual(["step_0"]);

    // Step 2 depends on step 1
    expect(v2.steps[2].stepId).toBe("step_2");
    expect(v2.steps[2].toolName).toBe("git_commit");
    expect(v2.steps[2].dependsOn).toEqual(["step_1"]);
  });

  it("should produce V2 that passes ChainMetadataV2Schema validation", () => {
    const v1: ChainMetadata = {
      toolSequence: ["a", "b"],
      parameterMappings: [],
      successRate: 1.0,
      occurrences: 10,
      sourceTrajectoryIds: ["traj_1"],
    };
    const v2 = migrateV1toV2(v1);
    const result = ChainMetadataV2Schema.safeParse(v2);
    expect(result.success).toBe(true);
  });

  it("should preserve sourceTrajectoryIds from V1", () => {
    const v1: ChainMetadata = {
      toolSequence: ["a", "b"],
      parameterMappings: [],
      successRate: 0.5,
      occurrences: 3,
      sourceTrajectoryIds: ["t1", "t2"],
    };
    const v2 = migrateV1toV2(v1);
    expect(v2.sourceTrajectoryIds).toEqual(["t1", "t2"]);
  });
});

describe("RollbackReport type", () => {
  it("should have the correct shape", () => {
    const report: RollbackReport = {
      stepsCompleted: ["step_0", "step_1"],
      stepsRolledBack: [
        { stepId: "step_1", tool: "undo_write", success: true, durationMs: 100, state: "rolledBack" },
      ],
      rollbackFailures: [],
      finalState: "fully_rolled_back",
    };
    expect(report.finalState).toBe("fully_rolled_back");
    expect(report.stepsRolledBack[0].state).toBe("rolledBack");
  });

  it("should support rollbackFailed state", () => {
    const report: RollbackReport = {
      stepsCompleted: ["step_0"],
      stepsRolledBack: [
        { stepId: "step_0", tool: "undo_read", success: false, durationMs: 500, state: "rollbackFailed" },
      ],
      rollbackFailures: ["step_0"],
      finalState: "rollback_failed",
    };
    expect(report.finalState).toBe("rollback_failed");
    expect(report.rollbackFailures).toContain("step_0");
  });
});

describe("ChainResilienceConfig type", () => {
  it("should have all 4 fields", () => {
    const config: ChainResilienceConfig = {
      rollbackEnabled: true,
      parallelEnabled: true,
      maxParallelBranches: 4,
      compensationTimeoutMs: 30000,
    };
    expect(Object.keys(config)).toHaveLength(4);
  });
});

describe("ToolChainConfig resilience extension", () => {
  it("should have resilience sub-object", () => {
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
      resilience: {
        rollbackEnabled: true,
        parallelEnabled: true,
        maxParallelBranches: 4,
        compensationTimeoutMs: 30000,
      },
    };
    expect(config.resilience.rollbackEnabled).toBe(true);
    expect(config.resilience.maxParallelBranches).toBe(4);
  });
});

describe("LearningEventMap includes chain:rollback", () => {
  it("should include chain:rollback event type", () => {
    const event: ChainRollbackEvent = {
      chainName: "test_chain",
      failedStep: "step_2",
      compensationResults: [
        { stepId: "step_1", tool: "undo_write", success: true, durationMs: 100, state: "rolledBack" },
      ],
      totalDurationMs: 200,
      timestamp: Date.now(),
    };
    expect(event.chainName).toBe("test_chain");
    expect(event.compensationResults[0].state).toBe("rolledBack");
  });
});

describe("ChainExecutionEvent V2 extensions", () => {
  it("should accept optional parallelBranches and rollbackReport", () => {
    type ExecutedType = LearningEventMap["chain:executed"];
    const event: ExecutedType = {
      chainName: "test",
      success: false,
      stepResults: [{ tool: "a", success: false, durationMs: 100 }],
      totalDurationMs: 100,
      timestamp: Date.now(),
      parallelBranches: 3,
      cancelledSteps: ["step_3"],
      forwardRecovery: false,
    };
    expect(event.parallelBranches).toBe(3);
    expect(event.cancelledSteps).toEqual(["step_3"]);
  });
});
