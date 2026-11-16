/**
 * Task #87: a run's Budget saw its model turns and nothing else. Goal decomposition, reviewer and
 * consensus calls were recorded (metrics, the rate limiter, the run's onUsage) and never debited,
 * so the run's token and cost gates judged "budget-exhausted" on a short count.
 *
 * Every recorded call passes through accounting.ts's two funnels, and they now debit the Budget of
 * the run they run inside (control/budget-scope.ts). This file pins that, and the tripwire that
 * keeps it true: provider usage reaches the metrics and rate-limiter counters only through those
 * two funnels. A new writer of the counters, or a second call of the shared recorder, records spend
 * that no run's Budget sees — the fifth time this class was found (#67, #71, #72, #73, #87).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../utils/logger.js";
import { createBudget } from "../control/budget.js";
import { runBudget, toBudgetUsage, withRunBudget } from "../control/budget-scope.js";
import { consensusUsageSink, recordAuxiliaryUsage, recordProviderUsage, type AccountingDeps } from "./accounting.js";

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

// ─── Tripwire: provider usage is recorded through the two funnels only ───────────────────────

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
