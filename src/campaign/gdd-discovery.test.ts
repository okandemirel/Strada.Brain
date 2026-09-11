import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignManager } from "./campaign-manager.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import type { TaskManager } from "../tasks/task-manager.js";

/**
 * Measured live 2026-09-12 00:21: "build the game in the GDD" started a
 * campaign from docs/PixelFlow_GDD_Traceability_Checklist.md — a document the
 * system itself had written ABOUT the design — because the picker took the
 * newest file whose name contains "gdd". The whole ladder would have been
 * planned from a checklist instead of the game's design.
 */
describe("which document is THE GDD", () => {
  let dir: string;
  let projectRoot: string;
  let storage: CampaignStorage;

  const manager = (): CampaignManager =>
    new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue([]), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: { on: vi.fn(), submit: vi.fn().mockReturnValue({ id: "task_1" }) } as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gdd-pick-"));
    projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    storage = new CampaignStorage(join(dir, "campaigns.db"));
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string, ageMinutes: number): void => {
    const path = join(projectRoot, "docs", name);
    writeFileSync(path, body);
    const when = new Date(Date.now() - ageMinutes * 60_000);
    utimesSync(path, when, when);
  };

  it("takes the design document, not the newest report about it", () => {
    write("PixelFlow_GDD.md", "# GDD\n\n".padEnd(40_000, "design prose\n"), 600);
    write("PixelFlow_GDD_Traceability_Checklist.md", "# Checklist\n\n- [ ] R-01\n", 1);
    write("PixelFlow_GDD_Audit_2026-09-02.md", "# Audit\n\nFindings.\n", 2);
    write("PixelFlow_GDD_Analysis.md", "# Analysis\n\nNotes.\n", 3);

    const found = (manager() as unknown as { findNewestGddPath(): string | undefined }).findNewestGddPath();

    expect(found).toBe("docs/PixelFlow_GDD.md");
  });

  it("prefers a newer design document over an older one", () => {
    write("Old_GDD.md", "# Old\n\n".padEnd(20_000, "x\n"), 5_000);
    write("New_GDD.md", "# New\n\n".padEnd(20_000, "y\n"), 10);

    expect((manager() as unknown as { findNewestGddPath(): string | undefined }).findNewestGddPath())
      .toBe("docs/New_GDD.md");
  });

  it("falls back to a derivative when that is all there is", () => {
    write("PixelFlow_GDD_Audit.md", "# Audit\n\nFindings.\n", 4);

    expect((manager() as unknown as { findNewestGddPath(): string | undefined }).findNewestGddPath())
      .toBe("docs/PixelFlow_GDD_Audit.md");
  });
});
