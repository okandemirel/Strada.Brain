import { describe, expect, it } from "vitest";
import { describeStoppedPlan } from "./stopped-plan-summary.js";
import type { NodeResult } from "./supervisor-types.js";

// Invented plan: a bakery's weekly order sheet, unrelated to any project run.
const PLAN = {
  request: "Prepare the weekly flour order and the supplier invoice summary.",
  nodes: [
    { id: "goal_1700000000000_aaaa1111", task: "Count the flour sacks left in the storeroom" },
    { id: "goal_1700000000000_bbbb2222", task: "Write the flour order for the mill" },
    { id: "goal_1700000000000_cccc3333", task: "Summarise this week's supplier invoices" },
  ],
};
const [COUNT, ORDER, INVOICES] = PLAN.nodes.map((n) => n.id) as [string, string, string];

function node(nodeId: string, status: NodeResult["status"], output: string, extra: Partial<NodeResult> = {}): NodeResult {
  return {
    nodeId: nodeId as NodeResult["nodeId"],
    status,
    output,
    artifacts: [],
    toolResults: [],
    provider: "deepseek",
    model: "worker",
    cost: 0,
    duration: 0,
    ...extra,
  };
}

describe("describeStoppedPlan", () => {
  it("names every step by its task and never prints a goal id", () => {
    // The golden run's shape (2026-11-06): the first step blocked with the
    // bare word "blocked", the rest skipped behind it.
    const text = describeStoppedPlan([
      node(COUNT, "failed", "blocked", { blockedReason: "blocked", terminalKey: "task_stuck" }),
      node(ORDER, "skipped", "Skipped: dependency failed"),
      node(INVOICES, "skipped", "Skipped: budget exhausted"),
    ], PLAN);

    expect(text).toBe(
      "Steps finished: 0 of 3.\n\n" +
      'Could not finish "Count the flour sacks left in the storeroom" (it kept trying without making progress)\n' +
      'Did not start "Write the flour order for the mill" (a step it depends on did not finish)\n' +
      'Did not start "Summarise this week\'s supplier invoices" (too many steps had failed, so no new step was started)',
    );
    expect(text).not.toMatch(/goal_/);
  });

  it("keeps what a finished step reported, under its name", () => {
    const text = describeStoppedPlan([
      node(COUNT, "ok", "42 sacks left."),
      node(ORDER, "failed", "The mill's order form rejected the quantity field."),
      node(INVOICES, "cancelled", ""),
    ], PLAN);

    expect(text).toBe(
      "Steps finished: 1 of 3.\n\n" +
      'Finished "Count the flour sacks left in the storeroom":\n42 sacks left.\n\n' +
      'Could not finish "Write the flour order for the mill" (The mill\'s order form rejected the quantity field.)\n' +
      'Stopped "Summarise this week\'s supplier invoices" before it finished',
    );
  });

  it("writes Turkish for a Turkish request", () => {
    const text = describeStoppedPlan([
      node(COUNT, "failed", "blocked", { blockedReason: "blocked", terminalKey: "task_stuck" }),
      node(ORDER, "skipped", "Skipped: dependency failed"),
    ], { ...PLAN, request: "Haftalık un siparişini ve tedarikçi fatura özetini hazırla." });

    expect(text).toBe(
      "Tamamlanan adımlar: 0/2.\n\n" +
      '"Count the flour sacks left in the storeroom" adımı tamamlanamadı (ilerleme kaydetmeden denemeyi sürdürdü)\n' +
      '"Write the flour order for the mill" adımı başlamadı (bağlı olduğu bir adım tamamlanmadı)',
    );
  });

  it("keeps a reason with content word for word, machine markers included", () => {
    // The campaign and the boot re-arm read these out of the block text.
    const text = describeStoppedPlan([
      node(COUNT, "failed", "blocked:provider_unavailable", { blockedReason: "blocked:provider_unavailable" }),
      node(ORDER, "failed", "blocked:ask_user", { blockedReason: "blocked:ask_user" }),
      node(INVOICES, "failed", "Required tool evidence missing: unity_playthrough\n\nWorker report: wrote two files"),
    ], PLAN);

    expect(text).toContain('Could not finish "Count the flour sacks left in the storeroom" (blocked:provider_unavailable)');
    expect(text).toContain('Could not finish "Write the flour order for the mill" (blocked:ask_user)');
    expect(text).toContain(
      'Could not finish "Summarise this week\'s supplier invoices" ' +
      "(Required tool evidence missing: unity_playthrough\n\nWorker report: wrote two files)",
    );
  });

  it("replaces only a bare status word, by the step's terminal key or by saying it gave none", () => {
    const text = describeStoppedPlan([
      node(COUNT, "failed", "Worker failed", { terminalKey: "max_steps_reached" }),
      node(ORDER, "failed", ""),
      node(INVOICES, "failed", "failed: the oven log was unreadable"),
    ], PLAN);

    expect(text).toContain("(it used every step it was allowed)");
    expect(text).toContain('"Write the flour order for the mill" (it gave no reason)');
    expect(text).toContain("(failed: the oven log was unreadable)");
  });

  it("names a step the plan does not know by its position, and cuts a long task", () => {
    const longTask = `Reconcile ${"every delivery note ".repeat(12)}against the ledger`;
    const text = describeStoppedPlan([
      node("goal_1700000000000_dddd4444", "failed", "boom"),
      node(COUNT, "failed", "boom"),
    ], { request: PLAN.request, nodes: [{ id: COUNT, task: longTask }] });

    expect(text).toContain("Could not finish step 1 (boom)");
    const named = /Could not finish "([^"]+)" \(boom\)/.exec(text);
    expect(named?.[1]).toHaveLength(120);
    expect(named?.[1]?.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/goal_/);
  });
});
