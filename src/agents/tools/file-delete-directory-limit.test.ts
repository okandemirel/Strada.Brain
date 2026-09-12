import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileDeleteDirectoryTool, isSystemOutputDirectory } from "./file-manage.js";
import type { ToolContext } from "./tool.interface.js";

/**
 * Measured live 2026-09-12 03:50: a sprint cleaning up after itself was
 * refused sixteen times in one ten-minute window — "directory contains 51
 * files (limit: 50)" against Artifacts/UfoPlayModeCapture and its siblings. A
 * PlayMode capture folder routinely holds more than fifty frames.
 */
describe("deleting a directory of the system's own output", () => {
  let root: string;
  const ctx = (): ToolContext => ({ projectPath: root, workingDirectory: root, readOnly: false }) as ToolContext;
  const fill = (rel: string, count: number): void => {
    mkdirSync(join(root, rel), { recursive: true });
    for (let i = 0; i < count; i++) writeFileSync(join(root, rel, `frame_${i}.png`), "x");
  };

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "delete-dir-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("names the system's own output directories", () => {
    expect(isSystemOutputDirectory("Artifacts/UfoPlayModeCapture")).toBe(true);
    expect(isSystemOutputDirectory("Recordings/playthrough")).toBe(true);
    expect(isSystemOutputDirectory("Logs")).toBe(true);
    expect(isSystemOutputDirectory("Assets/Art/Generated")).toBe(false);
    expect(isSystemOutputDirectory("Assets/Scripts")).toBe(false);
  });

  it("removes 51 captured frames, and still refuses 51 of a person's files", async () => {
    fill("Artifacts/UfoPlayModeCapture", 51);
    const captures = await new FileDeleteDirectoryTool().execute({ path: "Artifacts/UfoPlayModeCapture" }, ctx());
    expect(captures.isError).toBeFalsy();
    expect(captures.content).toContain("51 files removed");

    fill("Assets/Art/Generated", 51);
    const assets = await new FileDeleteDirectoryTool().execute({ path: "Assets/Art/Generated" }, ctx());
    expect(assets.isError).toBe(true);
    expect(assets.content).toContain("limit: 50");
  });
});
