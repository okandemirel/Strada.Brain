import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { FileReadTool } from "./file-read.js";

// The measured case: BoardState.cs sought in Scripts/Data, living in Scripts/Models.
const root = mkdtempSync(join(tmpdir(), "strada-miss-"));
mkdirSync(join(root, "Assets/Modules/BoardModule/Scripts/Models"), { recursive: true });
mkdirSync(join(root, "Assets/Modules/BoardModule/Scripts/Data"), { recursive: true });
mkdirSync(join(root, "Library/ScriptAssemblies"), { recursive: true });
writeFileSync(join(root, "Assets/Modules/BoardModule/Scripts/Models/BoardState.cs"), "class BoardState {}");
writeFileSync(join(root, "Assets/Modules/BoardModule/Scripts/Data/Notes.txt"), "x");
writeFileSync(join(root, "Library/ScriptAssemblies/BoardState.cs"), "stale build output");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const context = { projectPath: root, workingDirectory: root, readOnly: false } as never;

describe("a file that is somewhere else", () => {
  it("names where that filename actually is", async () => {
    const result = await new FileReadTool().execute(
      { path: "Assets/Modules/BoardModule/Scripts/Data/BoardState.cs" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(join("Assets/Modules/BoardModule/Scripts/Models", "BoardState.cs"));
    // The old hint described the directory it looked in; that is the wrong answer here.
    expect(result.content).not.toContain("Notes.txt");
  });

  it("does not offer build output as the file the caller meant", async () => {
    const result = await new FileReadTool().execute(
      { path: "Assets/Modules/BoardModule/Scripts/Data/BoardState.cs" },
      context,
    );

    expect(result.content).not.toContain("Library");
  });

  it("falls back to the neighbouring names when the name is nowhere", async () => {
    const result = await new FileReadTool().execute(
      { path: "Assets/Modules/BoardModule/Scripts/Data/Missing.cs" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Notes.txt");
  });

  it("helps the same way when the missing file's parent does not exist either", () => {
    // Measured live: two reads thirty seconds apart, one helped and one bare,
    // the only difference being whether the parent directory existed.
    return new FileReadTool()
      .execute({ path: "Assets/Modules/BoardModule/Scripts/Interfaces/BoardState.cs" }, context)
      .then((result) => {
        expect(result.isError).toBe(true);
        expect(result.content).toContain("file not found");
        expect(result.content).toContain(join("Assets/Modules/BoardModule/Scripts/Models", "BoardState.cs"));
      });
  });
});
