import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignStorage } from "./campaign-storage.js";
import type { Campaign } from "./types.js";

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  const now = Date.now();
  return {
    id: "campaign_test_1",
    chatId: "cli-local",
    channelType: "cli",
    userId: "u1",
    projectRoot: "/tmp/project",
    state: "executing",
    draftAttempts: 0,
    milestones: [
      { id: "m1", title: "Sprint A", prompt: "build foundations", status: "running", attempts: 1, taskId: "task_1" },
      { id: "m2", title: "Sprint B", prompt: "build mechanics", status: "pending", attempts: 0 },
    ],
    currentMilestone: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("CampaignStorage", () => {
  let dir: string;
  let storage: CampaignStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "campaign-storage-"));
    storage = new CampaignStorage(join(dir, "campaigns.db"));
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a campaign with its milestone ladder", () => {
    const campaign = makeCampaign();
    storage.save(campaign);

    const loaded = storage.get(campaign.id);
    expect(loaded).toBeDefined();
    expect(loaded!.state).toBe("executing");
    expect(loaded!.milestones).toHaveLength(2);
    expect(loaded!.milestones[0]!.taskId).toBe("task_1");
    expect(loaded!.chatId).toBe("cli-local");
  });

  it("updates state on re-save (upsert)", () => {
    const campaign = makeCampaign();
    storage.save(campaign);
    campaign.state = "awaiting-approval";
    campaign.gddPath = "docs/Game_GDD.md";
    storage.save(campaign);

    const loaded = storage.get(campaign.id);
    expect(loaded!.state).toBe("awaiting-approval");
    expect(loaded!.gddPath).toBe("docs/Game_GDD.md");
  });

  it("listActive returns only non-terminal campaigns", () => {
    storage.save(makeCampaign({ id: "c_active", state: "executing" }));
    storage.save(makeCampaign({ id: "c_waiting", state: "awaiting-approval" }));
    storage.save(makeCampaign({ id: "c_done", state: "done" }));
    storage.save(makeCampaign({ id: "c_failed", state: "failed" }));

    const active = storage.listActive().map((c) => c.id);
    expect(active).toContain("c_active");
    expect(active).toContain("c_waiting");
    expect(active).not.toContain("c_done");
    expect(active).not.toContain("c_failed");
  });

  it("findAwaitingApproval scopes to the conversation", () => {
    storage.save(makeCampaign({ id: "c1", chatId: "chat-a", state: "awaiting-approval" }));
    storage.save(makeCampaign({ id: "c2", chatId: "chat-b", state: "awaiting-approval" }));

    expect(storage.findAwaitingApproval("chat-a")!.id).toBe("c1");
    expect(storage.findAwaitingApproval("chat-b")!.id).toBe("c2");
    expect(storage.findAwaitingApproval("chat-c")).toBeUndefined();
  });

  it("survives a corrupt milestones column instead of crashing boot resume", () => {
    storage.save(makeCampaign({ id: "c_corrupt" }));
    const db = (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("UPDATE campaigns SET milestones_json = ? WHERE id = ?").run("{not json", "c_corrupt");

    const loaded = storage.get("c_corrupt");
    expect(loaded).toBeDefined();
    expect(loaded!.milestones).toEqual([]);
  });
});
