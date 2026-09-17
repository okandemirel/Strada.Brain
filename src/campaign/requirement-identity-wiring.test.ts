/**
 * Plan 6.2, the wiring: the identity only earns its keep if the LIVE campaign
 * path uses it. Until this landed, `requirement-identity.ts` was exercised by
 * its own tests and the eval only — a campaign still keyed requirements by
 * wording, so a reworded requirement lost the history of what was proven, and
 * the machine-readable tail could have reached a worker's prompt as prose.
 */
import { describe, expect, it } from "vitest";
import { requirementKey, CampaignManager } from "./campaign-manager.js";
import { contentFingerprint, encodeRequirement, identifyRequirements, requirementText } from "./requirement-identity.js";
import type { Campaign, CampaignMilestone } from "./types.js";

const GDD = { sha256: "a".repeat(64), revision: 3 };

function encodedFor(texts: readonly string[]): string[] {
  return identifyRequirements({ texts, gdd: GDD }).encoded;
}

/** The private sprint builder, which is what the coverage path calls. */
function gapSprint(item: string): CampaignMilestone {
  const manager = Object.create(CampaignManager.prototype) as unknown as {
    gapSprint: (c: Campaign, round: number, index: number, item: string) => CampaignMilestone;
  };
  const campaign = { gddPath: "docs/GDD.md" } as Campaign;
  return manager.gapSprint(campaign, 2, 0, item);
}

describe("a requirement's identity reaches the campaign", () => {
  it("keys scheduling and the repair budget on the id, not the wording", () => {
    const [first] = encodedFor(["The player can save and load progress"]);
    // A cosmetic rewording of the same requirement, carrying the same lineage.
    const reworded = identifyRequirements({
      previous: identifyRequirements({ texts: ["The player can save and load progress"], gdd: GDD }).result.identities,
      texts: ["the player can save and load progress."],
      gdd: { sha256: "b".repeat(64), revision: 4 },
    }).encoded[0]!;
    expect(requirementKey(first!)).toBe(requirementKey(reworded));
    // A DIFFERENT requirement is a different key, however similar it reads.
    const [other] = encodedFor(["The player can save and load settings"]);
    expect(requirementKey(other!)).not.toBe(requirementKey(first!));
    // And a requirement stored before identities existed still keys by wording,
    // so a campaign mid-flight does not re-open every gap it holds.
    expect(requirementKey("Plain old requirement, attempt 1")).toBe(requirementKey("Plain old requirement, attempt 2"));
  });

  it("never shows the id to a worker or a person", () => {
    const [encoded] = encodedFor(["The player can win a session"]);
    expect(encoded).toContain("rid:");
    const sprint = gapSprint(encoded!);
    // Persisted WITH the identity…
    expect(sprint.coverageGap).toBe(encoded);
    // …and read WITHOUT it, in both the title and the prompt the worker gets.
    expect(sprint.title).not.toContain("rid:");
    expect(sprint.prompt).not.toContain("rid:");
    expect(sprint.prompt).toContain(requirementText(encoded!));
  });

  it("a legacy plain requirement is shown and stored exactly as it was", () => {
    const sprint = gapSprint("A plain requirement nobody stamped");
    expect(sprint.coverageGap).toBe("A plain requirement nobody stamped");
    expect(sprint.title).toContain("A plain requirement nobody stamped");
    expect(sprint.prompt).toContain("A plain requirement nobody stamped");
  });

  it("keys on the lineage AND this wording's content, deterministically (guard)", () => {
    // The lineage is HISTORY; what is scheduled and closed is the requirement
    // as it is worded now, so the key carries both. Keying on the lineage alone
    // merged a reopened requirement into its closed predecessor (Codex
    // 2026-09-18 round 13 #28).
    const identity = { id: "req-1-abcdef", lineage: "req-1-abcdef", text: "Hand-built identity" };
    const encoded = encodeRequirement(identity);
    expect(requirementKey(encoded)).toBe(`req:req-1-abcdef#${contentFingerprint("Hand-built identity")}`);
    // A later wording of the same requirement that changed the ask keys apart…
    const changed = encodeRequirement({ ...identity, id: "req-2-fedcba", text: "Hand-built identity, twice" });
    expect(requirementKey(changed)).not.toBe(requirementKey(encoded));
    // …and a cosmetic one does not.
    const cosmetic = encodeRequirement({ ...identity, id: "req-2-fedcba", text: "**hand-built identity.**" });
    expect(requirementKey(cosmetic)).toBe(requirementKey(encoded));
  });
});
