/**
 * A gate that fires on a fixture at boot has not been shown to catch a defect
 * in THIS game. These controls break the delivered project — in memory, never
 * on disk — and require the same measurement to refuse it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeNegativeControls, runNegativeControls } from "./negative-controls.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const UNITY_HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
const CAMERA = "--- !u!20 &20\nCamera:\n  m_Enabled: 1\n";

function project(opts: { registered: boolean; identified: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "controls-"));
  dirs.push(root);
  const put = (rel: string, body: string): void => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  mkdirSync(join(root, "Assets", "Modules", "Harbor", "Scripts"), { recursive: true });
  mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });
  put("Assets/Modules/Harbor/Scripts/BeamService.cs", "public class BeamService : IBeamService { }");
  put(
    "Assets/Modules/Harbor/Scripts/HarborModuleConfig.cs",
    opts.registered
      ? "public class HarborModuleConfig : ModuleConfig {\n  public override void Configure(IContainerBuilder b) { b.RegisterService<IBeamService, BeamService>(); }\n}"
      : "public class HarborModuleConfig : ModuleConfig { }",
  );
  put(
    "Assets/Scenes/Harbor.unity",
    `${UNITY_HEADER}${CAMERA}--- !u!1001 &1001\nPrefabInstance:\n  m_Modification:\n    m_Modifications: []\n  m_SourcePrefab: {fileID: 100100000, guid: 11111111111111111111111111111111, type: 3}\n`,
  );
  put(
    "ProjectSettings/ProjectSettings.asset",
    [
      "PlayerSettings:",
      `  companyName: ${opts.identified ? "Harbor Works" : "DefaultCompany"}`,
      "  productName: Harbor Light",
      "  defaultScreenOrientation: 1",
      opts.identified ? "  applicationIdentifier:\n    Android: com.harborworks.harborlight" : "  applicationIdentifier: {}",
    ].join("\n"),
  );
  return root;
}

const ANDROID_GDD = "# Harbor Light\n\nAn Android game, portrait only.\n";

describe("negative controls", () => {
  it("shows the registration gate catching a project whose registrations are gone", () => {
    const controls = runNegativeControls(project({ registered: true, identified: true }), ANDROID_GDD, true);
    const registration = controls.find((c) => c.gate === "service registration")!;

    expect(registration.skipped).toBeUndefined();
    expect(registration.fired).toBe(true);
    expect(registration.detail).toContain("names 1 unregistered service(s) where the delivery names 0");
  });

  it("shows the identity gate catching a handheld build with nobody's name on it", () => {
    const controls = runNegativeControls(project({ registered: true, identified: true }), ANDROID_GDD, true);
    const identity = controls.find((c) => c.gate === "app identity")!;

    expect(identity.fired).toBe(true);
    expect(identity.detail).toContain("handheld");
  });

  it("says a control is not applicable rather than counting it as passed", () => {
    const controls = runNegativeControls(project({ registered: true, identified: true }), "Windows only.", false);
    const identity = controls.find((c) => c.gate === "app identity")!;

    expect(identity.fired).toBe(false);
    expect(identity.skipped).toContain("no handheld platform");
    expect(describeNegativeControls(controls)).toEqual([
      expect.stringContaining("not applicable"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    ]);
  });

  it("does not run a control it cannot set up, and says which", () => {
    // Breaking a project that is already broken — or that has nothing to
    // break — proves nothing about the gate, and a "did not fire" there would
    // read as a dead gate.
    const root = mkdtempSync(join(tmpdir(), "controls-empty-"));
    dirs.push(root);
    mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
    writeFileSync(join(root, "Assets", "Scenes", "Harbor.unity"), `${UNITY_HEADER}${CAMERA}`);

    const controls = runNegativeControls(root, ANDROID_GDD, true);
    const structural = controls.find((c) => c.gate === "built as specified")!;

    expect(structural.fired).toBe(false);
    expect(structural.skipped ?? "").toMatch(/ALREADY refused|could not be measured|nothing to remove|instantiates a prefab|ships no scene/u);
    // …and the service control too: this project declares no service.
    expect(controls.find((c) => c.gate === "service registration")!.skipped).toContain("no service class");
  });

  it("does not call a gate dead for a defect that never applied to this game", () => {
    // A scene that draws without prefab instances cannot be emptied by
    // removing them. Reporting "DID NOT FIRE" there is the false alarm a
    // control exists to prevent.
    const root = mkdtempSync(join(tmpdir(), "controls-noprefab-"));
    dirs.push(root);
    mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
    mkdirSync(join(root, "Assets", "Art"), { recursive: true });
    writeFileSync(
      join(root, "Assets", "Scenes", "Harbor.unity"),
      `${UNITY_HEADER}${CAMERA}--- !u!1001 &1001\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: 11111111111111111111111111111111, type: 3}\n--- !u!212 &212\nSpriteRenderer:\n  m_Enabled: 1\n  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n`,
    );

    const structural = runNegativeControls(root, ANDROID_GDD, true).find((c) => c.gate === "built as specified")!;

    // Either it refused (fired) or it says why the defect did not apply —
    // never a bare "did not fire".
    expect(structural.fired || structural.skipped !== undefined).toBe(true);
  });

  it("changes nothing on disk", () => {
    const root = project({ registered: true, identified: true });
    const before = readFileSyncAll(root);

    runNegativeControls(root, ANDROID_GDD, true);

    expect(readFileSyncAll(root)).toEqual(before);
  });

  it("counts what ran, and says so in one line", () => {
    const lines = describeNegativeControls([
      { gate: "a", defect: "x", fired: true, detail: "refused" },
      { gate: "b", defect: "y", fired: false, detail: "passed anyway" },
      { gate: "c", defect: "z", fired: false, skipped: "nothing to break", detail: "-" },
    ]);

    expect(lines[0]).toBe("Negative controls: 1 of 2 gates refused the project once it was broken on purpose, 1 not applicable");
    expect(lines[1]).toContain("a: FIRED");
    expect(lines[2]).toContain("b: DID NOT FIRE");
    expect(lines[3]).toContain("c: not run");
  });

  it("says plainly when no control could run", () => {
    expect(describeNegativeControls([{ gate: "a", defect: "x", fired: false, skipped: "no scene", detail: "-" }])[0])
      .toContain("none could run");
  });
});

function readFileSyncAll(root: string): Record<string, string> {
  const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[abs] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}
