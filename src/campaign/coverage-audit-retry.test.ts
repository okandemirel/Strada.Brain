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

  it("gives up after the second malformed reply", async () => {
    const { planner, chat } = plannerWith(["not json", "still not json"]);
    await expect(planner.auditCoverage("# GDD", [{ title: "Sprint A" }])).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
