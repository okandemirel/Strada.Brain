/**
 * Task #87: a run's Budget saw its model turns and nothing else. Goal decomposition, reviewer and
 * consensus calls were recorded (metrics, the rate limiter, the run's onUsage) and never debited,
 * so the run's token and cost gates judged "budget-exhausted" on a short count.
 *
 * A served call is recorded through one of accounting.ts's three entry points: the engine's funnels
 * recordProviderUsage and recordAuxiliaryUsage, and the direct-call ledger's record
 * (createProviderUsageLedger, task #71). The two funnels and the ledger's run-billed call debit the
 * Budget of the run they run inside (control/budget-scope.ts), once. An ownerless call debits no
 * run's Budget and logs no warning (createProviderUsageLedger says why); a run-billed call recorded
 * with no Budget in scope logs one. This file pins that, and the tripwires that keep it true:
 * provider usage reaches the metrics and rate-limiter counters only through recordAuxiliaryUsage
 * and the shared recorder, which recordServedCall alone calls, after the debit. A new writer of the
 * counters, or a second call of the shared recorder, records spend that no run's Budget sees — the
 * fifth time this class was found (#67, #71, #72, #73, #87).
 *
 * An entry point debits only the Budget whose scope is open around it. QA found the supervisor
 * run's Budget opened with no scope, so its plan call was recorded and debited nowhere: a further
 * tripwire pins every place that creates a run Budget and how the work it pays for reaches it, and
 * the last pins every production call of the entry points with the scope it runs in.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createLogger, getLoggerSafe } from "../../utils/logger.js";
import { createBudget } from "../control/budget.js";
import { runBudget, toBudgetUsage, UNSCOPED_DEBIT_LOG, withRunBudget } from "../control/budget-scope.js";
import {
  consensusUsageSink,
  createProviderUsageLedger,
  recordAuxiliaryUsage,
  recordProviderUsage,
  type AccountingDeps,
} from "./accounting.js";

beforeAll(() => {
  try { createLogger("error", join(tmpdir(), "strada-accounting-run-budget-test.log")); } catch { /* already */ }
});

function deps(): AccountingDeps {
  const counters = { metrics: { recordTokenUsage: vi.fn() } };
  return {
    getSupervisorRoutingContext: () => counters,
    metrics: counters.metrics,
  } as unknown as AccountingDeps;
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

describe("the accounting funnels debit the Budget of the run they run inside", () => {
  it("a model turn, a reviewer and a consensus reviewer are each debited once", () => {
    const budget = createBudget(10_000, 10);
    const d = deps();
    withRunBudget(budget, () => {
      recordProviderUsage(d, "ollama", usage(100, 7), undefined, "local-model");
      recordAuxiliaryUsage(d, "ollama", usage(50, 11), undefined, "local-model");
      consensusUsageSink(d, {})({ provider: "ollama", model: "local-model", inputTokens: 20, outputTokens: 13 });
    });
    expect(budget.spentOutputTokens(), "a call recorded in the run was not debited from its Budget, or twice").toBe(31);
    expect(budget.remainingOutputTokens()).toBe(10_000 - 31);
    expect(budget.inputTokensSeen()).toBe(170);
  });

  it("a paid reviewer's cost comes out of the run's cost headroom, priced like the model that served it", () => {
    const budget = createBudget(10_000, 10);
    const spent = usage(200_000, 40_000);
    withRunBudget(budget, () => recordAuxiliaryUsage(deps(), "claude", spent, undefined, "claude-sonnet-5"));
    const cost = toBudgetUsage(spent, "claude", "claude-sonnet-5").costUsd ?? 0;
    expect(cost).toBeGreaterThan(0);
    expect(budget.remainingCostUsd()).toBeCloseTo(10 - cost, 9);
  });

  it("outside a run nothing is debited and nothing throws", () => {
    const budget = createBudget(10_000, 10);
    expect(runBudget()).toBeUndefined();
    expect(() => {
      recordProviderUsage(deps(), "ollama", usage(100, 7));
      recordAuxiliaryUsage(deps(), "ollama", usage(50, 11));
    }).not.toThrow();
    expect(budget.spentOutputTokens()).toBe(0);
  });

  it("a call recorded after an await debits its own run, and concurrent runs keep their own counts", async () => {
    const first = createBudget(10_000, 10);
    const second = createBudget(10_000, 10);
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all([
      withRunBudget(first, async () => {
        await tick();
        recordProviderUsage(deps(), "ollama", usage(1, 3));
        await tick();
        recordAuxiliaryUsage(deps(), "ollama", usage(1, 4));
      }),
      withRunBudget(second, async () => {
        await tick();
        recordProviderUsage(deps(), "ollama", usage(1, 5));
      }),
    ]);
    expect(first.spentOutputTokens()).toBe(7);
    expect(second.spentOutputTokens()).toBe(5);
  });

  it("a delegated child's spend reaches its parent once, through the child Budget's parent link", async () => {
    const parent = createBudget(10_000, 10);
    let child = createBudget(0, 0);
    await withRunBudget(parent, async () => {
      child = createBudget(1_000, 1, parent);
      await withRunBudget(child, async () => recordProviderUsage(deps(), "ollama", usage(10, 9)));
      recordAuxiliaryUsage(deps(), "ollama", usage(10, 2));
    });
    expect(child.spentOutputTokens()).toBe(9);
    expect(parent.spentOutputTokens(), "the parent counted the child's spend twice, or not at all").toBe(11);
  });

  it("a reply with no usage debits nothing", () => {
    const budget = createBudget(10_000, 10);
    withRunBudget(budget, () => {
      recordProviderUsage(deps(), "ollama", undefined);
      recordAuxiliaryUsage(deps(), "ollama", undefined);
    });
    expect(budget.spentOutputTokens()).toBe(0);
    expect(budget.inputTokensSeen()).toBe(0);
  });
});

describe("the direct-call ledger (billedChat, task #71) debits a call its run pays for, and only that", () => {
  const served = { provider: "claude", model: "claude-sonnet-5", usage: usage(3_000, 500) };
  const unscopedWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.filter(([message]) => message === UNSCOPED_DEBIT_LOG).length;

  it("a run-billed call inside a run's scope is debited once, priced like the model that served it", () => {
    const budget = createBudget(10_000, 10);
    const ledger = createProviderUsageLedger({ counters: {} });
    withRunBudget(budget, () => ledger.record(served, { purpose: "supervisor-verification", run: {} }));
    expect(budget.spentOutputTokens(), "the run-billed call never reached the Budget in scope, or twice").toBe(500);
    expect(budget.inputTokensSeen()).toBe(3_000);
    expect(budget.remainingCostUsd()).toBeCloseTo(10 - (toBudgetUsage(served.usage, "claude", "claude-sonnet-5").costUsd ?? 0), 9);
  });

  it("an ownerless call inside a run's scope debits no run, is not logged unscoped, and is booked to its source", () => {
    const budget = createBudget(10_000, 10);
    const recordCost = vi.fn();
    const warn = vi.spyOn(getLoggerSafe(), "warn");
    const ledger = createProviderUsageLedger({ counters: {}, budget: { recordCost } });
    withRunBudget(budget, () => ledger.record(served, { purpose: "session-summary", ownerless: "daemon" }));
    expect(budget.spentOutputTokens(), "a call no run pays for was debited from the run it ran inside").toBe(0);
    expect(unscopedWarnings(warn)).toBe(0);
    expect(recordCost).toHaveBeenCalledWith(expect.any(Number), "daemon", expect.objectContaining({ triggerName: "session-summary" }));
    warn.mockRestore();
  });

  it("a run-billed call with no run's Budget in scope says so", () => {
    const warn = vi.spyOn(getLoggerSafe(), "warn");
    createProviderUsageLedger({ counters: {} }).record(served, { purpose: "capability-triage", run: {} });
    expect(unscopedWarnings(warn), "a run-billed call went unseen by every Budget, silently").toBe(1);
    warn.mockRestore();
  });
});

// ─── Tripwire: provider usage reaches the counters through accounting.ts's entry points only ─

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const ACCOUNTING = "src/agent-core/engine/accounting.ts";
const SHARED_RECORDER = "src/agents/orchestrator-supervisor-routing.ts";
const FIX = `record it through recordProviderUsage or recordAuxiliaryUsage in ${ACCOUNTING}, which debit the run's Budget (task #87)`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts") ? [path] : [];
  });
}

/** Per repo-relative file, how many code lines (comments left out) match `pattern`. */
function codeLineCounts(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !/^(?:\/\/|\*|\/\*)/.test(line) && pattern.test(line)).length;
    if (hits > 0) counts[relative(join(SRC, ".."), file).split("\\").join("/")] = hits;
  }
  return counts;
}

describe("tripwire: no provider spend is recorded where the run's Budget cannot see it", () => {
  it(
    "only the two funnels and the shared recorder they call write the metrics and rate-limiter token counters",
    () => {
      expect(codeLineCounts(/\.recordTokenUsage\(/), `a new writer of the token counters: ${FIX}`).toEqual({
        // recordAuxiliaryUsage: metrics + rate limiter, after debitRunBudget.
        [ACCOUNTING]: 2,
        // The shared recorder (metrics + rate limiter) that recordProviderUsage calls.
        [SHARED_RECORDER]: 2,
      });
    },
    120_000,
  );

  it(
    "the shared recorder is imported by accounting.ts alone and called once, by the funnel that debits first",
    () => {
      const importers = sourceFiles(SRC)
        .filter((file) =>
          [...readFileSync(file, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*orchestrator-supervisor-routing\.js"/g)]
            .some((m) => /(?:^|[\s,])recordProviderUsage\b/.test(m[1] ?? "")),
        )
        .map((file) => relative(join(SRC, ".."), file).split("\\").join("/"));
      expect(importers, `the shared recorder is called from outside the funnels: ${FIX}`).toEqual([ACCOUNTING]);
      const calls = readFileSync(join(SRC, "agent-core/engine/accounting.ts"), "utf8").match(/recordProviderUsageHelper\(/g) ?? [];
      expect(calls.length, `a second call of the shared recorder skips the run's Budget: ${FIX}`).toBe(1);
    },
    120_000,
  );
});

// ─── Tripwire: every run Budget is reachable from the calls it pays for ──────────────────────

/**
 * Every production `createBudget(` site, how many it has, and how the calls its Budget pays for
 * reach it: a scope opened around the work, or a child run opened on a Budget whose parent it is.
 * Each `evidence` pattern must match in its file; `proof` is the test that measures it end to end.
 */
const BUDGET_PRODUCERS: Record<string, { count: number; how: string; evidence: Array<[string, RegExp]>; proof: string }> = {
  "src/agent-core/control/control-plane.ts": {
    count: 2,
    how: "openRun's Budget: V2AgentRunner.run opens its scope around the whole run",
    evidence: [["src/agent-core/runner/v2-agent-runner.ts", /withRunBudget\(opened\.budget, /]],
    proof: "src/agent-core/runner/v2-agent-runner.run-budget.test.ts",
  },
  "src/agents/orchestrator-supervisor-budget.ts": {
    count: 1,
    how: "the supervisor admission's Budget: its scope is opened around the grounding call and SupervisorBrain.execute",
    evidence: [
      ["src/agents/orchestrator-supervisor-budget.ts", /withRunBudget\(runBudget, \(\) => work\(runBudget\)\)/],
      ["src/agents/orchestrator.ts", /admissionBudget\.within\(\(\) => this\.resolveGroundedSupervisorPlanningPrompt\(/],
      ["src/agents/orchestrator.ts", /admissionBudget\.within\(\(runBudget\) => brain\.execute\(/],
    ],
    proof: "src/agents/orchestrator-supervisor-run-budget.test.ts",
  },
  "src/agents/multi/delegation/delegation-manager.ts": {
    count: 1,
    how: "a delegation's slice spends nothing itself: the delegated V2 run opens its scope on a Budget whose parent it is",
    evidence: [
      [
        "src/agents/multi/delegation/delegation-manager.ts",
        /childBudget: runBudget\s*\?\s*\{ slice: runBudget\.carveChild\(1, 1\), parent: runBudget \}/,
      ],
    ],
    proof: "src/agent-core/runner/v2-agent-runner.run-budget.test.ts",
  },
  "src/agent-core/control/budget.ts": {
    count: 1,
    how: "a pool holder spends nothing itself: each node run opens its scope on a Budget whose parent it is",
    evidence: [["src/agent-core/control/budget.ts", /childBudget: \{ slice, parent: holder \}/]],
    proof: "src/agents/orchestrator-supervisor-run-budget.test.ts",
  },
};

describe("tripwire: no run Budget is created where the calls it pays for cannot reach it", () => {
  it(
    "every place that creates a run Budget is pinned with the scope or parent link its spend arrives through",
    () => {
      const sites = codeLineCounts(/(?<!function )\bcreateBudget\(/);
      expect(
        sites,
        "a new run Budget: open withRunBudget(budget, …) around the work it pays for (control/budget-scope.ts), " +
          "or spend it only through child runs opened on it as parent; then pin it in BUDGET_PRODUCERS with the test that measures it",
      ).toEqual(Object.fromEntries(Object.entries(BUDGET_PRODUCERS).map(([file, p]) => [file, p.count])));
      const root = join(SRC, "..");
      for (const [file, producer] of Object.entries(BUDGET_PRODUCERS)) {
        for (const [where, pattern] of producer.evidence) {
          expect(pattern.test(readFileSync(join(root, where), "utf8")), `${file}: ${producer.how} — no longer true in ${where}`).toBe(true);
        }
        expect(statSync(join(root, producer.proof)).isFile(), `${file}: its proof ${producer.proof} is gone`).toBe(true);
      }
    },
    120_000,
  );
});

// ─── Tripwire: every call of the funnels runs where a run's Budget is in scope ───────────────

/** The engine's funnels, and the direct-call ledger's entry points (billed-call.ts, task #71). */
const FUNNELS = new Set([
  "recordProviderUsage",
  "recordAuxiliaryUsage",
  "consensusUsageSink",
  "decompositionUsageSink",
  "billedChat",
  "billedStreamOrChatText",
]);

const IN_RUN = "inside a V2 run's dispatch: V2AgentRunner.run opens the run's Budget scope (v2-agent-runner.run-budget.test.ts)";
const IN_ADMISSION = "inside the supervisor admission's Budget scope (orchestrator-supervisor-run-budget.test.ts)";
const PASS_THROUGH = "a funnel's own wrapper: it runs in its caller's scope, and its callers are pinned here";
const OWNERLESS = (source: string) =>
  `no run pays (OwnerlessBilling, "${source}"): booked to the cost ledger under it, never debited from a run's Budget (createProviderUsageLedger)`;

/** Where each production call of a funnel runs, keyed "file › enclosing names → funnel". */
const FUNNEL_CALLERS: Record<string, { count: number; scope: string }> = {
  "src/agent-core/agent-core.ts › AgentCore.tick.response → billedChat": { count: 1, scope: OWNERLESS("daemon") },
  "src/agents/style/style-analysis.ts › StyleAnalysis.analyze.response → billedStreamOrChatText": { count: 1, scope: OWNERLESS("chat") },
  "src/campaign/acceptance-author.ts › AcceptanceAuthor.run → billedStreamOrChatText": { count: 1, scope: OWNERLESS("chat") },
  "src/campaign/campaign-planner.ts › CampaignPlanner.ask → billedStreamOrChatText": { count: 1, scope: OWNERLESS("chat") },
  "src/campaign/visual-conformance.ts › judgeVisualConformance.response → billedChat": { count: 1, scope: OWNERLESS("chat") },
  "src/learning/chains/chain-synthesizer.ts › ChainSynthesizer.callLLM.response → billedChat": { count: 1, scope: OWNERLESS("daemon") },
  "src/memory/unified/session-summarizer.ts › SessionSummarizer.summarize.response → billedChat": { count: 1, scope: OWNERLESS("daemon") },
  "src/vault/symbol-summarizer.ts › summarizeSymbol.response → billedChat": { count: 1, scope: OWNERLESS("chat") },
  "src/core/bootstrap-stages/stage-agents.ts › initializeMemoryConsolidationStage.summarizeWithLLM.response → billedChat": { count: 1, scope: OWNERLESS("daemon") },
  "src/agents/providers/fallback-chain.ts › FallbackChainProvider.tryWithFallback.probe → billedChat": { count: 1, scope: OWNERLESS("daemon") },
  "src/supervisor/capability-matcher.ts › CapabilityMatcher.matchWithTriage.response → billedChat": {
    count: 1,
    scope: `run-billed capability triage, before the nodes are carved: ${IN_ADMISSION}`,
  },
  "src/supervisor/supervisor-verification.ts › createSupervisorNodeVerifier.response → billedStreamOrChatText": {
    count: 1,
    scope: "run-billed node verification, called by SupervisorBrain.execute: inside the supervisor admission's Budget scope (the ledger's run path: accounting.run-budget.test.ts)",
  },
  "src/agent-core/engine/accounting.ts › consensusUsageSink → recordProviderUsage": { count: 1, scope: PASS_THROUGH },
  "src/agent-core/engine/accounting.ts › recordServedCall → recordProviderUsage": {
    count: 1,
    scope: "the shared recorder under both paths (the funnel and the direct-call ledger), called once and after the debit (the shared-recorder tripwire above)",
  },
  "src/agent-core/engine/agent-engine.ts › AgentEngine.recordAuxiliaryUsage → recordAuxiliaryUsage": { count: 1, scope: PASS_THROUGH },
  "src/agent-core/engine/agent-engine.ts › AgentEngine.recordProviderUsage → recordProviderUsage": { count: 1, scope: PASS_THROUGH },
  "src/agent-core/engine/port.ts › createAgentCorePort.portImpl.recordProviderUsage → recordProviderUsage": {
    count: 1,
    scope: `the port's record, which the runner calls for every model turn: ${IN_RUN}`,
  },
  "src/agent-core/engine/review.ts › reviewShellCommandWithProvider → recordAuxiliaryUsage": { count: 1, scope: `the shell review of a tool turn: ${IN_RUN}` },
  "src/agent-core/engine/review.ts › runVisibilityReview → recordAuxiliaryUsage": { count: 1, scope: `the end-turn visibility review: ${IN_RUN}` },
  "src/agent-core/engine/tool-turn.ts › portExecuteToolTurn.consensusVerdict.onUsage → consensusUsageSink": { count: 1, scope: IN_RUN },
  "src/agent-core/runner/v2-agent-runner.ts › V2AgentRunner.runInner → recordProviderUsage": {
    count: 3,
    scope: `the served turn, its auxiliaryUsage and a failed attempt's usageBy: ${IN_RUN}`,
  },
  "src/agents/autonomy/progress-assessment.ts › runProgressAssessment → recordAuxiliaryUsage": { count: 1, scope: `the intervention pipeline: ${IN_RUN}` },
  "src/agents/orchestrator-goal-decomposition.ts › decompositionUsageSink → recordProviderUsage": { count: 1, scope: PASS_THROUGH },
  "src/agents/orchestrator-goal-decomposition.ts › runProactiveGoalDecomposition.goalTree.onUsage → decompositionUsageSink": {
    count: 1,
    scope: `the port's decomposeGoalsIfPlanning: ${IN_RUN}`,
  },
  "src/agents/orchestrator-goal-decomposition.ts › runReactiveGoalDecomposition.updatedTree.onUsage → decompositionUsageSink": {
    count: 1,
    scope: `reflection's re-plan: ${IN_RUN}`,
  },
  "src/agents/orchestrator-intervention-pipeline.ts › resolveLoopRecoveryReview → recordAuxiliaryUsage": { count: 1, scope: `the intervention pipeline: ${IN_RUN}` },
  "src/agents/orchestrator-intervention-pipeline.ts › reviewClarification → recordAuxiliaryUsage": { count: 1, scope: `the intervention pipeline: ${IN_RUN}` },
  "src/agents/orchestrator.ts › Orchestrator.buildInterventionDeps.recordAuxiliaryUsage → recordAuxiliaryUsage": { count: 1, scope: PASS_THROUGH },
  "src/agents/orchestrator.ts › Orchestrator.evaluateSupervisorAdmission.result.onPlanningUsage → decompositionUsageSink": {
    count: 1,
    scope: `the supervisor's plan: ${IN_ADMISSION}`,
  },
  "src/agents/orchestrator.ts › Orchestrator.evaluateSupervisorAdmission.result.onPlanningUsage → recordProviderUsage": {
    count: 1,
    scope: `the supervisor's plan: ${IN_ADMISSION}`,
  },
  "src/agents/orchestrator.ts › Orchestrator.recordAuxiliaryUsage → recordAuxiliaryUsage": { count: 1, scope: PASS_THROUGH },
  "src/agents/orchestrator.ts › Orchestrator.recordProviderUsage → recordProviderUsage": {
    count: 2,
    scope: `${PASS_THROUGH} (the private wrapper, and the goal-decomposition deps' hook)`,
  },
  "src/agents/orchestrator.ts › Orchestrator.resolveGroundedSupervisorPlanningPrompt → recordProviderUsage": {
    count: 1,
    scope: `the grounding call on an image, before the plan: ${IN_ADMISSION}`,
  },
  "src/agents/orchestrator.ts › Orchestrator.synthesizeGoalExecutionResult → recordProviderUsage": {
    count: 1,
    scope: "no production caller today, tests only: name the scope before one is wired",
  },
  "src/agents/orchestrator.ts › Orchestrator.synthesizeUserFacingResponse → recordProviderUsage": {
    count: 1,
    scope: `the end-turn, reflection and intervention syntheses: ${IN_RUN}`,
  },
};

/** Every production call of a funnel, keyed by its file and the names that enclose it. */
function funnelCalls(): Record<string, number> {
  const root = join(SRC, "..");
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (![...FUNNELS].some((name) => text.includes(name))) continue;
    const rel = relative(root, file).split("\\").join("/");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // A funnel imported under another name is still that funnel (`import { x as y }`).
    const local = new Map<string, string>([...FUNNELS].map((name) => [name, name]));
    for (const statement of sf.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const original = (element.propertyName ?? element.name).text;
        if (FUNNELS.has(original)) local.set(element.name.text, original);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? local.get(node.expression.text)
          : ts.isPropertyAccessExpression(node.expression) && FUNNELS.has(node.expression.name.text)
            ? node.expression.name.text
            : undefined;
        if (callee !== undefined) {
          const names: string[] = [];
          for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
            const named = ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)
              || ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p);
            const name = named ? (p as { name?: ts.Node }).name : undefined;
            if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) names.unshift(name.text);
          }
          const key = `${rel} › ${names.join(".")} → ${callee}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return counts;
}

describe("tripwire: every call of the usage funnels is pinned with the run Budget scope it runs in", () => {
  it(
    "a new caller fails until it names the scope its call is debited in",
    () => {
      expect(
        funnelCalls(),
        "a new call of a usage funnel: run it where a run's Budget is in scope (withRunBudget, control/budget-scope.ts) " +
          "and pin it in FUNNEL_CALLERS with that scope and the test that measures it",
      ).toEqual(Object.fromEntries(Object.entries(FUNNEL_CALLERS).map(([key, caller]) => [key, caller.count])));
    },
    120_000,
  );
});
