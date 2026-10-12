/**
 * The GDD a campaign task's runs are held to (review campaign-text-only P2):
 * the text the delivery gate judges, never a document discovered in docs/.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignManager } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { Campaign } from "./types.js";
import type { TaskManager } from "../tasks/task-manager.js";

const managers: CampaignManager[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(): { manager: CampaignManager; storage: CampaignStorage; root: string } {
  const root = mkdtempSync(join(tmpdir(), "strada-campaign-design-doc-"));
  dirs.push(root);
  const storage = new CampaignStorage(join(root, "campaigns.db"));
  const manager = new CampaignManager({
    storage,
    planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
    taskManager: new EventEmitter() as unknown as TaskManager,
    messenger: async () => {},
    projectRoot: root,
  });
  managers.push(manager);
  return { manager, storage, root };
}

function campaign(root: string, id: string, extra: Partial<Campaign>): Campaign {
  return {
    id,
    chatId: "chat-1",
    channelType: "cli",
    userId: "user-1",
    projectRoot: root,
    state: "executing",
    draftAttempts: 0,
    milestones: [],
    currentMilestone: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

describe("CampaignManager.designDocOf", () => {
  it("is the intake text for a campaign whose GDD never reached the project", () => {
    const { manager, storage, root } = build();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "Other_GDD.md"), "# Another game\n");
    storage.save(campaign(root, "cmp_text", { gddText: "# This game\n" }));

    expect(manager.designDocOf("cmp_text")).toEqual({ text: "# This game\n" });
  });

  it("is the document on disk for a campaign that has one", () => {
    const { manager, storage, root } = build();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "Game_GDD.md"), "# This game, as amended\n");
    storage.save(campaign(root, "cmp_path", { gddPath: "docs/Game_GDD.md", gddText: "# This game\n" }));

    // Named with its file, so a run's asks can say where the design is (review gdd-W10).
    expect(manager.designDocOf("cmp_path")).toEqual({ text: "# This game, as amended\n", path: "docs/Game_GDD.md" });
  });

  it("names no file when the file it names cannot be read and the intake text stands in", () => {
    const { manager, storage, root } = build();
    storage.save(campaign(root, "cmp_gone", { gddPath: "docs/Gone_GDD.md", gddText: "# This game\n" }));

    expect(manager.designDocOf("cmp_gone")).toEqual({ text: "# This game\n" });
  });

  it("holds no text for a campaign that carries none, or one it does not know", () => {
    const { manager, storage, root } = build();
    storage.save(campaign(root, "cmp_none", {}));

    expect(manager.designDocOf("cmp_none")).toEqual({});
    expect(manager.designDocOf("cmp_unknown")).toEqual({});
  });
});
