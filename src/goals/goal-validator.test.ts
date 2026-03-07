/**
 * Goal DAG Validator Tests
 *
 * Tests for:
 * - validateDAG: cycle detection (Kahn's), dangling refs, topological order
 * - parseLLMOutput: JSON parsing, markdown fence stripping, Zod validation
 * - Zod llmDecompositionSchema: structural validation
 * - GoalNodeId branded type
 */

import { describe, it, expect } from "vitest";
import { validateDAG } from "./goal-validator.js";
import type { DAGValidationResult } from "./goal-validator.js";
import {
  parseLLMOutput,
  llmDecompositionSchema,
  generateGoalNodeId,
  type GoalNodeId,
  type GoalStatus,
  type GoalNode,
} from "./types.js";

// =============================================================================
// validateDAG Tests
// =============================================================================

describe("validateDAG", () => {
  it("validates a valid linear DAG (A->B->C) with correct topological order", () => {
    const nodes = [
      { id: "A", task: "Step A", dependsOn: [] },
      { id: "B", task: "Step B", dependsOn: ["A"] },
      { id: "C", task: "Step C", dependsOn: ["B"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toEqual(["A", "B", "C"]);
  });

  it("validates a valid parallel DAG (A,B independent, C depends on A+B)", () => {
    const nodes = [
      { id: "A", task: "Step A", dependsOn: [] },
      { id: "B", task: "Step B", dependsOn: [] },
      { id: "C", task: "Step C", dependsOn: ["A", "B"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toBeDefined();
    // C must come after both A and B
    const order = result.topologicalOrder!;
    expect(order.indexOf("C" as GoalNodeId)).toBeGreaterThan(
      order.indexOf("A" as GoalNodeId),
    );
    expect(order.indexOf("C" as GoalNodeId)).toBeGreaterThan(
      order.indexOf("B" as GoalNodeId),
    );
  });

  it("detects a 2-node cycle (A->B->A)", () => {
    const nodes = [
      { id: "A", task: "Step A", dependsOn: ["B"] },
      { id: "B", task: "Step B", dependsOn: ["A"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.cycleNodes).toBeDefined();
    expect(result.cycleNodes!.sort()).toEqual(["A", "B"]);
  });

  it("detects a 3-node cycle (A->B->C->A)", () => {
    const nodes = [
      { id: "A", task: "Step A", dependsOn: ["C"] },
      { id: "B", task: "Step B", dependsOn: ["A"] },
      { id: "C", task: "Step C", dependsOn: ["B"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.cycleNodes).toBeDefined();
    expect(result.cycleNodes!.sort()).toEqual(["A", "B", "C"]);
  });

  it("rejects dangling dependsOn reference (non-existent ID)", () => {
    const nodes = [
      { id: "A", task: "Step A", dependsOn: [] },
      { id: "B", task: "Step B", dependsOn: ["Z"] },
    ];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(false);
    expect(result.danglingRefs).toBeDefined();
    expect(result.danglingRefs).toContain("Z");
  });

  it("validates a single node with no dependencies", () => {
    const nodes = [{ id: "A", task: "Step A", dependsOn: [] }];
    const result = validateDAG(nodes);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toEqual(["A"]);
  });

  it("depth > maxDepth is detectable from GoalNode.depth field", () => {
    // GoalNode.depth is a numeric field; enforcement is up to the caller
    const maxDepth = 3;
    const node: GoalNode = {
      id: "goal_1" as GoalNodeId,
      parentId: null,
      task: "Deep node",
      dependsOn: [],
      depth: 5,
      status: "pending" as GoalStatus,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(node.depth).toBeGreaterThan(maxDepth);
  });
});

// =============================================================================
// GoalNodeId Branded Type Tests
// =============================================================================

describe("GoalNodeId branded type", () => {
  it("generateGoalNodeId produces a string starting with 'goal_'", () => {
    const id = generateGoalNodeId();
    expect(id).toMatch(/^goal_\d+_[a-f0-9]+$/);
  });

  it("branded type prevents accidental assignment at type level", () => {
    // This is a compile-time check; at runtime we verify the shape
    const id: GoalNodeId = generateGoalNodeId();
    expect(typeof id).toBe("string");
    // A plain string cannot be assigned to GoalNodeId without casting
    // (enforced by TypeScript compiler, not at runtime)
  });
});

// =============================================================================
// parseLLMOutput Tests
// =============================================================================

describe("parseLLMOutput", () => {
  it("parses valid JSON", () => {
    const input = JSON.stringify({
      nodes: [
        { id: "1", task: "Do thing", dependsOn: [] },
        { id: "2", task: "Do other", dependsOn: ["1"] },
      ],
    });
    const result = parseLLMOutput(input);
    expect(result).not.toBeNull();
    expect(result!.nodes).toHaveLength(2);
    expect(result!.nodes[0].id).toBe("1");
    expect(result!.nodes[1].dependsOn).toEqual(["1"]);
  });

  it("parses markdown-fenced JSON (```json ... ```)", () => {
    const input = '```json\n{"nodes": [{"id": "a", "task": "test", "dependsOn": []}]}\n```';
    const result = parseLLMOutput(input);
    expect(result).not.toBeNull();
    expect(result!.nodes[0].id).toBe("a");
  });

  it("parses markdown-fenced JSON without language tag (``` ... ```)", () => {
    const input = '```\n{"nodes": [{"id": "b", "task": "test2", "dependsOn": []}]}\n```';
    const result = parseLLMOutput(input);
    expect(result).not.toBeNull();
    expect(result!.nodes[0].id).toBe("b");
  });

  it("returns null for invalid JSON", () => {
    const result = parseLLMOutput("this is not json {{{");
    expect(result).toBeNull();
  });

  it("returns null for missing required fields", () => {
    const result = parseLLMOutput(JSON.stringify({ nodes: [{ id: "1" }] }));
    expect(result).toBeNull();
  });

  it("returns null for empty nodes array", () => {
    const result = parseLLMOutput(JSON.stringify({ nodes: [] }));
    expect(result).toBeNull();
  });

  it("strips extra fields and still validates", () => {
    const input = JSON.stringify({
      nodes: [{ id: "1", task: "Do thing", dependsOn: [], extraField: true }],
      otherKey: "ignored",
    });
    const result = parseLLMOutput(input);
    expect(result).not.toBeNull();
    expect(result!.nodes[0].id).toBe("1");
  });

  it("handles needsFurtherDecomposition optional boolean", () => {
    const input = JSON.stringify({
      nodes: [
        { id: "1", task: "Complex task", dependsOn: [], needsFurtherDecomposition: true },
        { id: "2", task: "Simple task", dependsOn: ["1"] },
      ],
    });
    const result = parseLLMOutput(input);
    expect(result).not.toBeNull();
    expect(result!.nodes[0].needsFurtherDecomposition).toBe(true);
    expect(result!.nodes[1].needsFurtherDecomposition).toBeUndefined();
  });
});

// =============================================================================
// Zod llmDecompositionSchema Tests
// =============================================================================

describe("llmDecompositionSchema", () => {
  it("validates a structurally correct LLM output", () => {
    const input = {
      nodes: [
        { id: "1", task: "First", dependsOn: [] },
        { id: "2", task: "Second", dependsOn: ["1"] },
      ],
    };
    const result = llmDecompositionSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects empty nodes array", () => {
    const result = llmDecompositionSchema.safeParse({ nodes: [] });
    expect(result.success).toBe(false);
  });

  it("rejects node with empty id", () => {
    const result = llmDecompositionSchema.safeParse({
      nodes: [{ id: "", task: "test", dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects node with empty task", () => {
    const result = llmDecompositionSchema.safeParse({
      nodes: [{ id: "1", task: "", dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults dependsOn to empty array when missing", () => {
    const result = llmDecompositionSchema.safeParse({
      nodes: [{ id: "1", task: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodes[0].dependsOn).toEqual([]);
    }
  });

  it("rejects more than 20 nodes", () => {
    const nodes = Array.from({ length: 21 }, (_, i) => ({
      id: `node_${i}`,
      task: `Task ${i}`,
      dependsOn: [],
    }));
    const result = llmDecompositionSchema.safeParse({ nodes });
    expect(result.success).toBe(false);
  });
});
