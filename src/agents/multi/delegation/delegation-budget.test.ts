import { describe, it, expect } from "vitest";
import { DELEGATION_TIMEOUT_CAP_MS, resolveDelegationBudget } from "./delegation-budget.js";

// Measured 2026-09-07: 17 code_review delegations, all timeouts at 60 000 ms.
describe("resolveDelegationBudget", () => {
  const t = (durationMs: number) => ({ status: "timeout", durationMs });
  const ok = { status: "completed", durationMs: 12_000 };

  it("keeps the configured budget with no history or after a completion", () => {
    expect(resolveDelegationBudget("code_review", 60_000, [])).toEqual({ timeoutMs: 60_000, consecutiveTimeouts: 0 });
    expect(resolveDelegationBudget("code_review", 60_000, [ok, t(60_000), t(60_000)]).timeoutMs).toBe(60_000);
  });

  it("doubles the budget per consecutive timeout, capped", () => {
    expect(resolveDelegationBudget("code_review", 60_000, [t(60_000)]).timeoutMs).toBe(120_000);
    expect(resolveDelegationBudget("code_review", 60_000, [t(120_000), t(60_000)]).timeoutMs).toBe(240_000);
    const capped = resolveDelegationBudget("code_review", 60_000, [t(480_000), t(240_000), t(120_000), t(60_000)]);
    expect(capped.timeoutMs).toBe(DELEGATION_TIMEOUT_CAP_MS);
    expect(capped.refusal).toBeUndefined();
  });

  it("refuses the type after repeated timeouts AT the cap, and a completion clears it", () => {
    const wall = [t(600_010), t(600_005), t(600_020), t(480_000)];
    const r = resolveDelegationBudget("code_review", 60_000, wall);
    expect(r.refusal).toContain('Delegation "code_review" refused');
    expect(r.refusal).toContain("600 s cap");
    expect(resolveDelegationBudget("code_review", 60_000, [ok, ...wall]).refusal).toBeUndefined();
  });

  it("a blocked run does not end a timeout streak (it is not a success)", () => {
    const blocked = { status: "blocked", durationMs: 30_000 };
    expect(resolveDelegationBudget("code_review", 60_000, [blocked, t(60_000)]).timeoutMs).toBe(120_000);
  });

  it("a refusal expires: cap timeouts older than the window are not evidence", () => {
    // A refusal is decided before a new row can be written, so without a window nothing could
    // ever end the streak — one slow afternoon refused the type forever.
    const now = Date.UTC(2026, 8, 24, 12);
    const at = (hoursAgo: number) => ({ status: "timeout", durationMs: 600_010, startedAt: now - hoursAgo * 3_600_000 });
    const stale = resolveDelegationBudget("analysis", 60_000, [at(7), at(7.2), at(7.5)], now);
    expect(stale.refusal).toBeUndefined();
    expect(stale.timeoutMs).toBe(60_000);
    expect(resolveDelegationBudget("analysis", 60_000, [at(1), at(1.2), at(1.5)], now).refusal).toBeDefined();
    // The streak stops at the first stale row: two fresh cap timeouts are not a refusal.
    expect(resolveDelegationBudget("analysis", 60_000, [at(1), at(2), at(7)], now).refusal).toBeUndefined();
  });
});
