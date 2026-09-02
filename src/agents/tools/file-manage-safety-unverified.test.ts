import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "./tool.interface.js";

/**
 * Audited 2026-09-02: FileDeleteTool wrapped checkSafeToDelete in a bare
 * `catch {}` and proceeded to unlink, so a reference check that never ran
 * ("Logger not initialized", an I/O error) read exactly like one that passed.
 * A delete on an unverified verdict must be refused and say why.
 */
vi.mock("../../intelligence/unity-guid-resolver.js", () => ({
  checkSafeToDelete: vi.fn(async () => {
    throw new Error("simulated: reference scan crashed");
  }),
}));

const { FileDeleteTool } = await import("./file-manage.js");

let tempDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "file-manage-unverified-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("FileDeleteTool when the reference safety check cannot run", () => {
  it("refuses the delete and names the failed check instead of unlinking", async () => {
    await writeFile(join(tempDir, "Rock.mat"), "%YAML 1.1\n");
    const tool = new FileDeleteTool();

    const result = await tool.execute({ path: "Rock.mat" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("safety check");
    expect(result.content).toContain("could not run");
    expect(result.content).toContain("simulated: reference scan crashed");
    expect(result.content).not.toContain("Deleted");
    // The file must still exist.
    await expect(stat(join(tempDir, "Rock.mat"))).resolves.toBeDefined();
  });
});
