/**
 * THE DELIVERY GATE ACTUALLY ASKS. project-identity.ts measures and judges;
 * this is the test that it is wired into the gate at all — the recurring
 * failure here is a correct check nothing calls (measured 2026-10-14: the
 * proof run delivered a handheld project with Unity's DefaultCompany and no
 * application identifier, and no line of the gate had looked).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";
import type { Campaign } from "./types.js";

const dirs: string[] = [];
function project(settings: string): string {
  const root = mkdtempSync(join(tmpdir(), "identity-wiring-"));
  dirs.push(root);
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });
  mkdirSync(join(root, "Assets", "Scripts"), { recursive: true });
  writeFileSync(join(root, "Assets", "Scripts", "Beam.cs"), "public class Beam {}");
  writeFileSync(join(root, "ProjectSettings", "ProjectSettings.asset"), settings);
  return root;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const gate = (root: string, gddText: string): { refusal?: string; lines: string[] } => {
  const manager = Object.create(CampaignManager.prototype) as CampaignManager;
  (manager as unknown as { projectRoot: string }).projectRoot = root;
  const campaign = {
    id: "c_identity", chatId: "chat", channelType: "cli", userId: "u1", projectRoot: root, gddText,
    state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  } as unknown as Campaign;
  return (
    manager as unknown as { measureDeliveryStructure(c: Campaign): { refusal?: string; lines: string[] } }
  ).measureDeliveryStructure(campaign);
};

const HANDHELD_GDD = "# Harbor Light\n\nAn Android game, portrait only. The player taps a buoy.\n";

describe("the delivery gate reads the project's identity", () => {
  it("refuses a handheld delivery whose project has no identity", () => {
    const root = project(["PlayerSettings:", "  companyName: DefaultCompany", "  productName: Harbor Light", "  defaultScreenOrientation: 1", "  applicationIdentifier: {}"].join("\n"));

    const verdict = gate(root, HANDHELD_GDD);

    expect(verdict.refusal).toContain("handheld");
    expect(verdict.refusal).toContain("ProjectSettings/ProjectSettings.asset");
  });

  it("lets an identified project past, and says what it measured", () => {
    const root = project(
      [
        "PlayerSettings:",
        "  companyName: Harbor Works",
        "  productName: Harbor Light",
        "  defaultScreenOrientation: 1",
        "  applicationIdentifier:",
        "    Android: com.harborworks.harborlight",
      ].join("\n"),
    );

    const verdict = gate(root, HANDHELD_GDD);

    expect(verdict.refusal ?? "").not.toContain("handheld");
    expect(verdict.lines.join("\n")).toContain("com.harborworks.harborlight");
    expect(verdict.lines.join("\n")).toContain("Orientation: portrait");
  });

  it("adds no line at all when the project has no settings file to read", () => {
    // An empty structural findings list means "nothing was measured" to the
    // report and to the planner's gap context; a line saying only that this
    // tree has no ProjectSettings would make an unmeasured delivery look
    // measured (measured 2026-10-14: it lengthened a live bounce loop).
    const root = mkdtempSync(join(tmpdir(), "identity-wiring-"));
    dirs.push(root);
    mkdirSync(join(root, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(root, "Assets", "Scripts", "Beam.cs"), "public class Beam {}");

    const verdict = gate(root, HANDHELD_GDD);

    expect(verdict.refusal ?? "").not.toContain("handheld");
    expect(verdict.lines.join("\n")).not.toContain("app identity");
  });
});
