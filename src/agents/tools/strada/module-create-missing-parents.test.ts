/**
 * The first module in a project is the one that has to work.
 *
 * strada_create_module builds its own directory chain — `mkdir(dir, {recursive:
 * true})` for every folder it lays down, including the module root. But it
 * validated the path without `allowMissingParents`, so the guard refused any
 * module whose parent did not already exist, and `Assets/Modules` does not exist
 * in a project that has no modules yet.
 *
 * Measured on a from-scratch run: the agent's first strada_create_module call
 * came back "Error: Parent directory does not exist". It recovered by creating
 * the folder by hand and retrying, so the run survived — but the tool refused
 * exactly the case it was written to handle, on the one call every new project
 * makes.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";
import { installCoreDeclaration } from "./core-declaration-fixture.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

/** An empty project: no Assets/, no Modules/ — the state a new project is in. */
function emptyProject(): string {
  const root = mkdtempSync(join(os.tmpdir(), "module-create-parents-"));
  // Strada.Core declares the module folder structure; without it installed the
  // tool refuses rather than guessing, which is not what these tests are about.
  installCoreDeclaration(root);
  return root;
}

const run = (projectPath: string, input: Record<string, unknown>) =>
  new ModuleCreateTool().execute(input, { projectPath } as never);

describe("creating the first module in a project", () => {
  it("creates a module under a Modules folder that does not exist yet", async () => {
    const projectPath = emptyProject();

    const result = await run(projectPath, {
      name: "Board",
      namespace: "Game.Modules.Board",
      path: "Assets/Modules/BoardModule",
    });

    expect(result.isError, `refused: ${result.content}`).toBeFalsy();
    expect(existsSync(join(projectPath, "Assets", "Modules", "BoardModule"))).toBe(true);
    expect(
      existsSync(join(projectPath, "Assets", "Modules", "BoardModule", "Board.asmdef")),
    ).toBe(true);
  });

  it("still refuses a path that escapes the project", async () => {
    // Relaxing the missing-parent rule must not relax containment: the guard's
    // walk to the deepest existing ancestor is what proves the target is inside,
    // and that check has to survive.
    //
    // The escape target's parent is created for real. Which of the two refusals
    // the guard reaches depends on what exists on disk above the project, and
    // that differs by platform: from a project in /tmp, "../../outside" is
    // /outside and does not exist, so the guard stops at the missing parent
    // before it ever judges containment — while from a macOS project under
    // /var/folders/…/T it lands somewhere real and the containment branch runs.
    // Giving the target an existing parent OUTSIDE the project pins the case
    // this test is about.
    const projectPath = emptyProject();
    const outside = mkdtempSync(join(os.tmpdir(), "module-create-outside-"));

    const result = await run(projectPath, {
      name: "Escape",
      namespace: "Game.Modules.Escape",
      path: join("..", basename(outside), "EscapeModule"),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the project/i);
    expect(existsSync(join(outside, "EscapeModule"))).toBe(false);
  });
});
