import { describe, it, expect } from "vitest";
import {
  normalizeSupervisorProgressMarkdown,
  detectSupervisorFeedbackLanguage,
  supervisorSummaryShapeId,
  supervisorNodeShapeId,
  buildSupervisorActivationNarrative,
  buildSupervisorPlanNarrative,
  buildSupervisorWaveNarrative,
  buildSupervisorVerificationNarrative,
  buildSupervisorCompletionNarrative,
  buildSupervisorAbortNarrative,
  buildSupervisorNodeNarrative,
  buildSupervisorCanvasPlan,
  buildSupervisorCanvasSummaryUpdate,
  buildSupervisorCanvasNodeUpdate,
} from "./supervisor-feedback.js";

// ---------------------------------------------------------------------------
// Minimal fixture types — avoid importing supervisor-types to prevent circular
// ---------------------------------------------------------------------------
type GoalNodeId = string | number;

interface CapabilityProfile {
  primary: string[];
  preference: "speed" | "cost" | "quality";
  confidence: number;
  source: string;
}

interface TaggedGoalNode {
  id: GoalNodeId;
  task: string;
  status: string;
  depth: number;
  dependsOn: Set<GoalNodeId>;
  parentId: GoalNodeId | undefined;
  result: unknown;
  error: unknown;
  retryCount: number;
  assignedProvider?: string;
  capabilityProfile: CapabilityProfile;
}

interface SupervisorResult {
  succeeded: number;
  failed: number;
  skipped: number;
  totalNodes: number;
}

function makeNode(overrides: Partial<TaggedGoalNode> = {}): TaggedGoalNode {
  return {
    id: "node-1" as GoalNodeId,
    task: "do something",
    status: "pending",
    depth: 0,
    dependsOn: new Set(),
    parentId: undefined,
    result: null,
    error: null,
    retryCount: 0,
    assignedProvider: "claude",
    capabilityProfile: {
      primary: ["code-gen"],
      preference: "quality",
      confidence: 0.8,
      source: "heuristic",
    },
    ...overrides,
  } as TaggedGoalNode;
}

// ---------------------------------------------------------------------------
// detectSupervisorFeedbackLanguage
// ---------------------------------------------------------------------------
describe("detectSupervisorFeedbackLanguage", () => {
  it("returns 'en' for a plain English task", () => {
    expect(detectSupervisorFeedbackLanguage("Fix the login bug")).toBe("en");
  });

  it("returns 'tr' when task contains Turkish letter 'ğ'", () => {
    expect(detectSupervisorFeedbackLanguage("değişkeni güncelle")).toBe("tr");
  });

  it("returns 'tr' when task contains Turkish trigger word 'hata'", () => {
    expect(detectSupervisorFeedbackLanguage("hata bul ve düzelt")).toBe("tr");
  });

  it("returns 'en' for empty string", () => {
    expect(detectSupervisorFeedbackLanguage("")).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// normalizeSupervisorProgressMarkdown
// ---------------------------------------------------------------------------
describe("normalizeSupervisorProgressMarkdown", () => {
  it("strips ** bold markers", () => {
    const result = normalizeSupervisorProgressMarkdown("**Stage:** planning");
    expect(result).toBe("Stage: planning");
  });

  it("strips leading '- ' list markers", () => {
    const result = normalizeSupervisorProgressMarkdown("- first item\n- second item");
    expect(result).toBe("first item\nsecond item");
  });

  it("returns trimmed string", () => {
    const result = normalizeSupervisorProgressMarkdown("  **hello**  ");
    expect(result).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// supervisorSummaryShapeId / supervisorNodeShapeId
// ---------------------------------------------------------------------------
describe("supervisorSummaryShapeId", () => {
  it("returns a deterministic string containing the rootId", () => {
    const id = supervisorSummaryShapeId("root-abc");
    expect(typeof id).toBe("string");
    expect(id).toContain("root-abc");
  });

  it("returns different values for different rootIds", () => {
    expect(supervisorSummaryShapeId("a")).not.toBe(supervisorSummaryShapeId("b"));
  });
});

describe("supervisorNodeShapeId", () => {
  it("returns a deterministic string containing the nodeId", () => {
    const id = supervisorNodeShapeId("node-42");
    expect(typeof id).toBe("string");
    expect(id).toContain("node-42");
  });

  it("returns different values for different nodeIds", () => {
    expect(supervisorNodeShapeId("x")).not.toBe(supervisorNodeShapeId("y"));
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorActivationNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorActivationNarrative", () => {
  it("English task → language 'en', non-empty narrative, markdown contains '**Stage:**'", () => {
    const result = buildSupervisorActivationNarrative("Refactor the auth module");
    expect(result.language).toBe("en");
    expect(result.narrative.length).toBeGreaterThan(0);
    expect(result.markdown).toContain("**Stage:**");
  });

  it("Turkish task → language 'tr', markdown contains '**Aşama:**'", () => {
    const result = buildSupervisorActivationNarrative("hata bul");
    expect(result.language).toBe("tr");
    expect(result.markdown).toContain("**Aşama:**");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorPlanNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorPlanNarrative", () => {
  it("English task, 3 nodes, 2 waves → 'en', narrative mentions '3 tasks', markdown has **Stage:**, canvasSummary non-empty", () => {
    const nodes = [
      makeNode({ id: "n1", task: "task one", assignedProvider: "claude" }),
      makeNode({ id: "n2", task: "task two", assignedProvider: "gpt4" }),
      makeNode({ id: "n3", task: "task three", assignedProvider: "claude" }),
    ] as unknown as TaggedGoalNode[];

    const result = buildSupervisorPlanNarrative({
      task: "Build the pipeline",
      nodeCount: 3,
      nodes,
      totalWaves: 2,
    });

    expect(result.language).toBe("en");
    expect(result.narrative).toContain("3 tasks");
    expect(result.markdown).toContain("**Stage:**");
    expect(result.canvasSummary.length).toBeGreaterThan(0);
  });

  it("Turkish task → language 'tr', markdown has **Aşama:**", () => {
    const nodes = [makeNode({ task: "görev bir" })] as unknown as TaggedGoalNode[];
    const result = buildSupervisorPlanNarrative({
      task: "görevleri dağıt",
      nodeCount: 1,
      nodes,
      totalWaves: 1,
    });

    expect(result.language).toBe("tr");
    expect(result.markdown).toContain("**Aşama:**");
  });

  it("empty nodes array → does not throw, summarizeProviders returns 'unassigned'", () => {
    expect(() =>
      buildSupervisorPlanNarrative({
        task: "Run a pipeline",
        nodeCount: 0,
        nodes: [] as unknown as TaggedGoalNode[],
        totalWaves: 0,
      }),
    ).not.toThrow();

    const result = buildSupervisorPlanNarrative({
      task: "Run a pipeline",
      nodeCount: 0,
      nodes: [] as unknown as TaggedGoalNode[],
      totalWaves: 0,
    });
    expect(result.narrative).toContain("unassigned");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorWaveNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorWaveNarrative", () => {
  it("English, waveIndex=0, totalWaves=3, 2 nodes → narrative mentions 'wave 1/3', markdown has correct wave info", () => {
    const nodes = [
      makeNode({ id: "n1", task: "alpha" }),
      makeNode({ id: "n2", task: "beta" }),
    ] as unknown as TaggedGoalNode[];

    const result = buildSupervisorWaveNarrative({
      task: "Execute the plan",
      waveIndex: 0,
      totalWaves: 3,
      nodes,
    });

    expect(result.language).toBe("en");
    expect(result.narrative).toContain("wave 1/3");
    expect(result.markdown).toContain("Wave 1/3");
  });

  it("totalWaves=0 → uses Math.max(0,1)=1, does not divide by zero, returns valid strings", () => {
    expect(() =>
      buildSupervisorWaveNarrative({
        task: "Run something",
        waveIndex: 0,
        totalWaves: 0,
        nodes: [] as unknown as TaggedGoalNode[],
      }),
    ).not.toThrow();

    const result = buildSupervisorWaveNarrative({
      task: "Run something",
      waveIndex: 0,
      totalWaves: 0,
      nodes: [] as unknown as TaggedGoalNode[],
    });

    expect(result.narrative).toContain("1/1");
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.canvasSummary.length).toBeGreaterThan(0);
  });

  it("nodes=[] → English canvasSummary contains 'ready tasks'", () => {
    const result = buildSupervisorWaveNarrative({
      task: "Run the pipeline",
      waveIndex: 0,
      totalWaves: 2,
      nodes: [] as unknown as TaggedGoalNode[],
    });

    expect(result.canvasSummary).toContain("ready tasks");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorVerificationNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorVerificationNarrative", () => {
  it("English → language 'en', all three fields non-empty", () => {
    const result = buildSupervisorVerificationNarrative("Verify the output");
    expect(result.language).toBe("en");
    expect(result.narrative.length).toBeGreaterThan(0);
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.canvasSummary.length).toBeGreaterThan(0);
  });

  it("Turkish → language 'tr'", () => {
    const result = buildSupervisorVerificationNarrative("çıktıyı doğrula");
    expect(result.language).toBe("tr");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorCompletionNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorCompletionNarrative", () => {
  const englishResult: SupervisorResult = {
    succeeded: 3,
    failed: 1,
    skipped: 0,
    totalNodes: 4,
  };

  it("English result → narrative mentions '3/4', canvasSummary mentions 'Succeeded: 3/4'", () => {
    const result = buildSupervisorCompletionNarrative({
      task: "Build everything",
      result: englishResult,
    });

    expect(result.language).toBe("en");
    expect(result.narrative).toContain("3/4");
    expect(result.canvasSummary).toContain("Succeeded: 3/4");
  });

  it("Turkish → canvasSummary in Turkish (contains 'Başarılı')", () => {
    const result = buildSupervisorCompletionNarrative({
      task: "hata düzelt",
      result: englishResult,
    });

    expect(result.language).toBe("tr");
    expect(result.canvasSummary).toContain("Başarılı");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorAbortNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorAbortNarrative", () => {
  it("English, short reason → narrative contains the reason, canvasSummary contains 'Supervisor interrupted'", () => {
    const result = buildSupervisorAbortNarrative({
      task: "Run the pipeline",
      reason: "budget exceeded",
    });

    expect(result.language).toBe("en");
    expect(result.narrative).toContain("budget exceeded");
    expect(result.canvasSummary).toContain("Supervisor interrupted");
  });

  it("Reason longer than 140 chars → gets truncated, no throw, narrative length reasonable", () => {
    const longReason = "x".repeat(200);

    expect(() =>
      buildSupervisorAbortNarrative({ task: "Do work", reason: longReason }),
    ).not.toThrow();

    const result = buildSupervisorAbortNarrative({
      task: "Do work",
      reason: longReason,
    });

    // The truncated reason embedded in narrative should be well under 500 chars
    expect(result.narrative.length).toBeLessThan(500);
    // Narrative should NOT include the full 200-char string literally
    expect(result.narrative).not.toContain("x".repeat(200));
  });

  it("Turkish task → language 'tr'", () => {
    const result = buildSupervisorAbortNarrative({
      task: "için görevi durdur",
      reason: "zaman aşımı",
    });

    expect(result.language).toBe("tr");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorNodeNarrative
// ---------------------------------------------------------------------------
describe("buildSupervisorNodeNarrative", () => {
  it("status 'running', English → narrative contains 'started running'", () => {
    const result = buildSupervisorNodeNarrative({
      task: "Compile assets",
      node: makeNode({ task: "bundle files", assignedProvider: "claude" }) as unknown as TaggedGoalNode,
      status: "running",
    });

    expect(result.language).toBe("en");
    expect(result.narrative).toContain("started running");
  });

  it("status 'done', Turkish task → language 'tr', narrative in Turkish", () => {
    const result = buildSupervisorNodeNarrative({
      task: "dosya düzelt",
      node: makeNode({ task: "dosya güncelle", assignedProvider: "gpt4" }) as unknown as TaggedGoalNode,
      status: "done",
    });

    expect(result.language).toBe("tr");
    // Turkish completion narrative contains "tamamlama" or "bitti"
    expect(result.narrative).toMatch(/tamamlama|bitti/);
  });

  it("status 'failed' with reason → narrative contains the reason", () => {
    const result = buildSupervisorNodeNarrative({
      task: "Run tests",
      node: makeNode({ task: "unit test", assignedProvider: "claude" }) as unknown as TaggedGoalNode,
      status: "failed",
      reason: "timeout error",
    });

    expect(result.narrative).toContain("timeout error");
  });

  it("status 'failed' with no reason → no crash, narrative does not contain 'Reason:'", () => {
    expect(() =>
      buildSupervisorNodeNarrative({
        task: "Run tests",
        node: makeNode({ task: "unit test" }) as unknown as TaggedGoalNode,
        status: "failed",
      }),
    ).not.toThrow();

    const result = buildSupervisorNodeNarrative({
      task: "Run tests",
      node: makeNode({ task: "unit test" }) as unknown as TaggedGoalNode,
      status: "failed",
    });

    expect(result.narrative).not.toContain("Reason:");
  });

  it("status 'pending' (default) → returns valid narrative", () => {
    const result = buildSupervisorNodeNarrative({
      task: "Lint code",
      node: makeNode({ task: "eslint check" }) as unknown as TaggedGoalNode,
      status: "pending",
    });

    expect(result.language).toBe("en");
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  it("status 'skipped' → narrative mentions 'skipped'", () => {
    const result = buildSupervisorNodeNarrative({
      task: "Deploy service",
      node: makeNode({ task: "smoke test" }) as unknown as TaggedGoalNode,
      status: "skipped",
    });

    expect(result.narrative).toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorCanvasPlan
// ---------------------------------------------------------------------------
describe("buildSupervisorCanvasPlan", () => {
  const rootId = "root-xyz";
  const nodes = [
    makeNode({ id: "n1", task: "first task" }),
    makeNode({ id: "n2", task: "second task" }),
  ] as unknown as TaggedGoalNode[];

  it("returns object with action 'draw', shapes array including summary shape and one shape per node", () => {
    const result = buildSupervisorCanvasPlan({
      rootId,
      task: "Execute plan",
      nodes,
      summary: "Plan summary",
    });

    expect(result.action).toBe("draw");
    // 1 summary shape + 2 node shapes
    expect(result.shapes).toHaveLength(3);
  });

  it("summary shape has id matching supervisorSummaryShapeId(rootId)", () => {
    const result = buildSupervisorCanvasPlan({
      rootId,
      task: "Execute plan",
      nodes,
      summary: "Plan summary",
    });

    const summaryShape = result.shapes[0];
    expect(summaryShape.id).toBe(supervisorSummaryShapeId(rootId));
  });

  it("node shapes have ids matching supervisorNodeShapeId(node.id)", () => {
    const result = buildSupervisorCanvasPlan({
      rootId,
      task: "Execute plan",
      nodes,
      summary: "Plan summary",
    });

    const nodeShapes = result.shapes.slice(1);
    expect(nodeShapes[0].id).toBe(supervisorNodeShapeId("n1"));
    expect(nodeShapes[1].id).toBe(supervisorNodeShapeId("n2"));
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorCanvasSummaryUpdate
// ---------------------------------------------------------------------------
describe("buildSupervisorCanvasSummaryUpdate", () => {
  it("tone 'success' → shape props.color is '#a6e3a1'", () => {
    const result = buildSupervisorCanvasSummaryUpdate({
      rootId: "r1",
      summary: "All done",
      tone: "success",
    });

    expect(result.shapes[0].props.color).toBe("#a6e3a1");
  });

  it("tone 'error' → shape props.color is '#f38ba8'", () => {
    const result = buildSupervisorCanvasSummaryUpdate({
      rootId: "r1",
      summary: "Something failed",
      tone: "error",
    });

    expect(result.shapes[0].props.color).toBe("#f38ba8");
  });

  it("no tone → default color '#89b4fa'", () => {
    const result = buildSupervisorCanvasSummaryUpdate({
      rootId: "r1",
      summary: "In progress",
    });

    expect(result.shapes[0].props.color).toBe("#89b4fa");
  });
});

// ---------------------------------------------------------------------------
// buildSupervisorCanvasNodeUpdate (smoke — exercises the export)
// ---------------------------------------------------------------------------
describe("buildSupervisorCanvasNodeUpdate", () => {
  it("returns update action with a task-card shape for the node", () => {
    const node = makeNode({ id: "n99", task: "compile shaders", assignedProvider: "gemini" }) as unknown as TaggedGoalNode;
    const result = buildSupervisorCanvasNodeUpdate({ node, status: "running" });

    expect(result.action).toBe("update");
    expect(result.shapes).toHaveLength(1);
    expect(result.shapes[0].id).toBe(supervisorNodeShapeId("n99"));
    expect(result.shapes[0].props.status).toBe("running");
  });

  it("pending status includes w/h dimensions in shape props", () => {
    const node = makeNode({ id: "n10", task: "lint check" }) as unknown as TaggedGoalNode;
    const result = buildSupervisorCanvasNodeUpdate({ node, status: "pending" });

    expect(result.shapes[0].props.w).toBeDefined();
    expect(result.shapes[0].props.h).toBeDefined();
  });

  it("non-pending status does NOT include w/h dimensions", () => {
    const node = makeNode({ id: "n11", task: "deploy" }) as unknown as TaggedGoalNode;
    const result = buildSupervisorCanvasNodeUpdate({ node, status: "done" });

    expect(result.shapes[0].props.w).toBeUndefined();
    expect(result.shapes[0].props.h).toBeUndefined();
  });
});
