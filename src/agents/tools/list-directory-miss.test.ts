import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ListDirectoryTool } from "./search.js";

const root = mkdtempSync(join(tmpdir(), "strada-ls-"));
mkdirSync(join(root, "Assets", "Modules", "BoardModule"), { recursive: true });
writeFileSync(join(root, "Assets", "Modules", "BoardModule", "Board.asmdef"), "{}");
mkdirSync(join(root, "Assets", "Modules", "BoardModule", "Scripts"), { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const context = { projectPath: root, workingDirectory: root, readOnly: false } as never;

describe("a directory that is not there", () => {
  it("repeats the path back and names what the parent holds", async () => {
    const result = await new ListDirectoryTool().execute(
      { path: "Assets/Modules/BoardModule/Models" },
      context,
    );

    expect(result.isError).toBe(true);
    // Without the path, the caller cannot tell which of its guesses missed.
    expect(result.content).toContain("Assets/Modules/BoardModule/Models");
    expect(result.content).toContain("Scripts");
  });

  it("still lists a directory that exists", async () => {
    const result = await new ListDirectoryTool().execute(
      { path: "Assets/Modules/BoardModule" },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Board.asmdef");
  });
});
