/**
 * Chain DAG Validator Tests
 *
 * Tests for DAG validation (cycle detection, dangling refs) and
 * wave computation for parallel execution scheduling.
 */

import { describe, it, expect } from "vitest";
import { validateChainDAG, computeChainWaves, type ChainDAGValidationResult } from "./chain-dag.js";
import type { ChainStepNode } from "./chain-types.js";

// =============================================================================
// HELPERS
// =============================================================================

function step(stepId: string, toolName: string, dependsOn: string[] = []): ChainStepNode {
  return { stepId, toolName, dependsOn, reversible: false };
}

// =============================================================================
// validateChainDAG
// =============================================================================

describe("validateChainDAG", () => {
  it("should validate a linear chain A->B->C", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["B"]),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toEqual(["A", "B", "C"]);
  });

  it("should validate a diamond DAG (A->B, A->C, B->D, C->D)", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["A"]),
      step("D", "tool_d", ["B", "C"]),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toBeDefined();
    // A must come before B, C, D
    const order = result.topologicalOrder!;
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  });

  it("should validate fully parallel steps (no deps)", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b"),
      step("C", "tool_c"),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toHaveLength(3);
  });

  it("should detect cycle A->B->C->A", () => {
    const steps = [
      step("A", "tool_a", ["C"]),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["B"]),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(false);
    expect(result.cycleNodes).toBeDefined();
    expect(result.cycleNodes!.length).toBeGreaterThan(0);
    expect(result.cycleNodes).toContain("A");
    expect(result.cycleNodes).toContain("B");
    expect(result.cycleNodes).toContain("C");
  });

  it("should detect dangling ref (B depends on non-existent X)", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["X"]),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(false);
    expect(result.danglingRefs).toBeDefined();
    expect(result.danglingRefs).toContain("X");
  });

  it("should validate 2-step linear chain", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toEqual(["A", "B"]);
  });

  it("should handle complex DAG with mixed sequential and parallel", () => {
    // A -> B -> D
    // A -> C -> D
    // D -> E
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["A"]),
      step("D", "tool_d", ["B", "C"]),
      step("E", "tool_e", ["D"]),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(true);
    const order = result.topologicalOrder!;
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
    expect(order.indexOf("D")).toBeLessThan(order.indexOf("E"));
  });

  it("should detect self-cycle (A depends on itself)", () => {
    const steps = [
      step("A", "tool_a", ["A"]),
      step("B", "tool_b"),
    ];
    const result = validateChainDAG(steps);
    expect(result.valid).toBe(false);
    expect(result.cycleNodes).toContain("A");
  });
});

// =============================================================================
// computeChainWaves
// =============================================================================

describe("computeChainWaves", () => {
  it("should produce 3 waves for linear chain A->B->C", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["B"]),
    ];
    const waves = computeChainWaves(steps);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((s) => s.stepId)).toEqual(["A"]);
    expect(waves[1].map((s) => s.stepId)).toEqual(["B"]);
    expect(waves[2].map((s) => s.stepId)).toEqual(["C"]);
  });

  it("should produce 3 waves for diamond DAG: [A], [B,C], [D]", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["A"]),
      step("D", "tool_d", ["B", "C"]),
    ];
    const waves = computeChainWaves(steps);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((s) => s.stepId)).toEqual(["A"]);
    expect(waves[1].map((s) => s.stepId).sort()).toEqual(["B", "C"]);
    expect(waves[2].map((s) => s.stepId)).toEqual(["D"]);
  });

  it("should produce 1 wave for fully parallel steps", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b"),
      step("C", "tool_c"),
    ];
    const waves = computeChainWaves(steps);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it("should produce 2 waves for 2-step linear chain", () => {
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
    ];
    const waves = computeChainWaves(steps);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((s) => s.stepId)).toEqual(["A"]);
    expect(waves[1].map((s) => s.stepId)).toEqual(["B"]);
  });

  it("should throw on invalid DAG (cycle)", () => {
    const steps = [
      step("A", "tool_a", ["B"]),
      step("B", "tool_b", ["A"]),
    ];
    expect(() => computeChainWaves(steps)).toThrow();
  });

  it("should handle complex mixed DAG with 4 waves", () => {
    // Wave 0: A
    // Wave 1: B, C
    // Wave 2: D
    // Wave 3: E
    const steps = [
      step("A", "tool_a"),
      step("B", "tool_b", ["A"]),
      step("C", "tool_c", ["A"]),
      step("D", "tool_d", ["B", "C"]),
      step("E", "tool_e", ["D"]),
    ];
    const waves = computeChainWaves(steps);
    expect(waves).toHaveLength(4);
    expect(waves[0].map((s) => s.stepId)).toEqual(["A"]);
    expect(waves[1].map((s) => s.stepId).sort()).toEqual(["B", "C"]);
    expect(waves[2].map((s) => s.stepId)).toEqual(["D"]);
    expect(waves[3].map((s) => s.stepId)).toEqual(["E"]);
  });
});
