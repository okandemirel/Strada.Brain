import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrerenderFramesTool, buildRenderScript, materialForShading, resolvePrerenderStyle } from "./prerender-frames.js";
import { resolveUnityCliPath } from "./unity-cli-path.js";
import { spriteMeta } from "./sprite-generate.js";
import type { ToolContext } from "../tool.interface.js";

function makeContext(projectPath: string, readOnly = false): ToolContext {
  return { projectPath, workingDirectory: projectPath, readOnly } as ToolContext;
}

describe("buildRenderScript", () => {
  it("no profile means no styling: no squash, no pink, matte material (Codex 2026-09-11 B#21)", () => {
    const neutral = buildRenderScript({ bodyColor: "#9aa0a6", plump: [1, 1, 1], headScale: 1, outlineWidth: 0, shading: "flat" });
    expect(neutral).toContain('toon.SetFloat("_Glossiness", 0.1f)');
    expect(neutral).not.toContain('toon.SetFloat("_Glossiness", 0.82f)');
    expect(neutral).toContain("bool isEye = false;");
    const glossy = buildRenderScript({ bodyColor: "#f89eb8", plump: [1.2, 0.833, 1.2], headScale: 1.22, outlineWidth: 1, shading: "glossy" });
    expect(glossy).toContain('toon.SetFloat("_Glossiness", 0.82f)');
    expect(materialForShading("glossy")).toEqual({ glossiness: 0.82, metallic: 0 });
    expect(materialForShading("pbr-realistic")).toEqual({ glossiness: 0.5, metallic: 0.1 });
    expect(materialForShading(undefined)).toEqual({ glossiness: 0.1, metallic: 0 });
  });

  it("embeds the tuned lighting, the stylize stage, and the synchronous RT capture", () => {
    const script = buildRenderScript({
      bodyColor: "#f89eb8",
      plump: [1.2, 0.86, 1.2],
      headScale: 1.22,
      outlineWidth: 1.0,
    });
    expect(script).toContain("KeyLight");
    expect(script).toContain("RenderTexture(768, 768, 24");
    expect(script).toContain("ReadPixels");
    expect(script).toContain("Strada/Outline");
    expect(script).toContain("Cull Front");
    // The measured lesson: CaptureScreenshot never lands in batchmode.
    expect(script).not.toContain("CaptureScreenshot");
  });

  it("can disable the outline shell", () => {
    const script = buildRenderScript({
      bodyColor: "#f89eb8",
      plump: [1.2, 0.86, 1.2],
      headScale: 1.22,
      outlineWidth: 0,
    });
    expect(script).toContain("if (false)");
  });
});

describe("resolvePrerenderStyle (Codex 2026-09-12 T#14)", () => {
  it("keeps an explicit no-outline, and asks for none when nothing does", () => {
    // A profile that says "no outline" had the family's outline put back over
    // it, and a project with no profile at all got the stock 1.0.
    expect(resolvePrerenderStyle({}, { outlineWidth: 0 }).outlineWidth).toBe(0);
    expect(resolvePrerenderStyle({}, {}).outlineWidth).toBe(0);
    // An explicit input still wins, and the profile answers when the input is absent.
    expect(resolvePrerenderStyle({ outlineWidth: 2 }, { outlineWidth: 0 }).outlineWidth).toBe(2);
    expect(resolvePrerenderStyle({}, { outlineWidth: 1.5 }).outlineWidth).toBe(1.5);
    // …and nothing else is invented: neutral colour, no squash, flat shading.
    expect(resolvePrerenderStyle({}, {})).toMatchObject({
      bodyColor: "#9aa0a6", plump: [1, 1, 1], headScale: 1, shading: "flat",
    });
  });
});

describe("PrerenderFramesTool validation", () => {
  let dir: string;
  const tool = new PrerenderFramesTool();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prerender-test-"));
    mkdirSync(join(dir, "Assets"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("honours read-only mode", async () => {
    const result = await tool.execute({ prefab: "Assets/X.prefab" }, makeContext(dir, true));
    expect(result.isError).toBe(true);
  });

  it("rejects non-prefab inputs and missing prefabs", async () => {
    expect((await tool.execute({ prefab: "Assets/X.fbx" }, makeContext(dir))).isError).toBe(true);
    expect((await tool.execute({ prefab: "Assets/Missing.prefab" }, makeContext(dir))).isError).toBe(true);
  });

  // Audited 2026-09-02: the CLI default was `/Users/okan/.unity/bin/unity`,
  // so any other account failed with an error naming a stranger's home
  // directory and no mention of the override.
  it("looks for the Unity CLI under the current user's home, not a hardcoded one", () => {
    // A native path: the CLI is looked up on this machine's filesystem.
    expect(resolveUnityCliPath({}, "/home/ci")).toBe(join("/home/ci", ".unity", "bin", "unity"));
    expect(resolveUnityCliPath({ STRADA_UNITY_CLI: "/opt/unity/bin/unity" }, "/home/ci")).toBe("/opt/unity/bin/unity");
    expect(resolveUnityCliPath({}, "/home/ci")).not.toContain("okan");
  });

  it("names the path it checked and the override when the CLI is missing", async () => {
    writeFileSync(join(dir, "Assets", "X.prefab"), "yaml");
    const saved = process.env["STRADA_UNITY_CLI"];
    process.env["STRADA_UNITY_CLI"] = join(dir, "no-such-unity");
    try {
      const result = await tool.execute({ prefab: "Assets/X.prefab" }, makeContext(dir));
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain(join(dir, "no-such-unity"));
      expect(String(result.content)).toContain("STRADA_UNITY_CLI");
      expect(String(result.content)).not.toContain("/Users/okan");
    } finally {
      if (saved === undefined) delete process.env["STRADA_UNITY_CLI"];
      else process.env["STRADA_UNITY_CLI"] = saved;
    }
  });

  it("rejects output outside Assets/", async () => {
    writeFileSync(join(dir, "Assets", "X.prefab"), "yaml");
    const result = await tool.execute({ prefab: "Assets/X.prefab", outDir: "Elsewhere" }, makeContext(dir));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Assets");
  });
});

/**
 * `unity open` is fire-and-forget: the Hub takes over and the CLI wrapper
 * exits on its own schedule, often nonzero. Audited 2026-09-02: any callback
 * error (nonzero exit, the wrapper's own 60s timeout) was recorded as a launch
 * failure, the poll loop broke before the batchmode editor could write a frame,
 * and the tool pkill'd the healthy editor and reported "render produced no
 * frames: Unity CLI launch failed" — a failure it manufactured itself. The
 * sibling unity-link-runner bails only on ENOENT; this test pins that rule.
 */
describe("PrerenderFramesTool launch semantics", () => {
  let dir: string;
  let cliDir: string;
  const savedCli = process.env["STRADA_UNITY_CLI"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prerender-launch-"));
    mkdirSync(join(dir, "Assets"), { recursive: true });
    writeFileSync(join(dir, "Assets", "Boar.prefab"), "yaml");
    cliDir = mkdtempSync(join(tmpdir(), "prerender-cli-"));
  });

  afterEach(() => {
    if (savedCli === undefined) delete process.env["STRADA_UNITY_CLI"];
    else process.env["STRADA_UNITY_CLI"] = savedCli;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
  });

  // The stand-in CLI is a #!/bin/sh script (sed, sleep): Windows cannot execFile it.
  it.skipIf(process.platform === "win32")("keeps waiting for frames when the CLI wrapper exits nonzero after handing off", async () => {
    // A stand-in for `unity open`: hands off to a detached "editor" that lands
    // the frames three seconds later, then exits 3 the way the Hub wrapper can.
    const fakeCli = join(cliDir, "unity");
    writeFileSync(
      fakeCli,
      [
        "#!/bin/sh",
        'ARGS="$4"',
        "OUT=$(printf '%s' \"$ARGS\" | sed -n 's/.*-outDir \"\\([^\"]*\\)\".*/\\1/p')",
        "LOG=$(printf '%s' \"$ARGS\" | sed -n 's/.*-logFile \"\\([^\"]*\\)\".*/\\1/p')",
        '( sleep 3; mkdir -p "$OUT"; : > "$OUT/frame_000.png"; : > "$OUT/frame_001.png"; echo STRADA-RENDER-OK > "$LOG" ) >/dev/null 2>&1 &',
        "exit 3",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env["STRADA_UNITY_CLI"] = fakeCli;
    vi.resetModules();
    const { PrerenderFramesTool: FreshTool } = await import("./prerender-frames.js");

    const result = await new FreshTool().execute({ prefab: "Assets/Boar.prefab" }, makeContext(dir));

    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("2 frames rendered");
  }, 30_000);
});

/**
 * Audit A5 / D56: every re-render rewrote each frame's sprite .meta from the
 * template, so a pivot/PPU/slice set on a rendered angle was lost on the next
 * prerender. Frame metas of the right importer are kept now.
 */
describe("PrerenderFramesTool keeps an authored frame .meta (audit A5 / D56)", () => {
  let dir: string;
  let cliDir: string;
  const savedCli = process.env["STRADA_UNITY_CLI"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prerender-meta-"));
    mkdirSync(join(dir, "Assets"), { recursive: true });
    writeFileSync(join(dir, "Assets", "Boar.prefab"), "yaml");
    cliDir = mkdtempSync(join(tmpdir(), "prerender-meta-cli-"));
  });

  afterEach(() => {
    if (savedCli === undefined) delete process.env["STRADA_UNITY_CLI"];
    else process.env["STRADA_UNITY_CLI"] = savedCli;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
  });

  // The stand-in CLI is a #!/bin/sh script (sed, sleep): Windows cannot execFile it.
  it.skipIf(process.platform === "win32")("a frame meta with PPU 16, a custom pivot and two slices survives a re-render; a wrong-importer one is replaced", async () => {
    const fakeCli = join(cliDir, "unity");
    writeFileSync(
      fakeCli,
      [
        "#!/bin/sh",
        'ARGS="$4"',
        "OUT=$(printf '%s' \"$ARGS\" | sed -n 's/.*-outDir \"\\([^\"]*\\)\".*/\\1/p')",
        "LOG=$(printf '%s' \"$ARGS\" | sed -n 's/.*-logFile \"\\([^\"]*\\)\".*/\\1/p')",
        '( sleep 1; mkdir -p "$OUT"; : > "$OUT/frame_000.png"; : > "$OUT/frame_045.png"; echo STRADA-RENDER-OK > "$LOG" ) >/dev/null 2>&1 &',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env["STRADA_UNITY_CLI"] = fakeCli;
    const outDir = join(dir, "Assets", "Art", "Prerendered", "Boar");
    mkdirSync(outDir, { recursive: true });
    const GUID = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a";
    const authored = spriteMeta(GUID)
      .replace("spritePixelsToUnits: 100", "spritePixelsToUnits: 16")
      .replace("spritePivot: {x: 0.5, y: 0.5}", "spritePivot: {x: 0.25, y: 0}")
      .replace("    sprites: []", "    sprites:\n    - name: Boar_0\n      rect: {x: 0, y: 0, width: 32, height: 32}\n    - name: Boar_1\n      rect: {x: 32, y: 0, width: 32, height: 32}");
    writeFileSync(join(outDir, "frame_000.png.meta"), authored, "utf8");
    const WRONG = "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b";
    writeFileSync(join(outDir, "frame_045.png.meta"), `fileFormatVersion: 2\nguid: ${WRONG}\nDefaultImporter:\n  externalObjects: {}\n`, "utf8");

    vi.resetModules();
    const { PrerenderFramesTool: FreshTool } = await import("./prerender-frames.js");
    const result = await new FreshTool().execute({ prefab: "Assets/Boar.prefab" }, makeContext(dir));
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("2 frames rendered");

    expect(readFileSync(join(outDir, "frame_000.png.meta"), "utf8")).toBe(authored);
    const replaced = readFileSync(join(outDir, "frame_045.png.meta"), "utf8");
    expect(replaced).toBe(spriteMeta(WRONG));
  }, 30_000);
});
