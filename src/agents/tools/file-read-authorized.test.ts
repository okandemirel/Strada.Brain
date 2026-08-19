/**
 * Reading a file the user named, and refusing everything else.
 *
 * The measured case: the user says "read the design document at /somewhere/gdd.md
 * and build the game", the document sits outside the Unity project, and path
 * confinement refuses it — so the run plans a generic game from one sentence and
 * never sees the design at all.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { FileReadTool } from "./file-read.js";

const tool = new FileReadTool();

function setup(): { project: string; outside: string } {
  const project = mkdtempSync(join(os.tmpdir(), "authz-project-"));
  mkdirSync(join(project, "Assets"), { recursive: true });
  writeFileSync(join(project, "Assets", "Inside.cs"), "// inside");

  const elsewhere = mkdtempSync(join(os.tmpdir(), "authz-outside-"));
  const outside = join(elsewhere, "gdd.md");
  writeFileSync(outside, "# PixelFlow\nAn 8x8 match-3 board.");
  writeFileSync(join(elsewhere, "secrets.txt"), "do not read me");
  return { project, outside };
}

const ctx = (project: string, authorized?: string[]) =>
  ({ projectPath: project, readOnly: false, userAuthorizedPaths: authorized }) as never;

describe("a document the user named", () => {
  it("is read even though it sits outside the project", async () => {
    const { project, outside } = setup();

    const result = await tool.execute({ path: outside }, ctx(project, [outside]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("match-3 board");
    expect(result.content).toContain("you named this path");
  });

  it("is refused when the user named nothing", async () => {
    const { project, outside } = setup();

    const result = await tool.execute({ path: outside }, ctx(project));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the project");
  });

  it("does not authorize its neighbours", async () => {
    // Naming one file is not naming its folder.
    const { project, outside } = setup();
    const sibling = join(outside, "..", "secrets.txt");

    const result = await tool.execute({ path: sibling }, ctx(project, [outside]));

    expect(result.isError).toBe(true);
  });

  it("does not authorize a traversal out of the named file", async () => {
    const { project, outside } = setup();

    const result = await tool.execute(
      { path: join(outside, "..", "..", "..", "etc", "passwd") },
      ctx(project, [outside]),
    );

    expect(result.isError).toBe(true);
  });

  it("leaves ordinary in-project reads exactly as they were", async () => {
    const { project, outside } = setup();

    const result = await tool.execute({ path: "Assets/Inside.cs" }, ctx(project, [outside]));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("// inside");
    expect(result.content).not.toContain("you named this path");
  });
});
