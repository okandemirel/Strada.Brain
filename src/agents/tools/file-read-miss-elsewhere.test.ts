import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { FileReadTool } from "./file-read.js";

// A file sought in one folder of a module while it lives in a sibling folder of the same module.
const root = mkdtempSync(join(tmpdir(), "strada-miss-"));
mkdirSync(join(root, "Assets/Modules/TideModule/Scripts/Models"), { recursive: true });
mkdirSync(join(root, "Assets/Modules/TideModule/Scripts/Data"), { recursive: true });
mkdirSync(join(root, "Library/ScriptAssemblies"), { recursive: true });
writeFileSync(join(root, "Assets/Modules/TideModule/Scripts/Models/TideChart.cs"), "class TideChart {}");
writeFileSync(join(root, "Assets/Modules/TideModule/Scripts/Data/Notes.txt"), "x");
writeFileSync(join(root, "Library/ScriptAssemblies/TideChart.cs"), "stale build output");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const context = { projectPath: root, workingDirectory: root, readOnly: false } as never;

describe("a file that is somewhere else", () => {
  it("names where that filename actually is", async () => {
    const result = await new FileReadTool().execute(
      { path: "Assets/Modules/TideModule/Scripts/Data/TideChart.cs" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(join("Assets/Modules/TideModule/Scripts/Models", "TideChart.cs"));
    // The old hint described the directory it looked in; that is the wrong answer here.
    expect(result.content).not.toContain("Notes.txt");
  });

  it("does not offer build output as the file the caller meant", async () => {
    const result = await new FileReadTool().execute(
      { path: "Assets/Modules/TideModule/Scripts/Data/TideChart.cs" },
      context,
    );

    expect(result.content).not.toContain("Library");
  });

  it("falls back to the neighbouring names when the name is nowhere", async () => {
    const result = await new FileReadTool().execute(
      { path: "Assets/Modules/TideModule/Scripts/Data/Missing.cs" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Notes.txt");
  });

  it("helps the same way when the missing file's parent does not exist either", () => {
    // A miss whose parent directory is also missing came down a different
    // branch and was answered without the same-name hint.
    return new FileReadTool()
      .execute({ path: "Assets/Modules/TideModule/Scripts/Interfaces/TideChart.cs" }, context)
      .then((result) => {
        expect(result.isError).toBe(true);
        expect(result.content).toContain("file not found");
        expect(result.content).toContain(join("Assets/Modules/TideModule/Scripts/Models", "TideChart.cs"));
      });
  });
});
