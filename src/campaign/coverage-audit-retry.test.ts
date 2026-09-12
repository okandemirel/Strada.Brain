import { describe, expect, it, vi } from "vitest";
import { CampaignPlanner } from "./campaign-planner.js";

/**
 * Measured live 2026-09-03 08:33: one malformed reply skipped the GDD
 * coverage check for the whole delivery ("delivered WITHOUT a clean
 * GDD-coverage check"). The shape is worth one retry; the judgement is not.
 */
describe("coverage audit malformed JSON", () => {
  function plannerWith(replies: string[]) {
    const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
    // No chatStream → streamOrChatText falls to chat().
    const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
    return { planner: new CampaignPlanner(provider), chat };
  }

  it("asks once more when the first reply is not usable JSON", async () => {
    const { planner, chat } = plannerWith([
      "Sure! Here is what I found: the ladder covers everything.",
      '{"missing": ["Dragon boss: no milestone implemented it"]}',
    ]);

    const missing = await planner.auditCoverage("# GDD", [{ title: "Sprint A" }]);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat.mock.calls[1])).toContain("not valid JSON");
    expect(missing).toEqual(["Dragon boss: no milestone implemented it"]);
  });

  it("shows the audit what each sprint MEASURED, not its title (Codex 2026-09-12 R#15)", async () => {
    // "Only report an item as missing when no milestone's scope or result
    // plausibly includes it" — with a title and 300 characters of prose as the
    // whole input. A plan that mentioned an item read as coverage of it.
    const { planner, chat } = plannerWith(['{"missing": []}']);

    await planner.auditCoverage("# GDD\n\nThe game ships a dragon boss.", [
      {
        title: "Sprint A — Bosses",
        status: "green",
        testVerdict: "PlayMode verification passed: 42 of 42 tests passed",
        testVerdictUnfiltered: true,
        commitNote: "3 commit(s): Assets/Scripts/Dragon.cs, Assets/Prefabs/Dragon.prefab",
        structureFindings: ["the shipped scenes bind 12 of 14 elements"],
        gddClaims: ["level count = 12 measured 12"],
        resultExcerpt: "the dragon is implemented",
      },
      { title: "Sprint B — Nothing measured yet" },
    ]);

    const sent = JSON.stringify(chat.mock.calls[0]);
    expect(sent).toContain("status: green");
    expect(sent).toContain("suite: PlayMode verification passed");
    expect(sent).toContain("(unfiltered)");
    expect(sent).toContain("landed: 3 commit(s)");
    expect(sent).toContain("shipped tree: the shipped scenes bind 12 of 14");
    expect(sent).toContain("document numbers: level count = 12");
    // A sprint with nothing measured says so, instead of passing as covered.
    expect(sent).toContain("(no evidence recorded)");
    // …and the instruction is evidence, not plausibility.
    expect(sent).toContain("TITLE or PLAN is not coverage");
    expect(sent).not.toContain("plausibly includes it");
  });

  it("gives up after the second malformed reply", async () => {
    const { planner, chat } = plannerWith(["not json", "still not json"]);
    await expect(planner.auditCoverage("# GDD", [{ title: "Sprint A" }])).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("reads the verdict past a leaked reasoning block on the first try", async () => {
    // Measured 2026-09-07: the audit extracted `{…}` from inside
    // "<reasoning>…</reasoning>" and delivered "WITHOUT a clean GDD-coverage
    // check" because of it.
    const { planner, chat } = plannerWith([
      '<reasoning>\nLet me weigh {"missing": "everything?"} first.\n</reasoning>\n{"missing":["Pig skins: no milestone made them"]}',
    ]);
    await expect(planner.auditCoverage("# GDD", [], "final report")).resolves.toEqual([
      "Pig skins: no milestone made them",
    ]);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
