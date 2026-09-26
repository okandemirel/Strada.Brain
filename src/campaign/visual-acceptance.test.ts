/**
 * VISUAL ACCEPTANCE (plan 6.12).
 *
 * "done" used to imply the delivery also LOOKS right. The look check wrote a
 * paragraph when it ran and NOTHING when it could not, so a delivery nobody
 * had ever looked at rendered identically to one that passed.
 *
 * Both directions are pinned here:
 *   - an unmeasured look is stated as NOT MEASURED, never omitted;
 *   - a measured MISMATCH stays a refusal and is never softened into
 *     "not measured" (the failure mode a stricter reading invites).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryVisualBlock,
  describeVisualAcceptance,
  judgeVisualConformance,
  renderVisualAcceptance,
  visualAcceptance,
  visualAcceptanceCaveat,
  visualAcceptanceNotRun,
  type FrameSelection,
  type VisualConformance,
} from "./visual-conformance.js";
import { buildCampaignStatus } from "./campaign-status.js";
import { CampaignManager } from "./campaign-manager.js";
import type { Campaign } from "./types.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const FRAME: FrameSelection = { path: "/proj/Recordings/f.png", capturedAtMs: 10 };

function checked(matches: boolean | undefined, detail = "the frame shows a flat grid"): VisualConformance {
  return {
    status: "checked",
    detail,
    ...(matches === undefined ? {} : { matches }),
    framePath: FRAME.path,
    provider: "anthropic",
  };
}

describe("the verdict", () => {
  it("a look the model accepted is ACCEPTED, with the frame and provider it was judged from", () => {
    const a = visualAcceptance(checked(true, "pixel-art canvases, as described"), FRAME);
    expect(a.status).toBe("accepted");
    expect(a.framePath).toBe(FRAME.path);
    expect(a.provider).toBe("anthropic");
    expect(a.unresolved).toBeUndefined();
  });

  it("a MISMATCH is REFUSED — never downgraded to 'not measured' (the mismatch IS the measurement)", () => {
    const a = visualAcceptance(checked(false), FRAME, { bounces: 1 });
    expect(a.status).toBe("refused");
    expect(a.reason).toBeUndefined();
    expect(a.detail).toContain("flat grid");
    expect(describeVisualAcceptance(a)).toContain("REFUSED");
    expect(describeVisualAcceptance(a)).not.toContain("NOT MEASURED");
  });

  it("a refusal that outlived its bounce is marked unresolved, and the report says the refusal STANDS", () => {
    const a = visualAcceptance(checked(false), FRAME, { unresolved: true, bounces: 1 });
    expect(a).toMatchObject({ status: "refused", unresolved: true, bounces: 1 });
    const block = renderVisualAcceptance(a);
    expect(block).toContain("NO MATCH");
    expect(block).toContain("refusal STANDS");
    expect(block).not.toContain("✅");
  });

  it("no vision provider is NOT MEASURED with a machine-readable reason, never a pass", async () => {
    const result = await judgeVisualConformance({
      look: { found: true, text: "Hand-painted watercolour." },
      frame: FRAME,
      visionProvider: null,
    });
    expect(result.reason).toBe("no-vision-provider");
    const a = visualAcceptance(result, FRAME);
    expect(a.status).toBe("not-measured");
    expect(a.reason).toBe("no-vision-provider");
    const block = renderVisualAcceptance(a);
    expect(block).toContain("NOT MEASURED");
    expect(block).not.toContain("✅");
  });

  it("an answer with no MATCH line is not a verdict, and the model's sentence is kept verbatim", () => {
    const a = visualAcceptance(checked(undefined, "it is hard to say from this angle"), FRAME);
    expect(a.status).toBe("not-measured");
    expect(a.reason).toBe("no-verdict-line");
    expect(a.detail).toContain("it is hard to say from this angle");
  });

  it("the truncated frame walk is disclosed on the verdict", () => {
    const a = visualAcceptance(checked(true), { ...FRAME, truncated: true });
    expect(a.frameScanTruncated).toBe(true);
    expect(renderVisualAcceptance(a)).toContain("may not be the newest");
  });

  it("a mismatch the vision provider ACTUALLY reported survives the whole path (reason tokens do not swallow it)", async () => {
    const provider = {
      chat: async () => ({ text: "The frame shows grey boxes, not the painted village.\nMATCH: no" }),
    } as unknown as IAIProvider;
    const result = await judgeVisualConformance({
      look: { found: true, text: "A painted village." },
      frame: { path: "package.json", capturedAtMs: 1 },
      visionProvider: { provider, name: "test" },
    });
    expect(result.status).toBe("checked");
    const a = visualAcceptance(result, FRAME);
    expect(a.status).toBe("refused");
    expect(a.detail).toContain("grey boxes");
  });
});

describe("the caveat", () => {
  it("an accepted look adds nothing; every other state names itself", () => {
    expect(visualAcceptanceCaveat(visualAcceptance(checked(true), FRAME))).toBeUndefined();
    expect(visualAcceptanceCaveat(undefined)).toContain("NEVER judged");
    expect(visualAcceptanceCaveat(visualAcceptanceNotRun("no frame was captured", "no-frame"))).toContain("NOT measured");
    expect(visualAcceptanceCaveat(visualAcceptance(checked(false), FRAME, { unresolved: true }))).toContain("REFUSED");
  });

  it("a refusal the sprint was sent back to fix is not a delivery caveat yet", () => {
    expect(visualAcceptanceCaveat(visualAcceptance(checked(false), FRAME))).toBeUndefined();
  });
});

describe("the delivery report block", () => {
  it("says NOT MEASURED when no milestone ever judged the look", () => {
    const block = deliveryVisualBlock([{ title: "m1" } as never, {}]);
    expect(block).toContain("Does it look like the GDD?");
    expect(block).toContain("VISUAL ACCEPTANCE NOT MEASURED");
    expect(block).not.toContain("✅");
  });

  it("renders the NEWEST verdict, not the first one", () => {
    const block = deliveryVisualBlock([
      { visualVerdict: visualAcceptance(checked(false, "old mismatch"), FRAME, { unresolved: true }) },
      { visualVerdict: visualAcceptance(checked(true, "the painted village, as described"), FRAME) },
    ]);
    expect(block).toContain("painted village");
    expect(block).not.toContain("old mismatch");
  });

  it("a row written before the verdict existed keeps its disclosure and says the verdict was not recorded", () => {
    const block = deliveryVisualBlock([{ visualConformance: "**Does it look like the GDD?**\n- something old" }]);
    expect(block).toContain("something old");
    expect(block).toContain("predates the visual-acceptance verdict");
  });
});

describe("the status snapshot", () => {
  function campaign(milestoneExtras: Record<string, unknown>): Campaign {
    return {
      id: "c1",
      chatId: "chat",
      channelType: "telegram",
      userId: "u",
      projectRoot: "/proj",
      state: "executing",
      draftAttempts: 0,
      currentMilestone: 0,
      createdAt: 1,
      updatedAt: 2,
      milestones: [{ id: "m1", title: "Ship", prompt: "p", status: "green", attempts: 1, ...milestoneExtras }],
    } as unknown as Campaign;
  }
  const opts = {
    maxMilestoneAttempts: 3,
    milestoneTimeBoxMs: 1000,
    getTask: () => null,
    listTasks: () => [],
  };

  it("carries the visual verdict for every milestone — 'not measured' included", () => {
    const silent = buildCampaignStatus(campaign({}), opts);
    expect(silent.milestones[0]!.visualAcceptance).toContain("NOT MEASURED");
    const refused = buildCampaignStatus(
      campaign({ visualVerdict: visualAcceptance(checked(false), FRAME, { unresolved: true }) }),
      opts,
    );
    expect(refused.milestones[0]!.visualAcceptance).toContain("REFUSED");
    expect(refused.milestones[0]!.visualAcceptance).toContain("refusal standing");
  });
});

describe("the delivery report the user reads", () => {
  function reportFor(milestones: Array<Record<string, unknown>>): string {
    const root = mkdtempSync(join(tmpdir(), "va-proj-"));
    dirs.push(root);
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = root;
    const campaign = {
      id: "c1",
      chatId: "chat",
      channelType: "telegram",
      userId: "u",
      projectRoot: root,
      state: "done",
      draftAttempts: 0,
      currentMilestone: milestones.length - 1,
      createdAt: 1,
      updatedAt: 2,
      milestones: milestones.map((m, i) => ({
        id: `m${i}`,
        title: `Sprint ${i}`,
        prompt: "p",
        status: "green",
        attempts: 1,
        ...m,
      })),
    } as unknown as Campaign;
    const internals = manager as unknown as { buildDeliveryReport(c: Campaign): string; closeProjectStores(): void };
    try {
      return internals.buildDeliveryReport(campaign);
    } finally {
      // The report opens the project's evidence and package databases; an
      // open one cannot be deleted on Windows (EBUSY in afterEach).
      internals.closeProjectStores();
    }
  }

  it("a delivery nobody looked at SAYS SO — silence used to read as a pass (6.12)", () => {
    const report = reportFor([{}]);
    expect(report).toContain("Does it look like the GDD?");
    expect(report).toContain("VISUAL ACCEPTANCE NOT MEASURED");
    expect(report).toContain("NEVER judged against the GDD");
  });

  it("a REFUSED look that outlived its bounce is delivered with the refusal in the report, not as 'not measured'", () => {
    const report = reportFor([
      { visualVerdict: visualAcceptance(checked(false, "grey boxes, not the painted village"), FRAME, { unresolved: true, bounces: 1 }) },
    ]);
    expect(report).toContain("NO MATCH");
    expect(report).toContain("grey boxes");
    expect(report).toContain("refusal STANDS");
    expect(report).toContain("REFUSED it");
    expect(report).not.toContain("VISUAL ACCEPTANCE NOT MEASURED");
  });

  it("an accepted look neither hides nor caveats itself", () => {
    const report = reportFor([{ visualVerdict: visualAcceptance(checked(true, "pixel-art canvases, as described"), FRAME) }]);
    expect(report).toContain("VISUAL ACCEPTANCE: MATCH");
    expect(report).not.toContain("NOT MEASURED");
    expect(report).not.toContain("REFUSED");
  });
});
