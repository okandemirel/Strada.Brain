import { describe, expect, it, vi } from "vitest";

import { balancedJsonObjects, CampaignPlanner, groupHeadingsIntoMilestones } from "./campaign-planner.js";

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

  it("a reply that is all THINKING says so, so the retry can forbid it", async () => {
    // Measured live 2026-09-12 00:52: the whole reply was an unterminated
    // <reasoning> block listing the GDD's headings — the model never reached
    // the JSON, and the retry asked the same question again.
    const { planner: p, asks } = planner([
      "<reasoning>\nLet me produce the JSON milestone ladder. Need 16-20 milestones. Let me list headings:\n1. INTRODUCTION",
      JSON.stringify(ladder),
    ]);

    const result = await p.planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    expect(result.milestones).toHaveLength(2);
    expect(asks[1]).toContain("thinking out loud");
    expect(asks[1]).toContain("<reasoning>");
  });

  it("asks for an output budget a ladder can fit in", async () => {
    const calls: Array<{ maxTokens?: number }> = [];
    const provider = {
      name: "test",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async (_s: string, _m: unknown, _t: unknown, opts?: { maxTokens?: number }) => {
        calls.push({ maxTokens: opts?.maxTokens });
        return { text: JSON.stringify(ladder), toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      }),
    };
    await new CampaignPlanner(provider as never)
      .planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    // Twenty milestones with their prompts do not fit a provider default.
    expect(calls[0]?.maxTokens ?? 0).toBeGreaterThanOrEqual(8000);
  });

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
    expect(asks[1]).toContain("FIRST character of your reply must be");
  });

  it("falls back to two short replies when the whole ladder never arrives (measured live 2026-09-12)", async () => {
    // Every single-reply attempt was spent enumerating the GDD's headings, so
    // the campaign failed at its first step. The titles alone, then one prompt
    // per milestone, is the same ladder in replies any model can finish.
    const asks: string[] = [];
    let call = 0;
    const provider = {
      name: "test",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async (_s: string, messages: Array<{ content: string }>) => {
        const ask = String(messages.at(-1)?.content ?? "");
        asks.push(ask);
        call += 1;
        // The two whole-ladder attempts never reach the JSON.
        if (call <= 2) return reply("<reasoning>\nLet me enumerate the headings first.");
        if (ask.includes("Group them into between")) {
          // The headings themselves are in the ask — grouping a given list is
          // a small answer, unlike "read this GDD and cover every section".
          expect(ask).toContain("3. CORE GAMEPLAY");
          expect(ask).toContain("9. RELEASE");
          return reply(JSON.stringify({ milestones: [
            { title: "Core loop", coveredSections: ["3. CORE GAMEPLAY"] },
            { title: "Delivery", coveredSections: ["9. RELEASE"] },
          ] }));
        }
        return reply("Build what this milestone covers in the project, verify it in PlayMode and leave the scene wired.");
      }),
    };
    const reply = (text: string) => ({ text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

    const result = await new CampaignPlanner(provider as never)
      .planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    expect(result.milestones.map((m) => m.title)).toEqual(["Core loop", "Delivery"]);
    expect(result.milestones[0]!.prompt.length).toBeGreaterThanOrEqual(40);
    expect(result.milestones[0]!.coveredSections).toEqual(["3. CORE GAMEPLAY"]);
    // EVERY staged sprint demands a captured frame, or the visual gate never
    // runs for it: the live 14-sprint ladder left four sprints ungated
    // (measured 2026-09-12 02:56).
    expect(result.milestones.every((m) => /captur/i.test(m.prompt))).toBe(true);
    // Two whole-ladder attempts, then titles, then one ask per milestone.
    expect(asks).toHaveLength(5);
  });

  it("a milestone whose instruction never arrived is dropped, not shipped empty", async () => {
    const reply = (text: string) => ({ text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    let call = 0;
    const provider = {
      name: "test",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async (_s: string, messages: Array<{ content: string }>) => {
        const ask = String(messages.at(-1)?.content ?? "");
        call += 1;
        if (call <= 2) return reply("<reasoning>\nthinking");
        if (ask.includes("Group them into between")) {
          return reply(JSON.stringify({ milestones: [
            { title: "One", coveredSections: [] },
            { title: "Two", coveredSections: [] },
            { title: "Three", coveredSections: [] },
          ] }));
        }
        // The middle milestone comes back with nothing usable.
        return reply(ask.includes('"Two"') ? "ok" : "Build what this milestone covers and verify it in PlayMode before reporting.");
      }),
    };

    const result = await new CampaignPlanner(provider as never)
      .planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    expect(result.milestones.map((m) => m.title)).toEqual(["One", "Three"]);
  });

  it("the ladder exists even when the model can group nothing — the GDD's own sections are it", async () => {
    // A model that returns no titles at all does not end the campaign: the
    // headings are already measured, and it is asked only for one sprint
    // instruction at a time (measured live 2026-09-12 01:10).
    const reply = (text: string) => ({ text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    const provider = {
      name: "test",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async (_s: string, messages: Array<{ content: string }>) => {
        const ask = String(messages.at(-1)?.content ?? "");
        if (ask.includes("step two")) {
          return reply("Build this section's systems in the project and verify them in PlayMode before reporting.");
        }
        return reply("<reasoning>\nI should enumerate every heading first…");
      }),
    };

    const result = await new CampaignPlanner(provider as never)
      .planMilestones("# GDD\n\n## 3. CORE GAMEPLAY\nRules.\n\n## 5. CONTENT\nLevels.\n\n## 9. RELEASE\nShip.\n", "docs/GDD.md");

    expect(result.milestones.length).toBeGreaterThanOrEqual(2);
    expect(result.milestones.every((m) => m.prompt.length >= 40)).toBe(true);
  });

  it("groups the GDD's headings into a ladder without asking anyone", () => {
    const scope = { headings: ["1. INTRO", "2. CORE", "3. CONTENT", "4. META", "5. RELEASE"], elements: 0, screens: 0, asks: {} as never, minMilestones: 2, maxMilestones: 4 };
    const grouped = groupHeadingsIntoMilestones(scope as never);

    expect(grouped.length).toBeGreaterThanOrEqual(2);
    expect(grouped.flatMap((g) => g.coveredSections)).toEqual(scope.headings);
    // The number is a table-of-contents row, not a milestone name.
    expect(grouped[0]!.title).not.toMatch(/^\d/);
    expect(groupHeadingsIntoMilestones({ ...scope, headings: [] } as never)).toEqual([]);
  });

  it("the capture demand survives a maximum-length instruction, and means visual proof (Codex 2026-09-12 P#15)", async () => {
    const reply = (text: string) => ({ text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    let call = 0;
    // An instruction at the schema's ceiling, and one that says "capture" about
    // something else entirely.
    const huge = `Build it. ${"x".repeat(9_000)}`;
    const provider = {
      name: "test",
      capabilities: { maxTokens: 4096, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true },
      chat: vi.fn(async (_s: string, messages: Array<{ content: string }>) => {
        const ask = String(messages.at(-1)?.content ?? "");
        call += 1;
        if (call <= 2) return reply("<reasoning>\nthinking");
        if (ask.includes("Group them into between")) {
          return reply(JSON.stringify({ milestones: [
            { title: "Huge", coveredSections: [] },
            { title: "Input", coveredSections: [] },
          ] }));
        }
        return reply(ask.includes('"Input"')
          ? "Implement input capture for the playfield so taps register on the board."
          : huge);
      }),
    };

    const result = await new CampaignPlanner(provider as never)
      .planMilestones("# GDD\n\n## 3. CORE\nRules.\n\n## 4. INPUT\nTaps.\n", "docs/GDD.md");

    for (const m of result.milestones) {
      expect(m.prompt.length).toBeLessThanOrEqual(8000);
      // Truncation used to cut the appended demand straight back off.
      expect(m.prompt).toContain("CAPTURING A FRAME");
    }
  });
});
