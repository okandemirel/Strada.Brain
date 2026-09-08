/**
 * Measured 2026-09-08 04:42: three agent-written plan skills rode every turn
 * of every task at ~7.4k chars. A body goes in only when the task calls for it.
 */
import { describe, it, expect } from "vitest";
import { selectSkillKnowledge } from "./skill-knowledge-selection.js";

const skill = (name: string, body: string, extra: Record<string, unknown> = {}, status = "active") => ({
  manifest: { name, version: "1.0.0", description: name, ...extra },
  status: status as "active",
  body,
});

describe("selectSkillKnowledge", () => {
  it("withholds an active skill the prompt never names, and says which and how big", () => {
    const stale = skill("pixelflow-replan-playfieldbuilder", "## REPLAN: Resolve PlayfieldBuilder …".padEnd(3683, "x"));
    const { included, withheld } = selectSkillKnowledge([stale], "Draw the area backgrounds the GDD schedules.");
    expect(included).toEqual([]);
    expect(withheld).toEqual([{ name: "pixelflow-replan-playfieldbuilder", chars: 3683 }]);
  });

  it("includes a skill the prompt names, case-insensitively", () => {
    const plan = skill("ufo-set-piece-plan", "# UFO plan");
    expect(selectSkillKnowledge([plan], "Follow UFO-Set-Piece-Plan for the rocket.").included).toEqual([plan]);
  });

  it("includes a skill when one of its declared triggers appears in the prompt", () => {
    const plan = skill("verification-plan", "steps", { triggers: ["PlayMode verification", "conformance"] });
    expect(selectSkillKnowledge([plan], "Run the playmode verification suite.").included).toEqual([plan]);
    expect(selectSkillKnowledge([plan], "Draw sprites.").included).toEqual([]);
  });

  it("includes a skill that says inject: always regardless of the prompt", () => {
    const rules = skill("house-rules", "never patch the game", { inject: "always" });
    expect(selectSkillKnowledge([rules], "anything").included).toEqual([rules]);
  });

  it("ignores skills that are not active or have no body", () => {
    const gated = skill("gated", "body", {}, "gated");
    const empty = { manifest: { name: "empty", version: "1", description: "" }, status: "active" as const };
    const { included, withheld } = selectSkillKnowledge([gated, empty], "gated empty");
    expect(included).toEqual([]);
    expect(withheld).toEqual([]);
  });
});
