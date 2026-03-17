# Multi-Provider Intelligent Orchestration — Implementation Plan

> Historical plan note: This file is an implementation snapshot, not the source of truth for current runtime behavior or env defaults. Use [README.md](../../../README.md), [src/config/README.md](../../../src/config/README.md), [src/channels/README.md](../../../src/channels/README.md), and [SECURITY.md](../../../SECURITY.md) for the current system.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add task-aware dynamic routing across providers, PAOR phase switching, and confidence-based multi-provider consensus to Strada.Brain, with graceful single-provider degradation.

**Architecture:** TaskClassifier heuristically classifies prompts (type/complexity/criticality). ProviderRouter selects the best provider per task+phase using configurable presets. ConfidenceEstimator scores output confidence from PAOR state. ConsensusManager verifies low-confidence outputs with a second provider. All components no-op with a single provider.

**Tech Stack:** TypeScript, Vitest, existing provider-knowledge.ts metadata, existing ProviderManager, existing PAOR state machine

**Spec:** `docs/superpowers/specs/2026-03-16-multi-provider-orchestration-design.md`

---

## File Structure

```
src/agent-core/routing/
├── routing-types.ts           — TaskClassification, RoutingPreset, RoutingWeights, ConsensusResult
├── task-classifier.ts         — Heuristic prompt classification
├── task-classifier.test.ts    — Classification tests
├── routing-presets.ts         — budget/balanced/performance weight definitions
├── provider-router.ts         — Task+phase → provider selection
├── provider-router.test.ts    — Router tests (single + multi provider)
├── confidence-estimator.ts    — Heuristic output confidence scoring
├── consensus-manager.ts       — Multi-provider review/re-execute
├── consensus-manager.test.ts  — Consensus tests
└── index.ts                   — Barrel exports

Modified:
├── src/agents/orchestrator.ts         — PAOR loop uses ProviderRouter per-iteration
├── src/agent-core/agent-core.ts       — AgentCore uses ProviderRouter
├── src/core/bootstrap.ts              — Wire ProviderRouter
├── src/tasks/command-handler.ts       — /routing command
├── src/tasks/command-detector.ts      — /routing prefix
├── src/tasks/types.ts                 — "routing" in TaskCommand
├── src/config/config.ts               — routing + consensus config fields
├── web-portal/src/pages/SettingsPage.tsx — Routing preset + consensus UI
```

---

## Chunk 1: Phase 1 — TaskClassifier + ProviderRouter

### Task 1: Routing Types

**Files:**
- Create: `src/agent-core/routing/routing-types.ts`
- Create: `src/agent-core/routing/index.ts`

- [ ] **Step 1: Create routing-types.ts**

```typescript
/**
 * Multi-Provider Routing Types
 */

export type TaskType =
  | "planning" | "code-generation" | "code-review" | "simple-question"
  | "analysis" | "refactoring" | "destructive-operation" | "debugging";

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex";
export type TaskCriticality = "low" | "medium" | "high" | "critical";

export interface TaskClassification {
  readonly type: TaskType;
  readonly complexity: TaskComplexity;
  readonly criticality: TaskCriticality;
}

export type RoutingPreset = "budget" | "balanced" | "performance";

export interface RoutingWeights {
  readonly costWeight: number;
  readonly capabilityWeight: number;
  readonly speedWeight: number;
  readonly diversityWeight: number;
}

export interface RoutingDecision {
  readonly provider: string;
  readonly reason: string;
  readonly task: TaskClassification;
  readonly timestamp: number;
}

export interface OriginalOutput {
  readonly text?: string;
  readonly toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

export type ConsensusStrategy = "review" | "re-execute" | "skip";

export interface ConsensusResult {
  readonly agreed: boolean;
  readonly strategy: ConsensusStrategy;
  readonly originalProvider: string;
  readonly reviewProvider?: string;
  readonly reasoning?: string;
}
```

- [ ] **Step 2: Create index.ts barrel**

```typescript
export * from "./routing-types.js";
export { TaskClassifier } from "./task-classifier.js";
export { ProviderRouter } from "./provider-router.js";
export { ROUTING_PRESETS } from "./routing-presets.js";
export { ConfidenceEstimator } from "./confidence-estimator.js";
export { ConsensusManager } from "./consensus-manager.js";
```

- [ ] **Step 3: Verify TypeScript compiles** (will have import errors until files exist — that's fine)

- [ ] **Step 4: Commit**
```bash
git add src/agent-core/routing/
git commit -m "feat: add multi-provider routing type definitions"
```

---

### Task 2: TaskClassifier

**Files:**
- Create: `src/agent-core/routing/task-classifier.ts`
- Create: `src/agent-core/routing/task-classifier.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "vitest";
import { TaskClassifier } from "./task-classifier.js";

describe("TaskClassifier", () => {
  const classifier = new TaskClassifier();

  describe("type classification", () => {
    it("classifies short simple questions", () => {
      const result = classifier.classify("What is a MonoBehaviour?");
      expect(result.type).toBe("simple-question");
      expect(result.complexity).toBe("trivial");
    });

    it("classifies code generation requests", () => {
      const result = classifier.classify("Create a new PlayerController script with movement and jumping");
      expect(result.type).toBe("code-generation");
    });

    it("classifies planning requests", () => {
      const result = classifier.classify("Plan the architecture for a new inventory system with crafting, storage, and UI");
      expect(result.type).toBe("planning");
      expect(result.complexity).toBe("complex");
    });

    it("classifies debugging requests", () => {
      const result = classifier.classify("The build is failing with CS0246, fix it");
      expect(result.type).toBe("debugging");
    });

    it("classifies refactoring", () => {
      const result = classifier.classify("Refactor the PlayerController to use the new input system");
      expect(result.type).toBe("refactoring");
    });

    it("classifies review requests", () => {
      const result = classifier.classify("Review this code for bugs and performance issues");
      expect(result.type).toBe("code-review");
    });
  });

  describe("complexity classification", () => {
    it("trivial for very short prompts", () => {
      const result = classifier.classify("Hi");
      expect(result.complexity).toBe("trivial");
    });

    it("complex for long multi-part requests", () => {
      const result = classifier.classify(
        "Create a complete authentication system with login, signup, password reset, " +
        "email verification, OAuth integration, session management, and role-based access control"
      );
      expect(result.complexity).toBe("complex");
    });
  });

  describe("criticality from tool calls", () => {
    it("critical for destructive tools", () => {
      const result = classifier.classifyToolCall("file_delete", { path: "/src/foo.cs" });
      expect(result.criticality).toBe("critical");
      expect(result.type).toBe("destructive-operation");
    });

    it("medium for file writes", () => {
      const result = classifier.classifyToolCall("file_write", { path: "/src/bar.cs" });
      expect(result.criticality).toBe("medium");
    });

    it("low for read operations", () => {
      const result = classifier.classifyToolCall("file_read", { path: "/src/baz.cs" });
      expect(result.criticality).toBe("low");
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**
```bash
npx vitest run src/agent-core/routing/task-classifier.test.ts
```

- [ ] **Step 3: Implement TaskClassifier**

Create `src/agent-core/routing/task-classifier.ts` with heuristic rules:
- Keyword patterns for type detection (plan/architect/design → planning, create/write/add → code-generation, review/check/audit → code-review, fix/debug/error → debugging, refactor/restructure → refactoring)
- Prompt length + conjunction count for complexity (< 20 chars → trivial, < 80 → simple, < 200 → moderate, else complex)
- Tool name mapping for criticality (file_delete/shell_exec/git_push → critical, file_write/file_edit → medium, read-only tools → low)

- [ ] **Step 4: Run tests — expect PASS**
- [ ] **Step 5: Run full suite** `npx vitest run 2>&1 | tail -5`
- [ ] **Step 6: Commit**
```bash
git add src/agent-core/routing/task-classifier.ts src/agent-core/routing/task-classifier.test.ts
git commit -m "feat: add TaskClassifier with heuristic prompt and tool classification"
```

---

### Task 3: Routing Presets + ProviderRouter

**Files:**
- Create: `src/agent-core/routing/routing-presets.ts`
- Create: `src/agent-core/routing/provider-router.ts`
- Create: `src/agent-core/routing/provider-router.test.ts`

- [ ] **Step 1: Create routing-presets.ts**

Budget/balanced/performance weight definitions as in spec. Pure data file, no logic.

- [ ] **Step 2: Write ProviderRouter tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ProviderRouter } from "./provider-router.js";

describe("ProviderRouter", () => {
  it("returns single provider when only one available", () => {
    const mockPM = {
      listAvailable: () => [{ name: "kimi", label: "Kimi", defaultModel: "kimi-for-coding" }],
      getProvider: vi.fn().mockReturnValue({ name: "kimi" }),
      isAvailable: (n: string) => n === "kimi",
    };
    const router = new ProviderRouter(mockPM as any, "balanced");
    const result = router.resolve({ type: "planning", complexity: "complex", criticality: "high" });
    expect(result).toBeDefined();
    // Single provider — no routing decision needed
  });

  it("selects capable provider for planning tasks", () => {
    const providers = [
      { name: "groq", label: "Groq", defaultModel: "llama" },
      { name: "claude", label: "Claude", defaultModel: "claude-sonnet" },
    ];
    const mockPM = {
      listAvailable: () => providers,
      getProvider: vi.fn().mockImplementation((_, name) => ({ name })),
      isAvailable: () => true,
    };
    const router = new ProviderRouter(mockPM as any, "balanced");
    const result = router.resolve({ type: "planning", complexity: "complex", criticality: "high" });
    // Should prefer claude for planning (wider context, stronger reasoning)
    expect(result.name).toBe("claude");
  });

  it("selects cheap provider for simple questions in budget mode", () => {
    const providers = [
      { name: "claude", label: "Claude", defaultModel: "claude-sonnet" },
      { name: "groq", label: "Groq", defaultModel: "llama" },
    ];
    const mockPM = {
      listAvailable: () => providers,
      getProvider: vi.fn().mockImplementation((_, name) => ({ name })),
      isAvailable: () => true,
    };
    const router = new ProviderRouter(mockPM as any, "budget");
    const result = router.resolve({ type: "simple-question", complexity: "trivial", criticality: "low" });
    expect(result.name).toBe("groq");
  });

  it("records routing decisions for history", () => {
    const mockPM = {
      listAvailable: () => [{ name: "kimi", label: "Kimi", defaultModel: "m" }],
      getProvider: vi.fn().mockReturnValue({ name: "kimi" }),
      isAvailable: () => true,
    };
    const router = new ProviderRouter(mockPM as any, "balanced");
    router.resolve({ type: "debugging", complexity: "simple", criticality: "medium" });
    const history = router.getRecentDecisions(10);
    expect(history).toHaveLength(1);
    expect(history[0]!.provider).toBe("kimi");
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**
- [ ] **Step 4: Implement ProviderRouter**

Key logic:
- `resolve()`: list available providers, if 1 → return it. If 2+ → score each against task using preset weights + provider-knowledge metadata, return highest scorer.
- Scoring uses: `PROVIDER_KNOWLEDGE[name].contextWindow` (capability), `PROVIDER_KNOWLEDGE[name].strengths` keyword match (capability), cost tier estimation, speed tier estimation.
- `getRecentDecisions(n)`: returns last N routing decisions (for /routing info command).
- Phase-aware: if `phase === AgentPhase.REFLECTING`, apply diversity boost to providers different from last EXECUTING provider.

- [ ] **Step 5: Run tests — expect PASS**
- [ ] **Step 6: TypeScript check** `npx tsc --noEmit`
- [ ] **Step 7: Full test suite** `npx vitest run 2>&1 | tail -5`
- [ ] **Step 8: Commit**
```bash
git add src/agent-core/routing/routing-presets.ts src/agent-core/routing/provider-router.ts src/agent-core/routing/provider-router.test.ts
git commit -m "feat: add ProviderRouter with task-aware routing and configurable presets"
```

---

## Chunk 2: Phase 2 — PAOR Phase Switching + Wiring

### Task 4: Wire ProviderRouter into Orchestrator PAOR Loop

**Files:**
- Modify: `src/agents/orchestrator.ts`
- Modify: `src/core/bootstrap.ts`

- [ ] **Step 1: Add ProviderRouter to Orchestrator constructor options**

Add optional `providerRouter?: ProviderRouter` to the Orchestrator constructor opts interface.

- [ ] **Step 2: Modify PAOR loop to resolve provider per iteration**

In `runAgentLoop()`, change the provider resolution from:
```typescript
const provider = this.providerManager.getProvider(chatId);
```
To:
```typescript
let provider = this.providerManager.getProvider(chatId);
// ProviderRouter overrides per-phase if available and multi-provider
const taskClass = this.providerRouter?.classifyFromState?.(agentState, lastUserMessage);
```

Then inside the PAOR loop, before each `provider.chat()` call:
```typescript
if (this.providerRouter && taskClass) {
  const phaseProvider = this.providerRouter.resolve(taskClass, agentState.phase);
  if (phaseProvider) provider = phaseProvider;
}
```

Apply same pattern to `runBackgroundTask()`.

- [ ] **Step 3: Wire in bootstrap.ts**

After ProviderManager creation, create ProviderRouter and pass to Orchestrator:
```typescript
const providerRouter = new ProviderRouter(providerManager, config.routing?.preset ?? "balanced");
```

- [ ] **Step 4: TypeScript check** `npx tsc --noEmit`
- [ ] **Step 5: Full test suite** `npx vitest run 2>&1 | tail -5`
- [ ] **Step 6: Commit**
```bash
git add src/agents/orchestrator.ts src/core/bootstrap.ts
git commit -m "feat: wire ProviderRouter into PAOR loop — phase-aware provider switching"
```

---

### Task 5: Wire ProviderRouter into AgentCore

**Files:**
- Modify: `src/agent-core/agent-core.ts`
- Modify: `src/core/bootstrap.ts`

- [ ] **Step 1: Replace fixed provider with ProviderRouter in AgentCore**

Change AgentCore constructor to accept optional `ProviderRouter`. In `tick()`, resolve provider through router:
```typescript
const taskClass = this.taskClassifier.classify(topObservation.summary);
const provider = this.providerRouter?.resolve(taskClass) ?? this.defaultProvider;
```

- [ ] **Step 2: Update bootstrap to pass ProviderRouter to AgentCore**

- [ ] **Step 3: TypeScript check + full tests**
- [ ] **Step 4: Commit**
```bash
git add src/agent-core/agent-core.ts src/core/bootstrap.ts
git commit -m "feat: AgentCore uses ProviderRouter for task-aware provider selection"
```

---

## Chunk 3: Phase 3 — Confidence + Consensus

### Task 6: ConfidenceEstimator

**Files:**
- Create: `src/agent-core/routing/confidence-estimator.ts`
- Test in: `src/agent-core/routing/consensus-manager.test.ts`

- [ ] **Step 1: Write tests**

Test heuristic scoring:
- High confidence: low complexity + zero errors + normal response length
- Low confidence: high complexity + cheap model + 3 consecutive errors
- Medium confidence: moderate complexity + some errors

- [ ] **Step 2: Implement ConfidenceEstimator**

Pure heuristic calculation from AgentState + TaskClassification. Weighted factors:
- sessionErrors (from stepResults): weight 0.3
- complexityMismatch (task.complexity vs modelTier): weight 0.25
- consecutiveErrors: weight 0.25
- responseLengthAnomaly: weight 0.2

- [ ] **Step 3: Tests pass, commit**

---

### Task 7: ConsensusManager

**Files:**
- Create: `src/agent-core/routing/consensus-manager.ts`
- Create: `src/agent-core/routing/consensus-manager.test.ts`

- [ ] **Step 1: Write tests**

```typescript
describe("ConsensusManager", () => {
  it("skips when only 1 provider available", async () => {
    // Should return agreed:true with strategy:skip
  });

  it("performs review for destructive tool calls", async () => {
    // originalOutput has toolCalls with file_delete
    // Should serialize tool call and ask second provider
  });

  it("performs re-execute for very low confidence", async () => {
    // confidence < 0.4, should run same prompt on different provider
  });

  it("returns agreed when both providers match", async () => {
    // Two providers give similar response
  });

  it("escalates when providers disagree", async () => {
    // Two providers give different response, no third available
  });
});
```

- [ ] **Step 2: Implement ConsensusManager**

Key methods:
- `shouldConsult(confidence, task, availableCount, config)`: returns ConsensusStrategy or "skip"
- `verify(params)`: executes the chosen strategy
- Review strategy: serialize tool calls as readable text, ask provider B "Is this correct?"
- Re-execute strategy: same prompt to provider B, compare outputs
- Comparison: simple text similarity check (not semantic — heuristic)

- [ ] **Step 3: Tests pass**
- [ ] **Step 4: TypeScript + full suite**
- [ ] **Step 5: Commit**
```bash
git add src/agent-core/routing/confidence-estimator.ts src/agent-core/routing/consensus-manager.ts src/agent-core/routing/consensus-manager.test.ts
git commit -m "feat: add ConfidenceEstimator + ConsensusManager for multi-provider consensus"
```

---

## Chunk 4: Phase 4 — Config + Commands + Validation

### Task 8: Configuration

**Files:**
- Modify: `src/config/config.ts` — add routing + consensus config fields
- Modify: `src/core/bootstrap.ts` — read config

- [ ] **Step 1: Add Zod schema fields**
- [ ] **Step 2: Wire into bootstrap**
- [ ] **Step 3: Tests pass, commit**

### Task 9: /routing Command

**Files:**
- Modify: `src/tasks/types.ts` — add "routing" to TaskCommand
- Modify: `src/tasks/command-detector.ts` — add /routing prefix
- Modify: `src/tasks/command-handler.ts` — handleRouting method

- [ ] **Step 1: Add command routing**
- [ ] **Step 2: Implement handler** (status, preset switch, info)
- [ ] **Step 3: Tests pass, commit**

### Task 10: Web Portal Updates

**Files:**
- Modify: `web-portal/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add Routing Preset selector** (3 buttons)
- [ ] **Step 2: Add Consensus Mode selector** (4 options)
- [ ] **Step 3: Build portal** `cd web-portal && npm run build`
- [ ] **Step 4: Commit**

### Task 11: Final Validation

- [ ] **Step 1: TypeScript check** `npx tsc --noEmit`
- [ ] **Step 2: Full test suite** `npx vitest run`
- [ ] **Step 3: Start with daemon mode** — verify routing decisions in logs
- [ ] **Step 4: Verify single-provider graceful degradation**

---

## Future: Phase 5 (Separate Plan)

### TierRouter Integration
- Wrap TierRouter inside ProviderRouter (facade pattern)
- DelegationManager uses ProviderRouter for initial selection
- TierRouter escalation chain preserved
- Planned after Phases 1-4 validated
