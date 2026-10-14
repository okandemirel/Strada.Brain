import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";

/**
 * Measured live 2026-09-04 10:32. The structural refusal — "the shipped
 * scenes render NOTHING … the prefabs, models and sprites that no
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

/** A tree with an empty entry scene and art that no enabled scene reaches: the shape the structural refusal is for. */
function emptyGameProject(): string {
  const root = mkdtempSync(join(tmpdir(), "structprompt-"));
  dirs.push(root);
  put(
    root,
    "ProjectSettings/EditorBuildSettings.asset",
    "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Lobby.unity\n",
  );
  put(
    root,
    "Assets/Scenes/Lobby.unity",
    "%YAML 1.1\n--- !u!1 &100\nGameObject:\n  m_Name: LobbyCamera\n" +
      "--- !u!20 &900\nCamera:\n  orthographic: 0\n",
    "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
  );
  put(
    root,
    "Assets/Prefabs/Kettle.prefab",
    "%YAML 1.1\n--- !u!1 &7\nGameObject:\n  m_Name: Kettle\n" +
      "--- !u!212 &8\nSpriteRenderer:\n  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n",
    "11111111111111111111111111111111",
  );
  put(root, "Assets/Art/kettle.png", "pixels", "22222222222222222222222222222222");
  return root;
}

function attach(root: string, prompt: string, campaign: { gddPath?: string; gddText?: string } = { gddText: "" }): string {
  const manager = Object.create(CampaignManager.prototype) as CampaignManager;
  (manager as unknown as { projectRoot: string }).projectRoot = root;
  const milestone = { prompt } as { prompt: string };
  (manager as unknown as {
    attachStructureMeasurement(c: unknown, m: unknown): void;
  }).attachStructureMeasurement({ id: "c1", ...campaign }, milestone);
  return milestone.prompt;
}

describe("the final sprint is told what the tree renders, on every submit", () => {
  it("puts the measured refusal into the prompt", () => {
    const prompt = attach(emptyGameProject(), "Sprint 38 — deliver the game.");
    expect(prompt).toContain("Sprint 38 — deliver the game.");
    expect(prompt).toContain("REFUSED:");
    expect(prompt).toContain("render NOTHING");
    // The art it must bind, named — a count alone is not a starting point.
    expect(prompt).toContain("Assets/Prefabs/Kettle.prefab");
    // And the entry scene's own emptiness, from the same measurement.
    expect(prompt).toContain("1 GameObject");
    // The anti-audit directive rides with it: it used to live ONLY in the
    // gate-bounce paths, so a sprint revived by an outage never saw it and
    // planned "read the GDD in full, audit the landed modules" instead
    // (measured live 2026-09-04 14:12).
    expect(prompt).toContain("DO NOT AUDIT");
    expect(prompt).toContain("re-audit the landed modules");
    // Discovery goes through the indexed vault, not directory walks
    // (measured 2026-09-06: a long stretch of file_read/list_directory, no
    // vault_search, against an indexed project vault).
    expect(prompt).toContain("vault_search");
    // The recipe names the batch and the audio tool (added 2026-09-07).
    expect(prompt).toContain("`batch`");
    expect(prompt).toContain("unity_generate_audio");
    expect(prompt).toContain("unity_bind_sprite");
    expect(prompt).toContain("unity_place_prefab");
  });

  it("sends the final sprint to the sections of its own GDD file (GDD-drift trace M4)", () => {
    // "Do not re-read the whole GDD" was read as "do not consult it": a final
    // sprint built against rules it had been told not to look up. The
    // measurement replaces an audit of the tree, not the design.
    const prompt = attach(emptyGameProject(), "Sprint 38 — deliver the game.", {
      gddPath: "docs/GlassworksDesign.md",
      gddText: "# Glassworks\n## 1. Kilns\nA kiln cools for a full night before it is opened.\n",
    });
    expect(prompt).not.toMatch(/re-read the (?:whole )?GDD/i);
    expect(prompt).toContain("read the sections of docs/GlassworksDesign.md your change implements");
    expect(prompt).toContain("re-audit the landed modules");
    expect(prompt).not.toContain("not saved in the project");
  });

  it("never sends a text-only campaign's final sprint to look for a GDD file (review gdd-W10 P2)", () => {
    // A campaign whose GDD could not be saved into the project has no file:
    // docs/ may hold another document, and "read the GDD sections" sent the
    // sprint to it. Such a campaign is told where its design is instead.
    const prompt = attach(emptyGameProject(), "Sprint 38 — deliver the game.", {
      gddText: "# Glassworks\n## 1. Kilns\nA kiln cools for a full night before it is opened.\n",
    });
    expect(prompt).not.toMatch(/re-read the (?:whole )?GDD/i);
    expect(prompt).not.toMatch(/read the (?:GDD )?sections/i);
    expect(prompt).toContain("campaign's GDD is not saved in the project, so no file holds it");
    expect(prompt).toContain("do not look for one");
    expect(prompt).toMatch(/build what this prompt states of the GDD/i);
    expect(prompt).toContain("re-audit the landed modules");
  });

  it("replaces the previous block instead of stacking a stale one", () => {
    const root = emptyGameProject();
    let prompt = attach(root, "Sprint 38.");
    prompt = attach(root, prompt);
    prompt = attach(root, prompt);
    const opens = prompt.split("<<MEASURED NOW").length - 1;
    expect(opens).toBe(1);
  });

  it("keeps a tail appended after the block, and re-measures around it", () => {
    const root = emptyGameProject();
    const first = attach(root, "Sprint 38.");
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
    const milestone = { prompt: "Sprint 38." } as { prompt: string };
    (manager as unknown as {
      attachStructureMeasurement(c: unknown, m: unknown): void;
    }).attachStructureMeasurement({ id: "c1", gddText: "" }, milestone);
    expect(milestone.prompt).toContain("measurement trimmed here");
    // On a line boundary, not mid-word: the first live render ended
    // "- Camera projection in the shi", which reads as corrupted, not trimmed.
    const kept = milestone.prompt.split("\n- (measurement trimmed here")[0]!;
    expect(kept.endsWith("shi")).toBe(false);
  });

  it("keeps the art and audio inventory ahead of the trim", () => {
    // Measured 2026-09-07 14:23: the coverage sprint's block was cut before
    // "Project art: … N of the M sprite textures are placeholder-grade".
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = emptyGameProject();
    const filler = Array.from({ length: 40 }, (_, i) => `scene detail ${i}: ${"x".repeat(90)}`);
    (manager as unknown as { measureDeliveryStructure(): unknown }).measureDeliveryStructure = () => ({
      refusal: "the scenes render NOTHING",
      lines: [...filler, "Project art: 268 sprite textures — 153 of the 268 sprite textures are placeholder-grade", "Project audio: 37 clips, 33 distinct by content"],
    });
    const milestone = { id: "mcov1", title: "t", prompt: "Sprint.", status: "pending", attempts: 0 } as never;
    (manager as unknown as { attachStructureMeasurement(c: unknown, m: unknown): void }).attachStructureMeasurement(
      { id: "c", milestones: [milestone] },
      milestone,
    );
    const prompt = (milestone as { prompt: string }).prompt;
    expect(prompt).toContain("measurement trimmed here");
    expect(prompt).toContain("153 of the 268 sprite textures are placeholder-grade");
    expect(prompt).toContain("Project audio: 37 clips");
    expect(prompt.indexOf("Project art")).toBeLessThan(prompt.indexOf("scene detail 0"));
  });

  it("keeps whole lines when it trims a multi-line measurement", () => {
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = emptyGameProject();
    const line = (n: number): string => `line ${n}: ${"x".repeat(300)}`;
    (manager as unknown as { measureDeliveryStructure(): unknown }).measureDeliveryStructure = () => ({
      refusal: "the scenes render NOTHING",
      lines: Array.from({ length: 20 }, (_, i) => line(i)),
    });
    const milestone = { prompt: "Sprint 38." } as { prompt: string };
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
    const prompt = attach(root, "Sprint 38.");
    // No Assets/ at all: the check reports it could not measure, and the
    // prompt must not gain a refusal the tree does not support.
    expect(prompt).not.toContain("REFUSED:");
  });
});
