import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";

/**
 * Measured 2026-09-03: the delivered project carried many scenes, most of the
 * enabled ones single-purpose verification scaffolding — and the report never
 * said which one is the game.
 */
const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "proj-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scene(objects: number): string {
  return Array.from({ length: objects }, () => "GameObject:\n  m_Name: X").join("\n");
}

describe("delivery report entry point", () => {
  it("names the scene the build opens, the richer one beside it, and the scaffolding (Codex 2026-09-11 C#26)", () => {
    const root = tmp();
    mkdirSync(join(root, "ProjectSettings"), { recursive: true });
    mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
    writeFileSync(join(root, "Assets", "Scenes", "Concourse.unity"), scene(26));
    writeFileSync(join(root, "Assets", "Scenes", "TideSandbox.unity"), scene(6));
    writeFileSync(join(root, "Assets", "InitTestScene-abc.unity"), scene(2));
    writeFileSync(
      join(root, "ProjectSettings", "EditorBuildSettings.asset"),
      ["  - enabled: 1", "    path: Assets/Scenes/TideSandbox.unity",
       "  - enabled: 1", "    path: Assets/Scenes/Concourse.unity",
       "  - enabled: 1", "    path: Assets/InitTestScene-abc.unity",
       "  - enabled: 0", "    path: Assets/Scenes/Disabled.unity"].join("\n"),
    );

    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = root;
    const text = (manager as unknown as { describeEntryPoint(): string | undefined }).describeEntryPoint();

    expect(text).toContain("How to run it");
    // The build opens TideSandbox (index 0) — that is what a person gets —
    // and Concourse is named beside it with what to do about it.
    expect(text).toContain("Assets/Scenes/TideSandbox.unity");
    expect(text).toContain("FIRST enabled scene");
    expect(text).toContain("Concourse.unity");
    expect(text).toContain("26 objects");
    expect(text).toContain("verification scaffolding");
  });

  it("says it could not measure, rather than guessing OR going silent", () => {
    // Tightened 2026-09-03: this used to return undefined and the report
    // printed nothing at all — indistinguishable, to a reader, from a build
    // with one obvious entry scene. A skipped measurement must never read
    // like a passed one, and it still never guesses a scene.
    const manager = Object.create(CampaignManager.prototype) as CampaignManager;
    (manager as unknown as { projectRoot: string }).projectRoot = tmp();
    const text = (manager as unknown as { describeEntryPoint(): string }).describeEntryPoint();
    expect(text).toContain("could not be measured");
    expect(text).toContain("EditorBuildSettings.asset");
    expect(text).not.toContain("press Play");
  });
});
