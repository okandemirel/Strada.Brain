/**
 * The identity a learning run carries. Measured 2026-10-14: 10 instincts
 * learned in a live campaign, not one of them recording which run or campaign
 * learned it.
 */
import { describe, expect, it } from "vitest";
import { CAMPAIGN_TAG_PREFIX, provenanceTags, runProvenance, withRunProvenance } from "./run-provenance.js";

describe("run provenance", () => {
  it("is nothing outside a run", () => {
    expect(runProvenance()).toBeNull();
    expect(provenanceTags(["chain"])).toEqual(["chain"]);
  });

  it("holds for the work a run starts, including after an await", async () => {
    await withRunProvenance({ runId: "task_1", campaignId: "campaign_9" }, async () => {
      expect(runProvenance()?.runId).toBe("task_1");
      await Promise.resolve();
      expect(runProvenance()?.campaignId).toBe("campaign_9");
    });
    expect(runProvenance()).toBeNull();
  });

  it("does not let a nested run inherit the identity of the task that started it", () => {
    withRunProvenance({ runId: "task_1", campaignId: "campaign_9" }, () => {
      withRunProvenance(null, () => {
        expect(runProvenance()).toBeNull();
        expect(provenanceTags([])).toEqual([]);
      });
      expect(runProvenance()?.runId).toBe("task_1");
    });
  });

  it("tags the campaign, once, and never the run id", () => {
    withRunProvenance({ runId: "task_1", campaignId: "campaign_9" }, () => {
      expect(provenanceTags(["chain"])).toEqual(["chain", `${CAMPAIGN_TAG_PREFIX}campaign_9`]);
      expect(provenanceTags([`${CAMPAIGN_TAG_PREFIX}campaign_9`])).toEqual([`${CAMPAIGN_TAG_PREFIX}campaign_9`]);
      expect(provenanceTags([]).some((t) => t.includes("task_1"))).toBe(false);
    });
  });

  it("adds no tag for a run that serves no campaign", () => {
    withRunProvenance({ runId: "task_1" }, () => {
      expect(provenanceTags(["chain"])).toEqual(["chain"]);
    });
    withRunProvenance({ runId: "task_1", campaignId: "" }, () => {
      expect(provenanceTags([])).toEqual([]);
    });
  });
});
