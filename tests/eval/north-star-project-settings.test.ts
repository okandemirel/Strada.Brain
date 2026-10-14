/**
 * Criterion G of the north-star scorecard (scripts/eval/north-star-scorecard.mjs):
 * the project's settings held against the platform the campaign's OWN spec
 * states. Orientation, frame rate and render pipeline are the spec's to say;
 * a value the spec does not state is not measured, never failed.
 *
 * Every spec, project and campaign here is invented. The campaigns are
 * written by production's CampaignStorage, so the scorecard reads the schema
 * the system writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  VERDICT,
  classifyVaultPath,
  parseExpectations,
  readSpecPlatform,
  reportPath,
  scoreNorthStar,
  screenOrientationOf,
} from "../../scripts/eval/north-star-scorecard.mjs";
import { CampaignStorage } from "../../src/campaign/campaign-storage.js";
import type { Campaign, CampaignMilestone } from "../../src/campaign/types.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO_ROOT, "scripts", "eval", "north-star-scorecard.mjs");
const T0 = 1_800_000_000_000;
const guid = (): string => randomBytes(16).toString("hex");

interface Check {
  ok: boolean | null;
  text: string;
}
interface Criterion {
  id: string;
  verdict: string;
  cause: string | null;
  checks: Check[];
  measured: Record<string, unknown>;
}
interface Card {
  criteria: Criterion[];
}

// An invented landscape game for laptops and tablets: a glider rides thermals
// over a valley and inks every ridge it crosses into a survey map.
const PLAY = [
  "## 3. Play",
  "The glider rides thermals over a valley. Every ridge it crosses is inked into the survey map;",
  "a gust that tears the line ends the flight and keeps what was inked.",
  "",
].join("\n");

function gliderSpec(orientation: "landscape" | "portrait"): string {
  return [
    "# Glider Survey: design notes",
    "",
    "## 2. Platform",
    `- Screen orientation: ${orientation}, held in two hands.`,
    "- The frame rate is capped at 30 fps to keep laptop fans quiet.",
    "- Rendering: the Built-in Render Pipeline.",
    "",
    PLAY,
  ].join("\n");
}

const NO_PLATFORM_SPEC = ["# Glider Survey: design notes", "", PLAY].join("\n");

interface ProjectOptions {
  orientation?: number;
  autorotate?: { portrait: number; portraitUpsideDown: number; landscapeRight: number; landscapeLeft: number };
  /** The C# statement(s) inside the game's Awake. */
  frameRate?: string;
  /** Extra members of the game's class (constants the statement may name). */
  members?: string;
  pipeline?: "built-in" | "urp" | "hdrp";
  /** Quality levels that assign the pipeline asset, of two (scriptable pipelines only). */
  levelsWithAsset?: number;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** The glider game's project tree: as much of it as criterion G reads. */
function gliderProject(root: string, opts: ProjectOptions = {}): void {
  const {
    orientation = 4,
    autorotate = { portrait: 0, portraitUpsideDown: 0, landscapeRight: 1, landscapeLeft: 1 },
    frameRate = "Application.targetFrameRate = 30;",
    members = "",
    pipeline = "built-in",
    levelsWithAsset = 2,
  } = opts;
  const asset = guid();
  const ref = (on: boolean) => (on ? `{fileID: 11400000, guid: ${asset}, type: 2}` : "{fileID: 0}");
  const srp = pipeline !== "built-in";
  const dependencies: Record<string, string> = { "com.unity.inputsystem": "1.11.2" };
  if (pipeline === "urp") dependencies["com.unity.render-pipelines.universal"] = "17.0.3";
  if (pipeline === "hdrp") dependencies["com.unity.render-pipelines.high-definition"] = "17.0.3";
  write(root, {
    "Assets/Modules/Flight/Scripts/GliderFlight.cs": [
      "using UnityEngine;",
      "namespace Invented.GliderSurvey",
      "{",
      "    public sealed class GliderFlight : MonoBehaviour",
      "    {",
      `        ${members}`,
      `        private void Awake() { ${frameRate} }`,
      "    }",
      "}",
      "",
    ].join("\n"),
    "Assets/Modules/Flight/Scripts/GliderFlight.cs.meta": `fileFormatVersion: 2\nguid: ${guid()}\n`,
    "ProjectSettings/ProjectSettings.asset": [
      "PlayerSettings:",
      "  companyName: Invented Gliderworks",
      "  productName: Glider Survey",
      `  defaultScreenOrientation: ${orientation}`,
      `  allowedAutorotateToPortrait: ${autorotate.portrait}`,
      `  allowedAutorotateToPortraitUpsideDown: ${autorotate.portraitUpsideDown}`,
      `  allowedAutorotateToLandscapeRight: ${autorotate.landscapeRight}`,
      `  allowedAutorotateToLandscapeLeft: ${autorotate.landscapeLeft}`,
      "  applicationIdentifier:",
      "    Standalone: org.invented.glidersurvey",
      "  buildNumber: {}",
      "",
    ].join("\n"),
    "ProjectSettings/GraphicsSettings.asset": `GraphicsSettings:\n  m_CustomRenderPipeline: ${ref(srp)}\n`,
    "ProjectSettings/QualitySettings.asset": [
      "QualitySettings:",
      "  m_QualitySettings:",
      "  - serializedVersion: 4",
      "    name: Breeze",
      `    customRenderPipeline: ${ref(srp && levelsWithAsset >= 1)}`,
      "  - serializedVersion: 4",
      "    name: Gale",
      `    customRenderPipeline: ${ref(srp && levelsWithAsset >= 2)}`,
      "",
    ].join("\n"),
    "Packages/manifest.json": JSON.stringify({ dependencies }),
  });
}

function milestone(id: string, fields: Partial<CampaignMilestone> = {}): CampaignMilestone {
  return { id, title: `Flight ${id}`, prompt: "(synthetic)", status: "green", attempts: 1, ...fields } as CampaignMilestone;
}

/** One campaign on `project`, written by production's storage. */
function seedCampaign(memory: string, project: string, fields: Partial<Campaign>): void {
  mkdirSync(memory, { recursive: true });
  const storage = new CampaignStorage(join(memory, "campaigns.db"));
  try {
    storage.save({
      id: "campaign_glider",
      chatId: "chat-invented",
      channelType: "cli",
      userId: "user-invented",
      projectRoot: project,
      state: "executing",
      draftAttempts: 0,
      milestones: [milestone("m1")],
      currentMilestone: 0,
      createdAt: T0,
      updatedAt: T0 + 3_600_000,
      ...fields,
    } as Campaign);
  } finally {
    storage.close();
  }
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ns-settings-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Criterion G for one spec and one project; `extra` adds scorecard options (the --expect-* flags). */
function criterionG(spec: string | null, project: ProjectOptions = {}, extra: Record<string, unknown> = {}, campaign: Partial<Campaign> = {}): Criterion {
  const home = join(work, "home");
  const projectRoot = join(work, "GliderSurvey");
  gliderProject(projectRoot, project);
  seedCampaign(join(home, ".strada-memory"), projectRoot, { ...(spec === null ? {} : { gddText: spec }), ...campaign });
  const card = scoreNorthStar({ home, project: projectRoot, brainRoot: work, ...extra }) as Card;
  return card.criteria.find((c) => c.id === "G")!;
}

const failed = (g: Criterion) => g.checks.filter((c) => c.ok === false).map((c) => c.text);

describe("criterion G: the project held to its own spec's platform", () => {
  it("passes a landscape game capped at 30 fps on the built-in pipeline when its spec asks for exactly that", () => {
    const g = criterionG(gliderSpec("landscape"));
    expect(failed(g)).toEqual([]);
    expect(g.verdict).toBe(VERDICT.PASS);
    const texts = g.checks.map((c) => c.text);
    expect(texts[0]).toBe(
      'orientation landscape (auto-rotation (defaultScreenOrientation 4) allowing landscape rotations only), as the spec asks: landscape (the approved GDD of campaign_glider: "orientation: landscape")',
    );
    expect(texts).toContain(
      "game code sets Application.targetFrameRate to 30 (Modules/Flight/Scripts/GliderFlight.cs), which answers the spec's ≤ 30 fps (the approved GDD of campaign_glider)",
    );
    expect(texts).toContain(
      'no render pipeline asset is assigned on Graphics or any quality level, so the project renders with the built-in pipeline, as the spec asks: the built-in pipeline (the approved GDD of campaign_glider: "Built-in Render Pipeline")',
    );
    // A built-in project assigns no pipeline asset, and is not failed for it.
    expect(texts.some((t) => /quality levels assign/.test(t))).toBe(false);
    // The values are recorded as measured, not matched against a constant.
    expect(g.measured).toMatchObject({
      orientation: { code: 4, value: "landscape" },
      targetFrameRates: [{ file: "Modules/Flight/Scripts/GliderFlight.cs", expr: "30", value: 30 }],
      renderPipelinePackages: [],
      pipelineAssetOnGraphics: false,
      expected: { orientation: "landscape", fps: [{ comparator: "max", value: 30 }], pipeline: "built-in" },
    });
  });

  it("fails the same project against a spec asking for portrait, on orientation alone", () => {
    const g = criterionG(gliderSpec("portrait"));
    expect(g.verdict).toBe(VERDICT.FAIL);
    expect(failed(g)).toEqual([
      'orientation landscape (auto-rotation (defaultScreenOrientation 4) allowing landscape rotations only); the spec asks for portrait (the approved GDD of campaign_glider: "orientation: portrait")',
    ]);
  });

  it("does not measure what a spec with no platform section does not state, and fails none of it", () => {
    const g = criterionG(NO_PLATFORM_SPEC);
    expect(g.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(failed(g)).toEqual([]);
    expect(g.cause).toBe(
      [
        "orientation: the spec states no orientation (read the approved GDD of campaign_glider; or pass --expect-orientation)",
        "frame rate: the spec states no frame-rate target (read the approved GDD of campaign_glider; or pass --expect-fps)",
        "render pipeline: the spec states no render pipeline (read the approved GDD of campaign_glider; or pass --expect-pipeline)",
      ].join("; "),
    );
    // The hygiene checks still answer: product, company, bundle id.
    expect(g.checks.filter((c) => c.ok === true).map((c) => c.text)).toEqual(["product name set", "company name set", "bundle id set"]);
  });

  it("reads the spec from the ledger rows' own words when the campaign stores no GDD text", () => {
    const rows = [
      "The game is played in landscape on a laptop.",
      "The frame rate never exceeds 30 fps.",
      "Rendering uses the built-in pipeline.",
    ].map((text, i) => ({ rid: `R${i}`, encoded: `R${i}`, text, section: "2", line: i + 1, span: { start: 0, end: 1 }, kind: "constant", source: "extracted", ownership: [], status: "open", checks: [], gddRevision: 1 }));
    const ledger = { version: 1, gddSha256: "0".repeat(64), gddRevision: 1, extractedAtMs: T0, rows, overflow: { count: 0, sections: [] }, numberingGaps: [], llmAdded: 0 };
    const g = criterionG(null, {}, {}, { requirements: ledger as Campaign["requirements"] });
    expect(g.verdict).toBe(VERDICT.PASS);
    expect(g.measured.expected).toEqual({ orientation: "landscape", fps: [{ comparator: "max", value: 30 }], pipeline: "built-in" });
  });

  it("takes the frame-rate target from production's own claim lines on the run before the text", () => {
    // The delivery gate's reading of the GDD (gdd-claims describeClaims) says ≥ 90 fps.
    const claims = milestone("m1", { gddClaims: ["GDD frame rate ≥ 90 fps: NOT MEASURED — the play-through recorded no frame timing (GDD: \"90 fps\")"] });
    const capped = criterionG(gliderSpec("landscape"), {}, {}, { milestones: [claims] });
    expect(failed(capped)).toEqual([
      "game code sets Application.targetFrameRate to 30 (Modules/Flight/Scripts/GliderFlight.cs), which does not answer the spec's ≥ 90 fps (the delivery claims of campaign_glider)",
    ]);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    const fast = criterionG(gliderSpec("landscape"), { frameRate: "Application.targetFrameRate = 120;" }, {}, { milestones: [claims] });
    expect(fast.verdict).toBe(VERDICT.PASS);
  });

  it("holds a 120 fps target against the number the game sets, and a 30 fps cap against 60", () => {
    const at60 = criterionG(gliderSpec("landscape"), { frameRate: "Application.targetFrameRate = 60;" });
    expect(failed(at60)).toEqual([
      "game code sets Application.targetFrameRate to 60 (Modules/Flight/Scripts/GliderFlight.cs), which does not answer the spec's ≤ 30 fps (the approved GDD of campaign_glider)",
    ]);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    const flagged = criterionG(NO_PLATFORM_SPEC, { frameRate: "Application.targetFrameRate = 120;" }, { expectFps: ">=120" });
    expect(flagged.checks.find((c) => /targetFrameRate/.test(c.text))).toEqual({
      ok: true,
      text: "game code sets Application.targetFrameRate to 120 (Modules/Flight/Scripts/GliderFlight.cs), which answers the spec's ≥ 120 fps (--expect-fps)",
    });
  });

  it("reads a named constant, fails a game that sets no frame rate, and does not guess an expression", () => {
    const named = criterionG(gliderSpec("landscape"), { members: "private const int SurveyFps = 30;", frameRate: "Application.targetFrameRate = SurveyFps;" });
    expect(named.verdict).toBe(VERDICT.PASS);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    const unset = criterionG(gliderSpec("landscape"), { frameRate: "var calm = Application.targetFrameRate == 30;" });
    expect(failed(unset)).toEqual([
      "no game code sets Application.targetFrameRate, so the spec's ≤ 30 fps (the approved GDD of campaign_glider) is left to the platform's default",
    ]);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    const opaque = criterionG(gliderSpec("landscape"), { frameRate: "Application.targetFrameRate = Settings.Fps;" });
    expect(opaque.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(opaque.cause).toMatch(/^frame rate: Application\.targetFrameRate is set from `Settings\.Fps` \(Modules\/Flight\/Scripts\/GliderFlight\.cs\), which this scorecard cannot evaluate/);
  });

  it("fails a URP project whose spec asks for HDRP, and still checks a scriptable pipeline's asset on every quality level", () => {
    const g = criterionG(NO_PLATFORM_SPEC, { pipeline: "urp", levelsWithAsset: 1 }, { expectPipeline: "hdrp" });
    expect(failed(g)).toEqual([
      "com.unity.render-pipelines.high-definition is not in Packages/manifest.json; the spec asks for HDRP (--expect-pipeline)",
      "1 of 2 quality levels assign a render pipeline asset",
    ]);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    const hdrp = criterionG(NO_PLATFORM_SPEC, { pipeline: "hdrp" }, { expectPipeline: "hdrp", expectOrientation: "landscape", expectFps: "<=30" });
    expect(hdrp.verdict).toBe(VERDICT.PASS);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    const builtIn = criterionG(NO_PLATFORM_SPEC, {}, { expectPipeline: "urp" });
    expect(failed(builtIn)).toEqual([
      "no render pipeline asset is assigned on Graphics or any quality level (the built-in pipeline); the spec asks for URP (--expect-pipeline)",
    ]);
  });

  it("passes a game that allows both orientations only when its spec allows both", () => {
    const both = { orientation: 4, autorotate: { portrait: 1, portraitUpsideDown: 0, landscapeRight: 1, landscapeLeft: 1 } };
    const spec = gliderSpec("landscape").replace("- Screen orientation: landscape, held in two hands.", "- The survey plays in either orientation.");
    expect(criterionG(spec, both).verdict).toBe(VERDICT.PASS);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    expect(failed(criterionG(gliderSpec("landscape"), both))).toEqual([
      'orientation portrait and landscape (auto-rotation (defaultScreenOrientation 4) allowing portrait and landscape rotations); the spec asks for landscape (the approved GDD of campaign_glider: "orientation: landscape")',
    ]);
  });
});

describe("criterion G's readers", () => {
  it("reads orientation as a setting, not as a picture of a face", () => {
    expect(readSpecPlatform("Orientation — landscape").orientation.map((o) => o.value)).toEqual(["landscape"]);
    expect(readSpecPlatform("A portrait-only layout for phones.").orientation.map((o) => o.value)).toEqual(["portrait"]);
    expect(readSpecPlatform("| Screen orientation | Landscape |").orientation.map((o) => o.value)).toEqual(["landscape"]);
    expect(readSpecPlatform("Supports portrait and landscape.").orientation.map((o) => o.value)).toEqual(["any"]);
    expect(readSpecPlatform("The keeper's portrait sits beside each letter; old letters are held in portrait frames.").orientation).toEqual([]);
  });

  it("reads a frame-rate cap as a cap and a figure as a floor, and names the pipeline", () => {
    expect(readSpecPlatform("Runs at no more than 24 fps on battery").fps).toEqual([{ comparator: "max", value: 24, quote: "24 fps" }]);
    expect(readSpecPlatform("Smooth play at 75 frames per second").fps).toEqual([{ comparator: "min", value: 75, quote: "75 frames per second" }]);
    expect(readSpecPlatform("Built on the High Definition Render Pipeline").pipeline.map((p) => p.value)).toEqual(["hdrp"]);
    expect(readSpecPlatform("Uses URP for its 2D lights").pipeline.map((p) => p.value)).toEqual(["urp"]);
    expect(readSpecPlatform("a leaking faucet is not a pipeline").pipeline).toEqual([]);
  });

  it("does not choose between two orientations a spec names; it says so", () => {
    const spec = ["## 2. Platform", "- Orientation: portrait for the map screen.", "- The flight itself plays in landscape.", "- capped at 30 fps", "- Built-in RP", ""].join("\n");
    const g = criterionG(spec);
    expect(g.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(g.cause).toBe(
      'orientation: the spec states more than one orientation: "Orientation: portrait" and "plays in landscape" (read the approved GDD of campaign_glider; pass --expect-orientation to choose)',
    );
  });

  it("maps Unity's orientation codes and auto-rotation allowances", () => {
    expect(screenOrientationOf(0).value).toBe("portrait");
    expect(screenOrientationOf(3).value).toBe("landscape");
    expect(screenOrientationOf(4, { portrait: 0, portraitUpsideDown: 0, landscapeRight: 0, landscapeLeft: 0 }).value).toBe("none");
    expect(screenOrientationOf(4, {}).value).toBe("any");
    expect(screenOrientationOf(null)).toEqual({ value: null, why: "defaultScreenOrientation is not in ProjectSettings.asset" });
  });

  it("parses the --expect-* values and refuses anything else", () => {
    expect(parseExpectations({ expectOrientation: "Landscape", expectFps: "<=30", expectPipeline: "builtin" })).toEqual({
      orientation: "landscape",
      fps: { comparator: "max", value: 30 },
      pipeline: "built-in",
    });
    expect(parseExpectations({ expectFps: "48" })).toEqual({ fps: { comparator: "eq", value: 48 } });
    expect(() => parseExpectations({ expectOrientation: "diagonal" })).toThrow(/--expect-orientation must be portrait, landscape or any/);
    expect(() => parseExpectations({ expectFps: "fast" })).toThrow(/--expect-fps must be a frame rate/);
    expect(() => parseExpectations({ expectPipeline: "vulkan" })).toThrow(/--expect-pipeline must be urp, hdrp or built-in/);
  });
});

describe("criterion G from the command line", () => {
  it("judges the platform the flags state when there is no campaign, and exits 2 on a value it cannot read", () => {
    const project = join(work, "GliderSurvey");
    gliderProject(project);
    const home = join(work, "empty-home");
    mkdirSync(home);
    const run = (...flags: string[]) =>
      spawnSync(process.execPath, [CLI, "--home", home, "--project", project, "--brain-root", work, "--json", ...flags], { encoding: "utf8", cwd: REPO_ROOT });
    const res = run("--expect-orientation", "landscape", "--expect-fps", "<=30", "--expect-pipeline", "built-in");
    expect(res.status, res.stderr).toBe(EXIT.MEASURED);
    const g = (JSON.parse(res.stdout) as Card).criteria.find((c) => c.id === "G")!;
    expect(g.verdict).toBe(VERDICT.PASS);
    const without = (JSON.parse(run().stdout) as Card).criteria.find((c) => c.id === "G")!;
    expect(without.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(without.cause).toMatch(/^orientation: the spec could not be read: no proof campaign \(campaigns\.db not read: campaigns\.db not found at .*\) \(or pass --expect-orientation\)/);
    const bad = run("--expect-pipeline", "vulkan");
    expect(bad.status).toBe(EXIT.USAGE);
    expect(bad.stderr).toContain('--expect-pipeline must be urp, hdrp or built-in, not "vulkan"');
  });
});

/**
 * ONE SPELLING FOR A PATH THIS REPORT PRINTS. Windows hands back
 * `Modules\\Flight\\Scripts\\X.cs` and macOS `Modules/Flight/Scripts/X.cs`, so
 * the same project scored on two machines produced two different report texts
 * and this rung's own checks, written on one of them, failed on the other
 * (CI, windows-test, 2026-10-14).
 */
describe("the paths the scorecard prints do not carry the platform", () => {
  it("reads a Windows path as the same path", () => {
    expect(reportPath("Modules\\Flight\\Scripts\\GliderFlight.cs")).toBe("Modules/Flight/Scripts/GliderFlight.cs");
    expect(reportPath("Modules/Flight/Scripts/GliderFlight.cs")).toBe("Modules/Flight/Scripts/GliderFlight.cs");
    expect(reportPath("GliderFlight.cs")).toBe("GliderFlight.cs");
  });

  it("classifies a vault path the same way whichever separator it arrives with", () => {
    const windows = "D:\\work\\project\\Packages\\Submodules\\Strada.Core\\Runtime\\Bootstrap\\GameBootstrapper.cs";
    const posix = "/work/project/Packages/Submodules/Strada.Core/Runtime/Bootstrap/GameBootstrapper.cs";
    expect(classifyVaultPath(windows, {})).toEqual(classifyVaultPath(posix, {}));
  });
});
