import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

/**
 * The limit and the root guard used to be decided on the RAW input string
 * while the delete acted on the path validatePath resolved; the counter also
 * stopped at 51 whatever the limit, so the higher cap was never enforced.
 */
describe("file_delete_directory decides on the resolved target", () => {
  let base: string;
  let root: string;
  const ctx = (projectPath = root): ToolContext =>
    ({ projectPath, workingDirectory: projectPath, readOnly: false }) as ToolContext;
  const fill = (rel: string, count: number): void => {
    mkdirSync(join(root, rel), { recursive: true });
    for (let i = 0; i < count; i++) writeFileSync(join(root, rel, `f_${i}.txt`), "x");
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "delete-dir-resolved-"));
    root = join(base, "project");
    mkdirSync(root);
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it("applies the ordinary limit to a path that only names an output folder on the way", async () => {
    fill("Assets", 60);
    const result = await new FileDeleteDirectoryTool().execute({ path: "Temp/../Assets" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit: 50");
    expect(existsSync(join(root, "Assets", "f_0.txt"))).toBe(true);
  });

  it("classifies a symlink by where it resolves, not by its name", async () => {
    fill("Assets", 60);
    symlinkSync(join(root, "Assets"), join(root, "Temp"), "junction");
    const result = await new FileDeleteDirectoryTool().execute({ path: "Temp" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit: 50");
    expect(existsSync(join(root, "Assets", "f_0.txt"))).toBe(true);
  });

  it("reports the real count of an output folder above fifty files", async () => {
    fill("Temp", 100);
    const result = await new FileDeleteDirectoryTool().execute({ path: "Temp" }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("100 files removed");
  });

  it("enforces the output-folder limit itself", async () => {
    fill("Temp/Captures", 2001);
    const result = await new FileDeleteDirectoryTool().execute({ path: "Temp" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit: 2000");
    expect(existsSync(join(root, "Temp", "Captures", "f_0.txt"))).toBe(true);
  });

  it("refuses an input that resolves to a symlinked project root", async () => {
    fill("Assets", 1);
    const linked = join(base, "linked-project");
    symlinkSync(root, linked, "junction");
    const result = await new FileDeleteDirectoryTool().execute({ path: ".strada/.." }, ctx(linked));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("project root");
    expect(existsSync(join(root, "Assets", "f_0.txt"))).toBe(true);
  });

  it("refuses an input that resolves to a project root given with a trailing separator", async () => {
    fill("Assets", 1);
    const result = await new FileDeleteDirectoryTool().execute({ path: "Logs/.." }, ctx(root + sep));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("project root");
    expect(existsSync(join(root, "Assets", "f_0.txt"))).toBe(true);
  });

  it("does not mistake a directory whose name starts with '..' for the root", async () => {
    fill("..cache", 2);
    const result = await new FileDeleteDirectoryTool().execute({ path: "..cache" }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("2 files removed");
  });
});
