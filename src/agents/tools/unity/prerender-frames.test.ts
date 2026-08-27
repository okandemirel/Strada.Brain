import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrerenderFramesTool, buildRenderScript } from "./prerender-frames.js";
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

  it("rejects output outside Assets/", async () => {
    writeFileSync(join(dir, "Assets", "X.prefab"), "yaml");
    const result = await tool.execute({ prefab: "Assets/X.prefab", outDir: "Elsewhere" }, makeContext(dir));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Assets");
  });
});
