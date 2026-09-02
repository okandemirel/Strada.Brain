import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrerenderFramesTool, buildRenderScript } from "./prerender-frames.js";
import { resolveUnityCliPath } from "./unity-cli-path.js";
import type { ToolContext } from "../tool.interface.js";

function makeContext(projectPath: string, readOnly = false): ToolContext {
  return { projectPath, workingDirectory: projectPath, readOnly } as ToolContext;
}

describe("buildRenderScript", () => {
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
    expect(resolveUnityCliPath({}, "/home/ci")).toBe("/home/ci/.unity/bin/unity");
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

  it("keeps waiting for frames when the CLI wrapper exits nonzero after handing off", async () => {
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
