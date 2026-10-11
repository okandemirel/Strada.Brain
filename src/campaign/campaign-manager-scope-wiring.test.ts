/**
 * What the scope gate runs with (GDD-drift plan W00).
 *
 * The three dependencies are optional, so a manager built without them must
 * behave exactly as before: gate off, no writer, no runner. And a dependency
 * that WAS passed must be visible from outside, so the production wiring can
 * be tested instead of trusted (recovery learning once "ran for nobody": the
 * fix was right and the construction site never passed it).
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignManager, type CampaignManagerOptions } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { AcceptanceAuthorLike } from "./scope-types.js";
import type { TaskManager } from "../tasks/task-manager.js";

const managers: CampaignManager[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(extra: Partial<CampaignManagerOptions> = {}): CampaignManager {
  const dir = mkdtempSync(join(tmpdir(), "strada-scope-wiring-"));
  dirs.push(dir);
  const manager = new CampaignManager({
    storage: new CampaignStorage(join(dir, "campaigns.db")),
    planner: { planMilestones: vi.fn() } as unknown as CampaignPlanner,
    taskManager: new EventEmitter() as unknown as TaskManager,
    messenger: async () => {},
    projectRoot: dir,
    ...extra,
  });
  managers.push(manager);
  return manager;
}

describe("CampaignManager scope gate wiring", () => {
  it("is off, with no writer and no runner, when nothing is passed", () => {
    expect(build().scopeGateWiring()).toEqual({ mode: "off", writer: null, runner: false });
  });

  it("reports the mode, the writer and the runner it was given", () => {
    const author: AcceptanceAuthorLike = {
      describe: () => "writer-provider:writer-model (configured)",
      write: vi.fn(),
      regenerate: vi.fn(),
      repairCompile: vi.fn(),
      rebind: vi.fn(),
      revise: vi.fn(),
    };
    const wiring = build({
      scopeGateMode: "shadow",
      acceptanceAuthor: author,
      runAcceptanceSuite: async () => ({ receipt: "r" }),
    }).scopeGateWiring();
    expect(wiring).toEqual({ mode: "shadow", writer: "writer-provider:writer-model (configured)", runner: true });
  });

  it("an explicit null writer is no writer", () => {
    expect(build({ scopeGateMode: "on", acceptanceAuthor: null }).scopeGateWiring()).toEqual({
      mode: "on",
      writer: null,
      runner: false,
    });
  });
});
