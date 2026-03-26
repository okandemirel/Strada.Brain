import { describe, expect, it } from "vitest";
import { buildGoalNarrativeFeedback, formatGoalPlanMarkdown } from "./goal-feedback.js";
import { buildGoalTreeFromBlock } from "./types.js";

function makeTree(taskDescription = "Projede neyin bozuk olduğunu bul ve düzelt") {
  return buildGoalTreeFromBlock({
    isGoal: true,
    estimatedMinutes: 15,
    nodes: [
      { id: "a", task: "Projeyi tara ve hataları topla", dependsOn: [] },
      { id: "b", task: "İlgili dosyalarda düzeltmeleri uygula", dependsOn: ["a"] },
      { id: "c", task: "Sonucu doğrula", dependsOn: ["b"] },
    ],
  }, "session-1", taskDescription);
}

describe("goal-feedback", () => {
  it("builds a Turkish execution narrative for Turkish prompts", () => {
    const feedback = buildGoalNarrativeFeedback(makeTree());

    expect(feedback.language).toBe("tr");
    expect(feedback.narrative).toContain("Aşama: plan yürütme");
    expect(feedback.narrative).toContain("Durum: 0/3 adım tamamlandı");
    expect(feedback.milestone).toEqual({ current: 0, total: 3, label: "adım" });
  });

  it("formats a chat-friendly markdown plan without raw ASCII tree artifacts", () => {
    const markdown = formatGoalPlanMarkdown(makeTree());

    expect(markdown).toContain("**Çalışma Planı**");
    expect(markdown).toContain("Sıradaki adımlar:");
    expect(markdown).not.toContain("+--");
    expect(markdown).not.toContain("\\--");
    expect(markdown).not.toContain("[ ]");
  });

  it("falls back to English when the prompt is not Turkish", () => {
    const tree = makeTree("Find the failing workflow and repair it");
    const feedback = buildGoalNarrativeFeedback(tree, "Find the failing workflow and repair it");

    expect(feedback.language).toBe("en");
    expect(feedback.narrative).toContain("Stage: plan execution");
    expect(feedback.narrative).toContain("Status: 0/3 steps complete");
    expect(feedback.milestone.label).toBe("steps");
  });
});
