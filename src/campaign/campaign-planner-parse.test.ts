import { describe, expect, it, vi } from "vitest";

import { balancedJsonObjects, CampaignPlanner } from "./campaign-planner.js";

/**
 * Measured live 2026-09-12 00:42: the campaign failed at its very first step
 * with "campaign planner returned no JSON object" on a 1 458-line GDD — the
 * extractor took the first "{" in a reply that explained itself first, and the
 * retry sent the identical message to the same model.
 */
describe("reading a milestone ladder out of a reply", () => {
  it("finds the object however the model wrapped it", () => {
    expect(balancedJsonObjects('Here is the plan: {"a":1} — hope it helps.')).toEqual(['{"a":1}']);
    // Prose with braces of its own, then the answer: the LAST object is the one.
    expect(balancedJsonObjects('Use {curly} braces. {"milestones":[]}'))
      .toEqual(["{curly}", '{"milestones":[]}']);
    // A brace inside a string is not structure.
    expect(balancedJsonObjects('{"title":"a { b"}')).toEqual(['{"title":"a { b"}']);
    expect(balancedJsonObjects("no object here")).toEqual([]);
  });

  const ladder = {
    milestones: [
      {
        title: "Core loop",
        prompt: "Build the core gameplay loop the GDD specifies: playfield, rules and the win condition, verified in PlayMode.",
        coveredSections: ["3. CORE GAMEPLAY"],
        deliverables: ["playfield"],
      },
      {
        title: "Delivery",
        prompt: "Prove the whole game runs: suite green, project compiles, the player builds and plays to an outcome.",
        coveredSections: ["9. RELEASE"],
        deliverables: ["build"],
      },
    ],
  };

  function planner(replies: string[]): { planner: CampaignPlanner; asks: string[] } {
    const asks: string[] = [];
    let call = 0;
    const provider = {
      name: "test",
      capabilities: { maxTokens: 8192, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async (_system: string, messages: Array<{ content: string }>) => {
        asks.push(String(messages.at(-1)?.content ?? ""));
        return { text: replies[Math.min(call++, replies.length - 1)] ?? "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      }),
    };
    return { planner: new CampaignPlanner(provider as never), asks };
  }

  it("reads a ladder the model buried in prose", async () => {
    const { planner: p } = planner([`I'll plan this in two milestones. Note the {braces} in section 3.\n\n${JSON.stringify(ladder)}\n\nLet me know if you want changes.`]);

    const result = await p.planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    expect(result.milestones.map((m) => m.title)).toEqual(["Core loop", "Delivery"]);
  });

  it("the second ask says what was wrong with the first reply", async () => {
    const { planner: p, asks } = planner(["No JSON at all, just prose about the game.", JSON.stringify(ladder)]);

    const result = await p.planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    expect(result.milestones).toHaveLength(2);
    expect(asks).toHaveLength(2);
    expect(asks[0]).not.toContain("could not be used");
    expect(asks[1]).toContain("could not be used");
    expect(asks[1]).toContain("JSON object ALONE");
  });
});
