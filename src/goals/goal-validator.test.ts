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
import { isReadOnlyRequest, judgePlanShape, validateDAG, isMeasurementOnlyNode, foldMeasurementNodes } from "./goal-validator.js";
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

  it("parses past an UNCLOSED <reasoning> block when the JSON still follows (nemotron-3.5, 2026-09-07)", () => {
    const text = `<reasoning>\nLet me analyze this task carefully. The user wants me to decompose\n{"nodes": [{"id": "s1", "task": "Scene", "dependsOn": []}]}`;
    const result = parseLLMOutput(text);
    expect(result).not.toBeNull();
    expect(result!.nodes[0].id).toBe("s1");
    // Reasoning with no JSON at all is still not a decomposition.
    expect(parseLLMOutput("<reasoning>\nthinking forever without an answer")).toBeNull();
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

describe("judgePlanShape", () => {
  it("rejects the seven-node exploration plan measured 2026-09-08 (30 minutes, 55 reads, nothing produced)", () => {
    const nodes = [
      "Explore project structure: vault_search for GDD, modules, scenes, prefabs, audio, and existing patterns",
      "vault_search for GDD files including PixelFlow_GDD.md",
      "vault_search for module definitions and scripts",
      "vault_search for scene files",
      "vault_search for prefab files",
      "vault_search for audio assets",
      "Read PixelFlow_GDD.md structure and extract key game design requirements",
    ].map((task) => ({ task }));
    const verdict = judgePlanShape(nodes);
    expect(verdict.explorationOnly).toBe(true);
    expect(verdict.workNodes).toBe(0);
    expect(verdict.explorationNodes).toBe(7);
  });

  it("accepts a plan with at least one node that changes the project, and never judges a single-node tree", () => {
    expect(judgePlanShape([{ task: "Read the GDD" }, { task: "Generate the Rocket sprites with unity_generate_sprite and bind them" }]).explorationOnly).toBe(false);
    expect(judgePlanShape([{ task: "vault_search for everything" }]).explorationOnly).toBe(false);
    expect(judgePlanShape([]).explorationOnly).toBe(false);
    // Neutral labels say nothing about shape and are not judged.
    expect(judgePlanShape([{ task: "Step 1" }, { task: "Step 2" }]).explorationOnly).toBe(false);
    expect(judgePlanShape([{ task: "Read the GDD" }, { task: "Step 2" }]).explorationOnly).toBe(false);
  });

  it("does not reject real work phrased with extract/map/document/locate/find (review 2026-09-08 false positives)", () => {
    const plans = [
      ["Extract the shared movement logic into a MovementBase class", "Map legacy enemy IDs to the new EnemyKind enum", "Document the migration in CHANGELOG.md"],
      ["Extract PlayerController's input handling into InputReader.cs", "Extract the camera follow into CameraRig.cs"],
      ["Map the gamepad axes to the InputActions asset", "Document the control scheme in docs/controls.md"],
      ["Inspect the compile error in RocketSystem.cs and fix the missing using", "Locate the null prefab reference and bind it"],
    ];
    for (const plan of plans) {
      expect(judgePlanShape(plan.map((task) => ({ task }))).explorationOnly).toBe(false);
    }
  });
});

describe("a read-only request is not an exploration-only failure (Codex review 2026-09-09)", () => {
  it("names the requests whose plan is legitimately reading", () => {
    for (const t of [
      "Review the audio module and report what is short or duplicated",
      "Audit the shipped scenes against the GDD",
      "Analyze why the tray module stalls",
      "Please summarize the delivery report",
      "Report on placeholder art coverage",
    ]) expect(isReadOnlyRequest(t), t).toBe(true);
    for (const t of ["Build the HUD", "Deliver the art the GDD schedules", "Fix the compile error in RocketService"]) {
      expect(isReadOnlyRequest(t), t).toBe(false);
    }
  });

  it("a documentation deliverable is work, not exploration", () => {
    const verdict = judgePlanShape([
      { id: "a", task: "Document the save API in docs/save.md", dependsOn: [] },
      { id: "b", task: "Document the event bus contract", dependsOn: ["a"] },
    ] as never);
    expect(verdict.explorationOnly).toBe(false);
    expect(verdict.workNodes).toBe(2);
  });
});

describe("measurement-only nodes fold into the work that uses them (measured 2026-09-09: four plans, each opened with a bare unity_delivery_measure node)", () => {
  it("recognises a bare measuring call with only reporting around it, and nothing else", () => {
    expect(isMeasurementOnlyNode("Call unity_delivery_measure once. Record the current placeholderSprites count and the list of placeholder paths (first 24, bound ones first).")).toBe(true);
    expect(isMeasurementOnlyNode("Run unity_verify_change and report the verdict")).toBe(true);
    expect(isMeasurementOnlyNode("Run unity_verify_change and commit the batch")).toBe(false);
    expect(isMeasurementOnlyNode("Using the list from s1, take these 24 placeholder paths. Call unity_generate_sprite exactly TWICE")).toBe(false);
    expect(isMeasurementOnlyNode("Run the suite")).toBe(false);
    expect(isMeasurementOnlyNode("Call unity_generate_sprite with batch of 12")).toBe(false);
    // A report-only closer (measured 2026-09-09 21:16) — and a report that carries work is work.
    expect(isMeasurementOnlyNode("Output the final measured placeholderSprites number verbatim as the task completion count. This is the definitive measurement confirming placeholderSprites is below 300.")).toBe(true);
    expect(isMeasurementOnlyNode("Report the count, then regenerate the remaining placeholders")).toBe(false);
  });

  it("folds the opening measurement into every dependent, rewires edges, and folds a trailing one into its predecessor", () => {
    const nodes = [
      { id: "s1", task: "Call unity_delivery_measure once. Record the count and list the paths.", dependsOn: [] },
      { id: "s2", task: "Regenerate the first 24 placeholders in place, re-measure, verify and commit.", dependsOn: ["s1"] },
      { id: "s3", task: "Regenerate the next 24 placeholders in place, re-measure, verify and commit.", dependsOn: ["s2"] },
      { id: "s4", task: "Run unity_delivery_measure and report the final count.", dependsOn: ["s3"] },
    ];
    const { nodes: out, folded } = foldMeasurementNodes(nodes);
    expect(folded).toEqual(["s1", "s4"]);
    expect(out.map((n) => n.id)).toEqual(["s2", "s3"]);
    expect(out[0]!.dependsOn).toEqual([]);
    expect(out[0]!.task).toBe("Call unity_delivery_measure once. Record the count and list the paths. Then, in this same step: Regenerate the first 24 placeholders in place, re-measure, verify and commit.");
    expect(out[1]!.dependsOn).toEqual(["s2"]);
    expect(out[1]!.task).toContain("Finally, in this same step: Run unity_delivery_measure and report the final count.");
  });

  it("leaves a plan without measurement nodes untouched, and keeps an isolated measurement", () => {
    const plain = [{ id: "a", task: "Build the scene", dependsOn: [] }, { id: "b", task: "Bind the sprites", dependsOn: ["a"] }];
    expect(foldMeasurementNodes(plain)).toEqual({ nodes: plain, folded: [] });
    const lone = [{ id: "m", task: "Run unity_delivery_measure and report", dependsOn: [] }];
    expect(foldMeasurementNodes(lone).nodes).toEqual(lone);
  });
});

describe("folding a measurement never deletes the work (Codex 2026-09-11 M#4)", () => {
  it("keeps the verification when the node it folds into is itself folded", () => {
    // The ordinary shape of a plan: do the work, verify it, report the result.
    // Reading the ORIGINAL node after an earlier fold had rewritten it deleted
    // both the verification and the report, and the survivor — "Implement
    // player" alone — passed validation.
    const { nodes, folded } = foldMeasurementNodes([
      { id: "x", task: "Implement the player controller", dependsOn: [] },
      { id: "a", task: "Run unity_verify_change and record the result", dependsOn: ["x"] },
      { id: "b", task: "Report the results", dependsOn: ["a"] },
    ]);

    // Whatever it folds into, the verification is still IN the plan: the old
    // walk left "Implement the player controller" alone, with the measurement
    // and the report both gone.
    expect(nodes.map((n) => n.task).join(" ")).toContain("unity_verify_change");
    expect(nodes.map((n) => n.task).join(" ")).toContain("Report the results");
    expect(nodes.some((n) => n.id === "x")).toBe(true);
    expect(folded.length).toBeGreaterThan(0);
  });

  it("a folded verifier keeps every barrier it waited on", () => {
    const { nodes } = foldMeasurementNodes([
      { id: "a", task: "Build the playfield", dependsOn: [] },
      { id: "b", task: "Build the HUD", dependsOn: [] },
      { id: "v", task: "Report the measured results", dependsOn: ["a", "b"] },
    ]);

    const merged = nodes.find((n) => n.id === "b")!;
    expect(merged.task).toContain("Report the measured results");
    // Folding it into B alone used to drop its wait on A.
    expect(merged.dependsOn).toContain("a");
  });
});
