import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { FileWriteTool } from "./file-write.js";

// An interface that already exists under Scripts/Interfaces is written again under Scripts/Services.
const root = mkdtempSync(join(tmpdir(), "strada-twin-"));
mkdirSync(join(root, "Assets/Modules/PantryModule/Scripts/Interfaces"), { recursive: true });
mkdirSync(join(root, "Assets/Modules/PantryModule/Scripts/Services"), { recursive: true });
writeFileSync(join(root, "Assets/Modules/PantryModule/Scripts/Interfaces/IPantryService.cs"), "interface IPantryService {}");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const context = { projectPath: root, workingDirectory: root, readOnly: false } as never;

describe("writing a file whose name the project already uses", () => {
  it("says where the other one is", async () => {
    const result = await new FileWriteTool().execute(
      {
        path: "Assets/Modules/PantryModule/Scripts/Services/IPantryService.cs",
        content: "interface IPantryService {}",
      },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Interfaces");
    expect(result.content).toContain("IPantryService.cs");
  });

  it("says nothing extra for a name the project does not already use", async () => {
    const result = await new FileWriteTool().execute(
      { path: "Assets/Modules/PantryModule/Scripts/Services/AuditTrailService.cs", content: "class AuditTrailService {}" },
      context,
    );

    expect(result.content).not.toContain("also exists");
  });

  it("does not warn when overwriting the file itself", async () => {
    const path = "Assets/Modules/PantryModule/Scripts/Interfaces/IPantryService.cs";
    const result = await new FileWriteTool().execute(
      { path, content: "interface IPantryService { void Tick(); }" },
      context,
    );

    expect(result.content).not.toContain("also exists");
  });
});
