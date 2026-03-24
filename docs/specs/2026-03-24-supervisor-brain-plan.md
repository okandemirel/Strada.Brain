# Supervisor Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an intelligent multi-provider orchestration layer that autonomously decomposes complex tasks, assigns sub-tasks to optimal providers, dispatches parallel PAOR loops, and aggregates results.

**Architecture:** New `src/supervisor/` module with 5 core components (CapabilityMatcher, ProviderAssigner, SupervisorDispatcher, ResultAggregator, SupervisorBrain) connected via a pipeline. Sits above the existing PAOR loop, activated by TaskClassifier complexity gate. Existing GoalDecomposer, GoalExecutor, and ConsensusManager are used as-is.

**Tech Stack:** TypeScript, Zod (config validation), TypedEventBus (telemetry), SQLite (via GoalStorage), React (monitor panel)

**Spec:** `docs/specs/2026-03-24-supervisor-brain-design.md`

---

### Task 1: Shared Types & Telemetry Foundation

**Files:**
- Create: `src/supervisor/supervisor-types.ts`
- Create: `src/supervisor/supervisor-telemetry.ts`
- Test: `src/supervisor/__tests__/supervisor-types.test.ts`

- [ ] **Step 1: Write type tests**

```typescript
// src/supervisor/__tests__/supervisor-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  CapabilityTag,
  CapabilityProfile,
  TaggedGoalNode,
  NodeResult,
  SupervisorResult,
  VerificationConfig,
  SupervisorConfig,
} from "../supervisor-types.js";

describe("supervisor-types", () => {
  it("CapabilityProfile has required fields", () => {
    const profile: CapabilityProfile = {
      primary: ["reasoning", "code-gen"],
      preference: "quality",
      confidence: 0.9,
      source: "heuristic",
    };
    expect(profile.primary).toContain("reasoning");
    expect(profile.confidence).toBeGreaterThanOrEqual(0);
    expect(profile.confidence).toBeLessThanOrEqual(1);
  });

  it("NodeResult captures execution outcome", () => {
    const result: NodeResult = {
      nodeId: "goal_1" as any,
      status: "ok",
      output: "DB schema created",
      artifacts: [],
      toolResults: [],
      provider: "claude",
      model: "claude-sonnet-4-6-20250514",
      cost: 0.003,
      duration: 12000,
    };
    expect(result.status).toBe("ok");
  });

  it("SupervisorConfig has defaults", () => {
    const config: SupervisorConfig = {
      enabled: true,
      complexityThreshold: "complex",
      maxParallelNodes: 4,
      nodeTimeoutMs: 120000,
      verificationMode: "critical-only",
      verificationBudgetPct: 15,
      triageProvider: "groq",
      maxFailureBudget: 3,
      diversityCap: 0.6,
    };
    expect(config.maxParallelNodes).toBe(4);
  });

  it("CapabilityTag union covers all values", () => {
    const tags: CapabilityTag[] = [
      "reasoning", "vision", "code-gen", "tool-use", "long-context",
      "speed", "cost", "quality", "creative",
    ];
    expect(tags).toHaveLength(9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/supervisor/__tests__/supervisor-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement supervisor-types.ts**

```typescript
// src/supervisor/supervisor-types.ts
import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";
import type { ToolResult } from "../agents/providers/provider-core.interface.js";

export type CapabilityTag =
  | "reasoning" | "vision" | "code-gen" | "tool-use" | "long-context"
  | "speed" | "cost" | "quality" | "creative";

export interface CapabilityProfile {
  readonly primary: CapabilityTag[];
  readonly preference: "speed" | "cost" | "quality";
  readonly confidence: number;
  readonly source: "heuristic" | "llm-triage" | "hybrid";
}

export interface TaggedGoalNode extends GoalNode {
  readonly capabilityProfile: CapabilityProfile;
  readonly assignedProvider?: string;
  readonly assignedModel?: string;
}

export interface ProviderScore {
  readonly providerName: string;
  readonly model: string;
  readonly score: number;
  readonly breakdown: {
    readonly capabilityScore: number;
    readonly preferenceScore: number;
    readonly historyScore: number;
  };
}

export interface NodeResult {
  readonly nodeId: GoalNodeId;
  readonly status: "ok" | "failed" | "skipped";
  readonly output: string;
  readonly artifacts: FileChange[];
  readonly toolResults: ToolResult[];
  readonly provider: string;
  readonly model: string;
  readonly cost: number;
  readonly duration: number;
}

export interface FileChange {
  readonly path: string;
  readonly action: "create" | "modify" | "delete";
}

export interface VerificationVerdict {
  readonly verdict: "approve" | "flag_issues" | "reject";
  readonly issues?: string[];
  readonly verifierProvider: string;
}

export interface VerificationConfig {
  readonly mode: "always" | "critical-only" | "sampling" | "disabled";
  readonly samplingRate: number;
  readonly preferDifferentProvider: boolean;
  readonly maxVerificationCost: number;
}

export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly complexityThreshold: "moderate" | "complex";
  readonly maxParallelNodes: number;
  readonly nodeTimeoutMs: number;
  readonly verificationMode: VerificationConfig["mode"];
  readonly verificationBudgetPct: number;
  readonly triageProvider: string;
  readonly maxFailureBudget: number;
  readonly diversityCap: number;
}

export interface SupervisorContext {
  readonly chatId: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
}

export interface SupervisorResult {
  readonly success: boolean;
  readonly output: string;
  readonly totalNodes: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly totalCost: number;
  readonly totalDuration: number;
  readonly nodeResults: NodeResult[];
  readonly partial: boolean;
}
```

- [ ] **Step 4: Implement supervisor-telemetry.ts**

```typescript
// src/supervisor/supervisor-telemetry.ts
import type { GoalNodeId } from "../goals/types.js";
import type { TaggedGoalNode, NodeResult } from "./supervisor-types.js";

export interface SupervisorEventMap {
  [key: string]: unknown;
  "supervisor:activated": {
    taskId: string;
    complexity: string;
    nodeCount: number;
  };
  "supervisor:plan_ready": {
    dag: { rootId: string; nodeCount: number };
    assignments: Record<string, { provider: string; model: string }>;
  };
  "supervisor:wave_start": {
    waveIndex: number;
    nodes: Array<{ nodeId: string; provider: string }>;
  };
  "supervisor:node_start": {
    nodeId: string;
    provider: string;
    model: string;
    wave: number;
  };
  "supervisor:node_complete": {
    nodeId: string;
    status: "ok" | "failed" | "skipped";
    duration: number;
    cost: number;
  };
  "supervisor:node_failed": {
    nodeId: string;
    error: string;
    failureLevel: 1 | 2 | 3 | 4;
    nextAction: string;
  };
  "supervisor:escalation": {
    nodeId: string;
    fromProvider: string;
    toProvider: string;
    reason: string;
  };
  "supervisor:wave_done": {
    waveIndex: number;
    results: Array<{ nodeId: string; status: string }>;
    totalCost: number;
  };
  "supervisor:verify_start": {
    nodeId: string;
    verifierProvider: string;
  };
  "supervisor:verify_done": {
    nodeId: string;
    verdict: "approve" | "flag_issues" | "reject";
    issues?: string[];
  };
  "supervisor:conflict": {
    fileConflicts: string[];
    resolution: string;
  };
  "supervisor:complete": {
    totalNodes: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cost: number;
    duration: number;
  };
  "supervisor:aborted": {
    reason: string;
    completedNodes: number;
    partialResult: boolean;
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/supervisor/__tests__/supervisor-types.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/supervisor-types.ts src/supervisor/supervisor-telemetry.ts src/supervisor/__tests__/supervisor-types.test.ts
git commit -m "feat(supervisor): add shared types and telemetry event definitions"
```

---

### Task 2: CapabilityMatcher

**Files:**
- Create: `src/supervisor/capability-matcher.ts`
- Test: `src/supervisor/__tests__/capability-matcher.test.ts`
- Reference: `src/agents/providers/provider-manager.ts` (getProvider, line 188)

- [ ] **Step 1: Write failing tests**

```typescript
// src/supervisor/__tests__/capability-matcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { CapabilityMatcher } from "../capability-matcher.js";
import type { GoalNode } from "../../goals/types.js";
import type { CapabilityProfile } from "../supervisor-types.js";

function makeNode(task: string, id = "goal_1"): GoalNode {
  return {
    id: id as any,
    parentId: null,
    task,
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("CapabilityMatcher", () => {
  describe("heuristic matching", () => {
    const matcher = new CapabilityMatcher();

    it("detects vision from image keywords", () => {
      const node = makeNode("Process uploaded image and generate thumbnail");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("vision");
      expect(profile.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects reasoning from analysis keywords", () => {
      const node = makeNode("Analyze and debug the authentication flow");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("reasoning");
    });

    it("detects code-gen from implementation keywords", () => {
      const node = makeNode("Implement user registration endpoint");
      const profile = matcher.matchHeuristic(node);
      expect(profile.primary).toContain("code-gen");
    });

    it("detects speed preference from quick keywords", () => {
      const node = makeNode("Quick lint check on the file");
      const profile = matcher.matchHeuristic(node);
      expect(profile.preference).toBe("speed");
    });

    it("detects quality preference from critical keywords", () => {
      const node = makeNode("Security review of the production auth code");
      const profile = matcher.matchHeuristic(node);
      expect(profile.preference).toBe("quality");
    });

    it("returns low confidence for ambiguous tasks", () => {
      const node = makeNode("Handle the data processing step");
      const profile = matcher.matchHeuristic(node);
      expect(profile.confidence).toBeLessThan(0.7);
    });

    it("returns high confidence with multiple matches", () => {
      const node = makeNode("Implement and build the new code feature with refactoring");
      const profile = matcher.matchHeuristic(node);
      expect(profile.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("matchNodes (full pipeline)", () => {
    it("processes multiple nodes, skips LLM for high-confidence", async () => {
      const matcher = new CapabilityMatcher();
      const nodes = [
        makeNode("Implement login endpoint", "goal_1"),
        makeNode("Analyze the debug trace carefully", "goal_2"),
      ];
      const results = await matcher.matchNodes(nodes);
      expect(results).toHaveLength(2);
      expect(results[0].capabilityProfile.primary).toContain("code-gen");
      expect(results[1].capabilityProfile.primary).toContain("reasoning");
    });

    it("assigns default profile when no signals match and no triage provider", async () => {
      const matcher = new CapabilityMatcher();
      const nodes = [makeNode("Do the thing")];
      const results = await matcher.matchNodes(nodes);
      expect(results[0].capabilityProfile.primary).toContain("code-gen");
      expect(results[0].capabilityProfile.preference).toBe("quality");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/supervisor/__tests__/capability-matcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement capability-matcher.ts**

```typescript
// src/supervisor/capability-matcher.ts
import type { GoalNode } from "../goals/types.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { CapabilityProfile, CapabilityTag, TaggedGoalNode } from "./supervisor-types.js";

const VISION_SIGNALS = ["image", "photo", "screenshot", "visual", "thumbnail", "upload", "picture", "diagram"];
const REASONING_SIGNALS = ["analyze", "debug", "investigate", "why", "trace", "evaluate", "compare", "assess"];
const CODEGEN_SIGNALS = ["implement", "create", "build", "write code", "add feature", "refactor", "migrate"];
const TOOL_SIGNALS = ["search", "find files", "run tests", "execute", "deploy", "install"];
const SPEED_SIGNALS = ["quick", "fast", "simple check", "lint", "format"];
const QUALITY_SIGNALS = ["critical", "production", "security", "review carefully"];
const COST_SIGNALS = ["simple", "straightforward", "basic", "trivial"];
const CREATIVE_SIGNALS = ["name", "copy", "describe", "write documentation", "suggest"];

interface SignalGroup {
  readonly tag: CapabilityTag;
  readonly signals: readonly string[];
}

const PRIMARY_GROUPS: SignalGroup[] = [
  { tag: "vision", signals: VISION_SIGNALS },
  { tag: "reasoning", signals: REASONING_SIGNALS },
  { tag: "code-gen", signals: CODEGEN_SIGNALS },
  { tag: "tool-use", signals: TOOL_SIGNALS },
];

const PREFERENCE_GROUPS: Array<{ preference: CapabilityProfile["preference"]; signals: readonly string[] }> = [
  { preference: "speed", signals: SPEED_SIGNALS },
  { preference: "quality", signals: QUALITY_SIGNALS },
  { preference: "cost", signals: COST_SIGNALS },
];

export class CapabilityMatcher {
  constructor(private readonly triageProvider?: IAIProvider) {}

  matchHeuristic(node: GoalNode): CapabilityProfile {
    const text = node.task.toLowerCase();
    const primary: CapabilityTag[] = [];
    let totalMatches = 0;

    for (const group of PRIMARY_GROUPS) {
      const matchCount = group.signals.filter(s => text.includes(s)).length;
      if (matchCount > 0) {
        primary.push(group.tag);
        totalMatches += matchCount;
      }
    }

    let preference: CapabilityProfile["preference"] = "quality";
    for (const pg of PREFERENCE_GROUPS) {
      if (pg.signals.some(s => text.includes(s))) {
        preference = pg.preference;
        break;
      }
    }

    const confidence = totalMatches >= 2 ? 0.9 : totalMatches === 1 ? 0.7 : 0.3;

    if (primary.length === 0) {
      primary.push("code-gen");
    }

    return { primary, preference, confidence, source: "heuristic" };
  }

  async matchWithTriage(nodes: GoalNode[]): Promise<CapabilityProfile[]> {
    if (!this.triageProvider) {
      return nodes.map(() => ({
        primary: ["code-gen" as CapabilityTag],
        preference: "quality" as const,
        confidence: 0.5,
        source: "heuristic" as const,
      }));
    }

    const batchPrompt = this.buildTriagePrompt(nodes);
    try {
      const response = await this.triageProvider.chat(
        "You are a task capability analyzer. Return valid JSON only.",
        [{ role: "user", content: batchPrompt }],
        [],
      );
      return this.parseTriageResponse(response.text, nodes.length);
    } catch {
      return nodes.map(() => ({
        primary: ["code-gen" as CapabilityTag],
        preference: "quality" as const,
        confidence: 0.5,
        source: "llm-triage" as const,
      }));
    }
  }

  async matchNodes(nodes: GoalNode[]): Promise<TaggedGoalNode[]> {
    const results: TaggedGoalNode[] = [];
    const ambiguousNodes: Array<{ index: number; node: GoalNode }> = [];

    for (let i = 0; i < nodes.length; i++) {
      const profile = this.matchHeuristic(nodes[i]);
      if (profile.confidence >= 0.7) {
        results[i] = { ...nodes[i], capabilityProfile: profile };
      } else {
        ambiguousNodes.push({ index: i, node: nodes[i] });
        results[i] = undefined as any; // placeholder
      }
    }

    if (ambiguousNodes.length > 0) {
      const triageResults = await this.matchWithTriage(
        ambiguousNodes.map(a => a.node),
      );
      for (let j = 0; j < ambiguousNodes.length; j++) {
        const { index } = ambiguousNodes[j];
        results[index] = {
          ...nodes[index],
          capabilityProfile: triageResults[j],
        };
      }
    }

    return results;
  }

  private buildTriagePrompt(nodes: GoalNode[]): string {
    const tasks = nodes.map((n, i) => `${i + 1}. "${n.task}"`).join("\n");
    return `Analyze these sub-tasks and return capability requirements for each.
Available capabilities: reasoning, vision, code-gen, tool-use, long-context
Available preferences: speed, cost, quality

Tasks:
${tasks}

Return JSON array: [{"capabilities": ["tag1"], "preference": "quality"}, ...]`;
  }

  private parseTriageResponse(text: string, count: number): CapabilityProfile[] {
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found");
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        capabilities?: string[];
        preference?: string;
      }>;
      return parsed.slice(0, count).map(item => ({
        primary: (item.capabilities ?? ["code-gen"]) as CapabilityTag[],
        preference: (item.preference ?? "quality") as CapabilityProfile["preference"],
        confidence: 0.7,
        source: "llm-triage" as const,
      }));
    } catch {
      return Array.from({ length: count }, () => ({
        primary: ["code-gen" as CapabilityTag],
        preference: "quality" as const,
        confidence: 0.5,
        source: "llm-triage" as const,
      }));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/supervisor/__tests__/capability-matcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/capability-matcher.ts src/supervisor/__tests__/capability-matcher.test.ts
git commit -m "feat(supervisor): add CapabilityMatcher with heuristic + LLM triage"
```

---

### Task 3: ProviderAssigner

**Files:**
- Create: `src/supervisor/provider-assigner.ts`
- Test: `src/supervisor/__tests__/provider-assigner.test.ts`
- Reference: `src/agents/providers/model-intelligence.ts` (ModelInfo interface)
- Reference: `src/agents/providers/provider-manager.ts:188` (getProvider)

- [ ] **Step 1: Write failing tests**

```typescript
// src/supervisor/__tests__/provider-assigner.test.ts
import { describe, it, expect } from "vitest";
import { ProviderAssigner } from "../provider-assigner.js";
import type { TaggedGoalNode, CapabilityProfile } from "../supervisor-types.js";

function makeTaggedNode(
  id: string,
  task: string,
  profile: CapabilityProfile,
): TaggedGoalNode {
  return {
    id: id as any,
    parentId: null,
    task,
    dependsOn: [],
    depth: 0,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    capabilityProfile: profile,
  };
}

const MOCK_PROVIDERS = [
  {
    name: "claude",
    model: "claude-sonnet-4-6-20250514",
    scores: { reasoning: 0.85, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.55, cost: 0.4, quality: 0.9, creative: 0.8 },
  },
  {
    name: "deepseek",
    model: "deepseek-chat",
    scores: { reasoning: 0.9, vision: 0, "code-gen": 0.85, "tool-use": 0.75, "long-context": 0.5, speed: 0.5, cost: 0.9, quality: 0.8, creative: 0.6 },
  },
  {
    name: "groq",
    model: "openai/gpt-oss-120b",
    scores: { reasoning: 0.3, vision: 0, "code-gen": 0.6, "tool-use": 0.7, "long-context": 0.5, speed: 0.98, cost: 0.85, quality: 0.55, creative: 0.4 },
  },
];

describe("ProviderAssigner", () => {
  const assigner = new ProviderAssigner(MOCK_PROVIDERS);

  it("scores and assigns best provider for reasoning task", () => {
    const node = makeTaggedNode("g1", "Analyze auth flow", {
      primary: ["reasoning", "code-gen"],
      preference: "quality",
      confidence: 0.9,
      source: "heuristic",
    });
    const result = assigner.assignNode(node);
    expect(result.assignedProvider).toBeDefined();
    expect(["claude", "deepseek"]).toContain(result.assignedProvider);
  });

  it("eliminates providers missing required capability (vision)", () => {
    const node = makeTaggedNode("g2", "Process image", {
      primary: ["vision", "code-gen"],
      preference: "quality",
      confidence: 0.9,
      source: "heuristic",
    });
    const result = assigner.assignNode(node);
    expect(result.assignedProvider).toBe("claude");
  });

  it("prefers speed-optimized provider for speed preference", () => {
    const node = makeTaggedNode("g3", "Quick lint", {
      primary: ["code-gen"],
      preference: "speed",
      confidence: 0.9,
      source: "heuristic",
    });
    const result = assigner.assignNode(node);
    expect(result.assignedProvider).toBe("groq");
  });

  it("assigns all nodes with diversity cap", () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeTaggedNode(`g${i}`, `Task ${i}`, {
        primary: ["code-gen"],
        preference: "quality",
        confidence: 0.9,
        source: "heuristic",
      }),
    );
    const results = assigner.assignNodes(nodes, 0.6);
    const providers = results.map(r => r.assignedProvider);
    const claudeCount = providers.filter(p => p === "claude").length;
    expect(claudeCount).toBeLessThanOrEqual(3); // 60% of 5
  });

  it("handles single-provider mode gracefully", () => {
    const singleAssigner = new ProviderAssigner([MOCK_PROVIDERS[0]]);
    const node = makeTaggedNode("g1", "Anything", {
      primary: ["reasoning"],
      preference: "cost",
      confidence: 0.9,
      source: "heuristic",
    });
    const result = singleAssigner.assignNode(node);
    expect(result.assignedProvider).toBe("claude");
  });

  it("returns ranked alternatives for escalation", () => {
    const node = makeTaggedNode("g1", "Analyze code", {
      primary: ["reasoning", "code-gen"],
      preference: "quality",
      confidence: 0.9,
      source: "heuristic",
    });
    const ranked = assigner.getRankedProviders(node);
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/supervisor/__tests__/provider-assigner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement provider-assigner.ts**

Implement the `ProviderAssigner` class with:
- `scoreProvider(provider, capabilityProfile)` — hard filter + weighted scoring (60% capability, 30% preference, 10% history)
- Hard rules enforcement:
  - Rule 1: vision=0 provider eliminated for vision-requiring nodes (return -1)
  - Rule 2: exclude providers where healthCheck failed (filter from candidate list)
  - Rule 3: deprioritize providers near rate limit (reduce score by 50%)
  - Rule 4: if user hard-pin mode active, assign all nodes to pinned provider
- `assignNode(node)` — score all providers, pick best
- `assignNodes(nodes, diversityCap)` — assign with diversity constraint + dependency affinity (nodes sharing DAG edges prefer same provider when scores are within 10%)
- `getRankedProviders(node)` — return sorted alternatives for escalation
- Provider capability scores from constructor-injected provider descriptors
- Single-provider fallback (always assigns the only provider)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/supervisor/__tests__/provider-assigner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/provider-assigner.ts src/supervisor/__tests__/provider-assigner.test.ts
git commit -m "feat(supervisor): add ProviderAssigner with capability scoring"
```

---

### Task 4: SupervisorDispatcher

**Files:**
- Create: `src/supervisor/supervisor-dispatcher.ts`
- Test: `src/supervisor/__tests__/supervisor-dispatcher.test.ts`
- Reference: `src/goals/goal-executor.ts` (wave execution pattern, semaphore)
- Reference: `src/goals/goal-decomposer.ts:202` (decomposeReactive)
- Reference: `src/agents/orchestrator.ts:1694` (runBackgroundTask)

- [ ] **Step 1: Write failing tests**

```typescript
// src/supervisor/__tests__/supervisor-dispatcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { SupervisorDispatcher } from "../supervisor-dispatcher.js";
import type { TaggedGoalNode, NodeResult, SupervisorConfig } from "../supervisor-types.js";

function makeAssignedNode(
  id: string,
  task: string,
  provider: string,
  deps: string[] = [],
): TaggedGoalNode {
  return {
    id: id as any,
    parentId: null,
    task,
    dependsOn: deps as any[],
    depth: 0,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    capabilityProfile: {
      primary: ["code-gen"],
      preference: "quality",
      confidence: 0.9,
      source: "heuristic",
    },
    assignedProvider: provider,
    assignedModel: "test-model",
  };
}

describe("SupervisorDispatcher", () => {
  it("computes correct wave order from DAG", () => {
    const nodes = [
      makeAssignedNode("A", "Task A", "claude"),
      makeAssignedNode("B", "Task B", "deepseek"),
      makeAssignedNode("C", "Task C", "claude", ["A", "B"]),
    ];
    const dispatcher = new SupervisorDispatcher({
      executeNode: vi.fn().mockResolvedValue({ status: "ok", output: "done", cost: 0, duration: 0 }),
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 } as any,
    });
    const waves = dispatcher.computeWaves(nodes);
    expect(waves).toHaveLength(2);
    expect(waves[0].map(n => n.id)).toEqual(expect.arrayContaining(["A", "B"]));
    expect(waves[1].map(n => n.id)).toEqual(["C"]);
  });

  it("executes waves in parallel with semaphore", async () => {
    const executionOrder: string[] = [];
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      executionOrder.push(node.id);
      return { nodeId: node.id, status: "ok", output: "done", artifacts: [], toolResults: [], provider: node.assignedProvider!, model: node.assignedModel!, cost: 0.001, duration: 100 };
    });

    const nodes = [
      makeAssignedNode("A", "Task A", "claude"),
      makeAssignedNode("B", "Task B", "deepseek"),
      makeAssignedNode("C", "Task C", "groq", ["A", "B"]),
    ];

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 } as any,
    });
    const results = await dispatcher.dispatch(nodes);
    expect(results).toHaveLength(3);
    expect(results.filter(r => r.status === "ok")).toHaveLength(3);
    // C must execute after A and B
    const cIndex = executionOrder.indexOf("C" as any);
    const aIndex = executionOrder.indexOf("A" as any);
    const bIndex = executionOrder.indexOf("B" as any);
    expect(cIndex).toBeGreaterThan(aIndex);
    expect(cIndex).toBeGreaterThan(bIndex);
  });

  it("respects failure budget", async () => {
    let callCount = 0;
    const executeNode = vi.fn().mockImplementation(async (node: TaggedGoalNode) => {
      callCount++;
      return { nodeId: node.id, status: "failed", output: "", artifacts: [], toolResults: [], provider: "claude", model: "test", cost: 0, duration: 0 };
    });

    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeAssignedNode(`N${i}`, `Task ${i}`, "claude"),
    );

    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 5000, maxFailureBudget: 3 } as any,
    });
    const results = await dispatcher.dispatch(nodes);
    const failed = results.filter(r => r.status === "failed");
    expect(failed.length).toBeLessThanOrEqual(3);
  });

  it("handles timeout via AbortController", async () => {
    const executeNode = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10000));
      return { nodeId: "X", status: "ok", output: "", artifacts: [], toolResults: [], provider: "claude", model: "test", cost: 0, duration: 0 };
    });

    const nodes = [makeAssignedNode("X", "Slow task", "claude")];
    const dispatcher = new SupervisorDispatcher({
      executeNode,
      config: { maxParallelNodes: 4, nodeTimeoutMs: 100, maxFailureBudget: 3 } as any,
    });
    const results = await dispatcher.dispatch(nodes);
    expect(results[0].status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/supervisor/__tests__/supervisor-dispatcher.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement supervisor-dispatcher.ts**

Implement the `SupervisorDispatcher` class with:
- `computeWaves(nodes)` — topological sort into dependency waves
- `dispatch(nodes, signal?)` — wave-based parallel execution with semaphore
- Per-node AbortController + timeout
- 4-level failure recovery per node:
  - L1: Retry same provider (maxRetries=1, backoff=2s) for transient errors
  - L2: Provider escalation — call `ProviderAssigner.getRankedProviders(node)` and retry with next-best
  - L3: Re-decompose — call `GoalDecomposer.decomposeReactive()`, run new children through CapabilityMatcher + ProviderAssigner, insert into remaining waves
  - L4: Criticality check — LLM evaluates if failure is critical. Non-critical: skip node, dependents continue. Critical: skip node + all dependents
- Budget guard: after each node completion, check cumulative cost against `AgentBudgetTracker.isAgentExceeded()`. If exceeded, abort remaining nodes, return completed work as partial result
- Failure budget tracking (stop after maxFailureBudget failures)
- Event emission for each node start/complete/fail/escalation
- Node result collection

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/supervisor/__tests__/supervisor-dispatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/supervisor-dispatcher.ts src/supervisor/__tests__/supervisor-dispatcher.test.ts
git commit -m "feat(supervisor): add SupervisorDispatcher with wave execution"
```

---

### Task 5: ResultAggregator

**Files:**
- Create: `src/supervisor/result-aggregator.ts`
- Test: `src/supervisor/__tests__/result-aggregator.test.ts`
- Reference: `src/agent-core/routing/consensus-manager.ts` (verification pattern)

- [ ] **Step 1: Write failing tests**

```typescript
// src/supervisor/__tests__/result-aggregator.test.ts
import { describe, it, expect, vi } from "vitest";
import { ResultAggregator } from "../result-aggregator.js";
import type { NodeResult, VerificationConfig } from "../supervisor-types.js";

function makeResult(nodeId: string, status: "ok" | "failed" | "skipped", output = "done"): NodeResult {
  return {
    nodeId: nodeId as any,
    status,
    output,
    artifacts: [],
    toolResults: [],
    provider: "claude",
    model: "claude-sonnet",
    cost: 0.001,
    duration: 1000,
  };
}

describe("ResultAggregator", () => {
  describe("collect", () => {
    it("separates results by status", () => {
      const aggregator = new ResultAggregator({ mode: "disabled" } as VerificationConfig);
      const results = [
        makeResult("A", "ok", "Schema created"),
        makeResult("B", "failed"),
        makeResult("C", "ok", "Endpoint ready"),
        makeResult("D", "skipped"),
      ];
      const collected = aggregator.collect(results);
      expect(collected.succeeded).toHaveLength(2);
      expect(collected.failed).toHaveLength(1);
      expect(collected.skipped).toHaveLength(1);
    });
  });

  describe("synthesize", () => {
    it("produces full success output", () => {
      const aggregator = new ResultAggregator({ mode: "disabled" } as VerificationConfig);
      const results = [
        makeResult("A", "ok", "DB schema created with users table"),
        makeResult("B", "ok", "JWT middleware implemented"),
      ];
      const output = aggregator.synthesize(results);
      expect(output.success).toBe(true);
      expect(output.partial).toBe(false);
      expect(output.output).toContain("DB schema");
      expect(output.output).toContain("JWT middleware");
    });

    it("produces partial success output", () => {
      const aggregator = new ResultAggregator({ mode: "disabled" } as VerificationConfig);
      const results = [
        makeResult("A", "ok", "Schema created"),
        makeResult("B", "failed", "Rate limit exceeded"),
        makeResult("C", "skipped"),
      ];
      const output = aggregator.synthesize(results);
      expect(output.success).toBe(false);
      expect(output.partial).toBe(true);
      expect(output.succeeded).toBe(1);
      expect(output.failed).toBe(1);
    });

    it("detects file conflicts between nodes", () => {
      const aggregator = new ResultAggregator({ mode: "disabled" } as VerificationConfig);
      const results: NodeResult[] = [
        { ...makeResult("A", "ok"), artifacts: [{ path: "src/auth.ts", action: "modify" }] },
        { ...makeResult("B", "ok"), artifacts: [{ path: "src/auth.ts", action: "modify" }] },
      ];
      const conflicts = aggregator.detectConflicts(results);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toBe("src/auth.ts");
    });
  });

  describe("verification", () => {
    it("skips verification in disabled mode", async () => {
      const aggregator = new ResultAggregator({ mode: "disabled" } as VerificationConfig);
      const results = [makeResult("A", "ok")];
      const verified = await aggregator.verify(results);
      expect(verified).toEqual(results);
    });

    it("verifies critical-only results based on preference", async () => {
      const verifyFn = vi.fn().mockResolvedValue({ verdict: "approve" });
      const aggregator = new ResultAggregator(
        { mode: "critical-only", preferDifferentProvider: true, samplingRate: 0.3, maxVerificationCost: 15 },
        verifyFn,
      );
      const criticalResult: NodeResult = {
        ...makeResult("A", "ok"),
        // critical-only verifies quality-preference nodes
      };
      await aggregator.verify([criticalResult]);
      // Verification behavior depends on node preference
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/supervisor/__tests__/result-aggregator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement result-aggregator.ts**

Implement the `ResultAggregator` class with:
- `collect(results)` — categorize by status (ok/failed/skipped)
- `verify(results, verifyFn?)` — cross-validation based on VerificationConfig mode
- `detectConflicts(results)` — find nodes that modified same files
- `synthesize(results)` — generate SupervisorResult with coherent output
- Full success: merged summary
- Partial success: completed work + failures listed

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/supervisor/__tests__/result-aggregator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/result-aggregator.ts src/supervisor/__tests__/result-aggregator.test.ts
git commit -m "feat(supervisor): add ResultAggregator with verification and synthesis"
```

---

### Task 6: SupervisorBrain (Pipeline Orchestrator)

**Files:**
- Create: `src/supervisor/supervisor-brain.ts`
- Test: `src/supervisor/__tests__/supervisor-brain.test.ts`
- Reference: `src/goals/goal-decomposer.ts` (decomposeProactive)
- Reference: `src/agent-core/routing/task-classifier.ts` (TaskClassification)

- [ ] **Step 1: Write failing tests**

```typescript
// src/supervisor/__tests__/supervisor-brain.test.ts
import { describe, it, expect, vi } from "vitest";
import { SupervisorBrain } from "../supervisor-brain.js";
import type { GoalTree, GoalNode } from "../../goals/types.js";
import type { SupervisorConfig } from "../supervisor-types.js";

function makeGoalTree(nodes: Array<{ id: string; task: string; deps?: string[] }>): GoalTree {
  const nodeMap = new Map<any, GoalNode>();
  for (const n of nodes) {
    nodeMap.set(n.id as any, {
      id: n.id as any,
      parentId: null,
      task: n.task,
      dependsOn: (n.deps ?? []) as any[],
      depth: 0,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return {
    rootId: nodes[0].id as any,
    sessionId: "session_1",
    taskDescription: "Test task",
    nodes: nodeMap,
    createdAt: Date.now(),
  };
}

describe("SupervisorBrain", () => {
  const defaultConfig: SupervisorConfig = {
    enabled: true,
    complexityThreshold: "complex",
    maxParallelNodes: 4,
    nodeTimeoutMs: 5000,
    verificationMode: "disabled",
    verificationBudgetPct: 15,
    triageProvider: "groq",
    maxFailureBudget: 3,
    diversityCap: 0.6,
  };

  it("runs full pipeline: decompose → match → assign → dispatch → aggregate", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockResolvedValue(
        makeGoalTree([
          { id: "root", task: "Build auth" },
          { id: "s1", task: "Create DB schema" },
          { id: "s2", task: "Implement endpoint", deps: ["s1"] },
        ]),
      ),
    };

    const executeNode = vi.fn().mockResolvedValue({
      status: "ok",
      output: "Done",
      artifacts: [],
      toolResults: [],
      cost: 0.001,
      duration: 100,
    });

    const brain = new SupervisorBrain({
      config: defaultConfig,
      decomposer: decomposer as any,
      providers: [
        { name: "claude", model: "sonnet", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } },
      ],
      executeNode,
    });

    const result = await brain.execute("Build auth system", { chatId: "test" });
    expect(result.success).toBe(true);
    expect(decomposer.decomposeProactive).toHaveBeenCalledTimes(1);
    expect(executeNode).toHaveBeenCalled();
  });

  it("returns early for non-decomposable tasks", async () => {
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(false),
      decomposeProactive: vi.fn(),
    };

    const brain = new SupervisorBrain({
      config: defaultConfig,
      decomposer: decomposer as any,
      providers: [],
      executeNode: vi.fn(),
    });

    const result = await brain.execute("hi", { chatId: "test" });
    expect(result).toBeNull();
    expect(decomposer.decomposeProactive).not.toHaveBeenCalled();
  });

  it("handles abort signal", async () => {
    const controller = new AbortController();
    const decomposer = {
      shouldDecompose: vi.fn().mockReturnValue(true),
      decomposeProactive: vi.fn().mockImplementation(async () => {
        controller.abort();
        return makeGoalTree([{ id: "root", task: "Task" }]);
      }),
    };

    const brain = new SupervisorBrain({
      config: defaultConfig,
      decomposer: decomposer as any,
      providers: [{ name: "claude", model: "sonnet", scores: { reasoning: 0.9, vision: 0.9, "code-gen": 0.9, "tool-use": 0.9, "long-context": 0.9, speed: 0.5, cost: 0.4, quality: 0.9, creative: 0.8 } }],
      executeNode: vi.fn(),
    });

    const result = await brain.execute("Build something", { chatId: "test", signal: controller.signal });
    expect(result?.partial).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/supervisor/__tests__/supervisor-brain.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement supervisor-brain.ts**

Implement `SupervisorBrain` class orchestrating the full pipeline:
- Constructor takes config, decomposer, providers, executeNode, eventBus
- `execute(task, context)` — runs 5-stage pipeline
- `abort()` — cascading abort via AbortController
- Null return when task doesn't warrant decomposition
- Event emission at each pipeline stage
- Error handling with partial result return

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/supervisor/__tests__/supervisor-brain.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/supervisor-brain.ts src/supervisor/__tests__/supervisor-brain.test.ts
git commit -m "feat(supervisor): add SupervisorBrain pipeline orchestrator"
```

---

### Task 7: Config + Bootstrap Integration

**Files:**
- Modify: `src/config/config.ts` (add SupervisorConfig Zod schema)
- Create: `src/core/bootstrap-stages/stage-supervisor.ts`
- Reference: `src/config/config.ts:1228` (Zod schema pattern)
- Reference: `src/core/bootstrap-stages/stage-goals.ts:35` (stage pattern)

- [ ] **Step 1: Add supervisor config to Zod schema in config.ts**

Add to the Zod env schema (around line 1237, after goal config):
```typescript
stradaSupervisorEnabled: z.string().default("true"),
stradaSupervisorComplexityThreshold: z.enum(["moderate", "complex"]).default("complex"),
stradaSupervisorMaxParallelNodes: z.string().transform(s => parseInt(s, 10)).pipe(z.number().int().min(1).max(16)).default("4"),
stradaSupervisorNodeTimeoutMs: z.string().transform(s => parseInt(s, 10)).pipe(z.number().int().min(5000).max(600000)).default("120000"),
stradaSupervisorVerificationMode: z.enum(["always", "critical-only", "sampling", "disabled"]).default("critical-only"),
stradaSupervisorVerificationBudgetPct: z.string().transform(s => parseInt(s, 10)).pipe(z.number().int().min(0).max(50)).default("15"),
stradaSupervisorTriageProvider: z.string().default("groq"),
stradaSupervisorMaxFailureBudget: z.string().transform(s => parseInt(s, 10)).pipe(z.number().int().min(1).max(20)).default("3"),
stradaSupervisorDiversityCap: z.string().transform(s => parseFloat(s)).pipe(z.number().min(0).max(1)).default("0.6"),
```

Add `SupervisorConfig` interface and map to Config interface (follow GoalConfig pattern at line 364).

- [ ] **Step 2: Implement stage-supervisor.ts**

```typescript
// src/core/bootstrap-stages/stage-supervisor.ts
import type { Config } from "../../config/config.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import { SupervisorBrain } from "../../supervisor/supervisor-brain.js";
import { CapabilityMatcher } from "../../supervisor/capability-matcher.js";
import { ProviderAssigner } from "../../supervisor/provider-assigner.js";
import type { GoalDecomposer } from "../../goals/goal-decomposer.js";
import type { SupervisorConfig } from "../../supervisor/supervisor-types.js";

export interface SupervisorStageParams {
  config: Config;
  goalDecomposer: GoalDecomposer;
  providerManager: ProviderManager;
}

export interface SupervisorStageResult {
  supervisorBrain: SupervisorBrain | undefined;
}

export function initializeSupervisorStage(
  params: SupervisorStageParams,
): SupervisorStageResult {
  const supervisorConfig = params.config.supervisor;
  if (!supervisorConfig.enabled) {
    return { supervisorBrain: undefined };
  }

  // Build provider descriptors from ProviderManager
  const availableProviders = params.providerManager.listAvailable();
  // Map to scoring descriptors with capability scores from ModelIntelligence

  const triageProvider = params.providerManager.getProviderByName(
    supervisorConfig.triageProvider,
  );

  const capabilityMatcher = new CapabilityMatcher(triageProvider);

  // Build provider score descriptors from ModelIntelligence + hardcoded baselines
  // Maps ProviderDescriptor[] to { name, model, scores } format
  // Scores sourced from ModelIntelligence.getModelInfo() with hardcoded fallbacks
  // for reasoning, vision, code-gen, tool-use, long-context, speed, cost, quality, creative
  const providerDescriptors = buildProviderDescriptors(
    availableProviders,
    params.providerManager,  // for ModelIntelligence access
  );
  const providerAssigner = new ProviderAssigner(providerDescriptors, supervisorConfig.diversityCap);

  const supervisorBrain = new SupervisorBrain({
    config: supervisorConfig,
    decomposer: params.goalDecomposer,
    capabilityMatcher,
    providerAssigner,
    providers: providerDescriptors,
    executeNode: async (node) => {
      // Delegate to orchestrator.runBackgroundTask with assigned provider
      // This will be wired in orchestrator integration (Task 8)
      throw new Error("executeNode not wired yet");
    },
  });

  return { supervisorBrain };
}
```

- [ ] **Step 3: Export from bootstrap-stages/index.ts**

Add `export { initializeSupervisorStage } from "./stage-supervisor.js";` to the index.

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npx vitest run src/supervisor/`
Expected: All supervisor tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/core/bootstrap-stages/stage-supervisor.ts src/core/bootstrap-stages/index.ts
git commit -m "feat(supervisor): add config schema and bootstrap stage"
```

---

### Task 8: Orchestrator Integration

**Files:**
- Modify: `src/agents/orchestrator.ts` (~line 2527, processMessage)
- Modify: `src/core/bootstrap.ts` (wire SupervisorBrain)
- Reference: `src/agent-core/routing/task-classifier.ts` (TaskClassifier.classify)

- [ ] **Step 1: Add complexity gate to processMessage**

In `orchestrator.ts`, after the goal tree resume detection block (around line 2565), add the supervisor gate:

```typescript
// Supervisor Brain gate: route complex tasks to multi-provider pipeline
if (this.supervisorBrain && !this.supervisorBrainActive) {
  const classification = this.taskClassifier?.classify(text);
  if (classification && this.shouldActivateSupervisor(classification)) {
    this.supervisorBrainActive = true;
    try {
      const result = await this.supervisorBrain.execute(text, {
        chatId,
        userId,
        conversationId,
        signal: this.getAbortSignal(),
      });
      if (result) {
        await this.sendSupervisorResult(chatId, result);
        return;
      }
    } finally {
      this.supervisorBrainActive = false;
    }
    // If supervisor returned null (task not complex enough), fall through to PAOR
  }
}
```

Add helper methods:
```typescript
private shouldActivateSupervisor(classification: TaskClassification): boolean {
  const threshold = this.config.supervisor.complexityThreshold;
  if (threshold === "moderate") return classification.complexity === "moderate" || classification.complexity === "complex";
  return classification.complexity === "complex";
}

private async sendSupervisorResult(chatId: string, result: SupervisorResult): Promise<void> {
  const session = this.sessionManager.getOrCreateSession(chatId);
  session.appendVisibleAssistantMessage(result.output);
  await this.channel.sendMarkdown(chatId, result.output);
}
```

- [ ] **Step 2: Wire SupervisorBrain in bootstrap.ts**

After `initializeGoalContextStage`, add `initializeSupervisorStage` call. Pass the resulting `supervisorBrain` to the Orchestrator constructor.

Note: The `executeNode` callback needs a reference to the orchestrator, but the orchestrator hasn't been constructed yet during bootstrap. Use a lazy setter pattern to resolve this circular dependency:
```typescript
// In bootstrap.ts, after orchestrator construction:
supervisorBrain?.setExecuteNode(async (node, context) => {
  return orchestrator.runBackgroundTask(node.task, {
    chatId: context.chatId,
    signal: context.signal,
  });
});
```

- [ ] **Step 3: Add setExecuteNode to SupervisorBrain**

Add a `setExecuteNode(fn)` method to `SupervisorBrain` that allows post-construction wiring of the execute callback. This resolves the bootstrap circular dependency (stage-supervisor runs before orchestrator exists). Guard `execute()` to throw if `executeNode` is not yet set.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (existing + new supervisor tests)

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts src/core/bootstrap.ts src/core/bootstrap-stages/stage-supervisor.ts
git commit -m "feat(supervisor): integrate SupervisorBrain into orchestrator pipeline"
```

---

### Task 9: Monitor Panel (SupervisorPanel)

**Files:**
- Create: `web-portal/src/components/SupervisorPanel.tsx`
- Modify: `web-portal/src/components/MonitorView.tsx` (add SupervisorPanel)
- Reference: `src/dashboard/workspace-events.ts` (WorkspaceEventMap)

- [ ] **Step 1: Create SupervisorPanel component**

React component that listens to `supervisor:*` events via WebSocket and renders:
- DAG node status badges (pending/running/done/failed) with colors
- Provider usage bar chart (horizontal bars per provider)
- Cost, time, wave progress counters
- Collapsible failure/escalation event log

Use existing shadcn/ui components from the web portal. Follow the glassmorphism design pattern used in other panels.

- [ ] **Step 2: Add supervisor events to WorkspaceEventMap**

In `src/dashboard/workspace-events.ts`, add `supervisor:*` event types to the `WorkspaceEventMap` interface.

- [ ] **Step 3: Wire SupervisorPanel into MonitorView**

Import and render `<SupervisorPanel />` in the monitor workspace mode, conditionally shown when supervisor is active.

- [ ] **Step 4: Test in browser**

Start the dev server: `cd web-portal && npm run dev`
Verify the panel renders correctly when supervisor events are emitted.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/SupervisorPanel.tsx web-portal/src/components/MonitorView.tsx src/dashboard/workspace-events.ts
git commit -m "feat(supervisor): add SupervisorPanel monitor component"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (4,527+ existing + ~50 new supervisor tests)

- [ ] **Step 2: Manual smoke test**

Start with multi-provider config (e.g., Claude + DeepSeek):
```bash
SUPERVISOR_ENABLED=true PROVIDER_CHAIN=claude,deepseek npm start
```
Send a complex task: "Build a user authentication system with JWT tokens, database schema, login/register endpoints, and integration tests"

Verify:
- Supervisor activates (check logs for `supervisor:activated`)
- DAG is created with multiple nodes
- Nodes are assigned to different providers
- Wave execution runs in parallel
- Final response is coherent

- [ ] **Step 3: Test single-provider mode**

Start with single provider:
```bash
SUPERVISOR_ENABLED=true npm start
```
Send same complex task. Verify:
- Same pipeline runs
- All nodes assigned to single provider
- Role-differentiated verification activates

- [ ] **Step 4: Run /simplify + /security-review + code-review**

Per CLAUDE.md mandatory reviews before push.

- [ ] **Step 5: Final commit and push**

```bash
git push origin main
```
