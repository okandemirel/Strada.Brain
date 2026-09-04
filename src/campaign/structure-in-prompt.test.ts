import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";

/**
 * Measured live 2026-09-04 10:32. The structural refusal — "the shipped
 * scenes render NOTHING … 100 prefabs, 62 models and 198 sprites that no
 * enabled scene reaches" — was computed only inside the delivery-gate bounce.
 * The persisted final-sprint prompt held none of it, so every sprint
 * resubmitted by an outage, a self-revival or a restart ran blind, and each
 * one answered with a document.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function put(root: string, rel: string, body: string, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

/** A tree shaped like the delivered PixelFlow: an empty entry scene, art nothing reaches. */
function emptyGameProject(): string {
  const root = mkdtempSync(join(tmpdir(), "structprompt-"));
  dirs.push(root);
  put(
    root,
    "ProjectSettings/EditorBuildSettings.asset",
    "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n",
  );
  put(
    root,
    "Assets/Scenes/Main.unity",
    "%YAML 1.1\n--- !u!1 &100\nGameObject:\n  m_Name: MainCamera\n" +
      "--- !u!20 &900\nCamera:\n  orthographic: 0\n",
    "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
  );
  put(
    root,
    "Assets/Prefabs/Pig.prefab",
    "%YAML 1.1\n--- !u!1 &7\nGameObject:\n  m_Name: Pig\n" +
      "--- !u!212 &8\nSpriteRenderer:\n  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n",
    "11111111111111111111111111111111",
  );
  put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
  return root;
}

function attach(root: string, prompt: string): string {
  const manager = Object.create(CampaignManager.prototype) as CampaignManager;
  (manager as unknown as { projectRoot: string }).projectRoot = root;
  const milestone = { prompt } as { prompt: string };
  (manager as unknown as {
    attachStructureMeasurement(c: unknown, m: unknown): void;
  }).attachStructureMeasurement({ id: "c1", gddText: "" }, milestone);
  return milestone.prompt;
}

describe("the final sprint is told what the tree renders, on every submit", () => {
  it("puts the measured refusal into the prompt", () => {
    const prompt = attach(emptyGameProject(), "Sprint 7 — deliver the game.");
    expect(prompt).toContain("Sprint 7 — deliver the game.");
    expect(prompt).toContain("REFUSED:");
    expect(prompt).toContain("render NOTHING");
    // The art it must bind, named — a count alone is not a starting point.
    expect(prompt).toContain("Assets/Prefabs/Pig.prefab");
    // And the entry scene's own emptiness, from the same measurement.
    expect(prompt).toContain("1 GameObject");
  });

  it("replaces the previous block instead of stacking a stale one", () => {
    const root = emptyGameProject();
    let prompt = attach(root, "Sprint 7.");
    prompt = attach(root, prompt);
    prompt = attach(root, prompt);
    const opens = prompt.split("<<MEASURED NOW").length - 1;
    expect(opens).toBe(1);
  });

  it("keeps a tail appended after the block, and re-measures around it", () => {
    const root = emptyGameProject();
    const first = attach(root, "Sprint 7.");
    const withTail = `${first}\n\nThe previous attempt ended blocked: provider outage.`;
    const second = attach(root, withTail);
    expect(second).toContain("The previous attempt ended blocked: provider outage.");
    expect(second.split("<<MEASURED NOW").length - 1).toBe(1);
  });

  it("says it trimmed a long measurement instead of capping it silently", () => {
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = emptyGameProject();
    // A measurement longer than the prompt budget: the sprint must not read a
    // truncated list as the whole truth.
    (manager as unknown as { measureDeliveryStructure(): unknown }).measureDeliveryStructure = () => ({
      refusal: "the scenes render NOTHING",
      lines: [`unbound: ${"Assets/Prefabs/VeryLongPrefabName.prefab, ".repeat(200)}`],
    });
    const milestone = { prompt: "Sprint 7." } as { prompt: string };
    (manager as unknown as {
      attachStructureMeasurement(c: unknown, m: unknown): void;
    }).attachStructureMeasurement({ id: "c1", gddText: "" }, milestone);
    expect(milestone.prompt).toContain("measurement trimmed here");
    // On a line boundary, not mid-word: the first live render ended
    // "- Camera projection in the shi", which reads as corrupted, not trimmed.
    const kept = milestone.prompt.split("\n- (measurement trimmed here")[0]!;
    expect(kept.endsWith("shi")).toBe(false);
  });

  it("keeps whole lines when it trims a multi-line measurement", () => {
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = emptyGameProject();
    const line = (n: number): string => `line ${n}: ${"x".repeat(300)}`;
    (manager as unknown as { measureDeliveryStructure(): unknown }).measureDeliveryStructure = () => ({
      refusal: "the scenes render NOTHING",
      lines: Array.from({ length: 20 }, (_, i) => line(i)),
    });
    const milestone = { prompt: "Sprint 7." } as { prompt: string };
    (manager as unknown as {
      attachStructureMeasurement(c: unknown, m: unknown): void;
    }).attachStructureMeasurement({ id: "c1", gddText: "" }, milestone);
    const kept = milestone.prompt.split("\n- (measurement trimmed here")[0]!;
    // Every retained line is a WHOLE line: none ends inside the padding run.
    for (const l of kept.split("\n").filter((x) => x.startsWith("- line "))) {
      expect(l.endsWith("x".repeat(300))).toBe(true);
    }
  });

  it("leaves the prompt alone when the project cannot be measured", () => {
    const root = mkdtempSync(join(tmpdir(), "structprompt-empty-"));
    dirs.push(root);
    const prompt = attach(root, "Sprint 7.");
    // No Assets/ at all: the check reports it could not measure, and the
    // prompt must not gain a refusal the tree does not support.
    expect(prompt).not.toContain("REFUSED:");
  });
});
