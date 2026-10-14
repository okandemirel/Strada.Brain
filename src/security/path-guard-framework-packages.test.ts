/**
 * Agents do not write Strada framework packages (WP-1.2).
 *
 * Strada.Core, Strada.Modules and Strada.MCP are vendored into a project at a
 * recorded commit; they are upstream's code. Runs wrote into them anyway:
 * measured in a live campaign, run reports landed inside the vendored
 * Strada.Core and Strada.MCP, plus a local Strada.Core patch upstream never
 * had — and the framework vaults then served those notes back as if they
 * were the framework. Reading them stays allowed; writing is refused.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "./path-guard.js";
import { isFrameworkPackagePath } from "./framework-package-path.js";
import { FileWriteTool } from "../agents/tools/file-write.js";
import { FileEditTool } from "../agents/tools/file-edit.js";
import { FileDeleteTool, FileRenameTool } from "../agents/tools/file-manage.js";
import type { ToolContext } from "../agents/tools/tool.interface.js";

let project: string;
let ctx: ToolContext;
const CORE_FILE = "Packages/Submodules/Strada.Core/Runtime/Service.cs";

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "guard-framework-"));
  mkdirSync(join(project, "Packages", "Submodules", "Strada.Core", "Runtime"), { recursive: true });
  mkdirSync(join(project, "Assets", "Scripts"), { recursive: true });
  writeFileSync(join(project, ...CORE_FILE.split("/")), "namespace Fw { public class Service {} }\n");
  writeFileSync(join(project, "Packages", "manifest.json"), "{\"dependencies\":{}}\n");
  ctx = { projectPath: project, workingDirectory: project, readOnly: false };
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("which paths are framework packages", () => {
  it("names every place a Strada package is installed, by any spelling", () => {
    for (const path of [
      "Packages/Submodules/Strada.Core/Runtime/X.cs",
      "Packages/Submodules/Strada.Modules",
      "packages/submodules/strada.mcp/src/index.ts",
      "Packages\\Submodules\\Strada.Core\\Editor\\X.cs",
      "Packages/com.strada.core/package.json",
      "Packages/Strada.Core/Runtime/X.cs",
      "Assets/Strada.MCP/unity-package/com.strada.mcp/Editor/X.cs",
      "Assets/Strada.MCP.meta",
      "./Packages/Submodules/Strada.Core/docs/note.md",
    ]) {
      expect(isFrameworkPackagePath(path), path).toBe(true);
    }
  });

  it("leaves the game's own code and the manifest alone (guard)", () => {
    for (const path of [
      "Assets/Scripts/Strada.Core.Extensions.cs",
      "Assets/Modules/Combat/CombatModule.cs",
      "Packages/manifest.json",
      "Packages/packages-lock.json",
      "Packages/Submodules",
      "Assets/StradaGame/Main.cs",
      "../Strada.Core/Runtime/X.cs",
    ]) {
      expect(isFrameworkPackagePath(path), path).toBe(false);
    }
  });
});

describe("validatePath for a write", () => {
  it("refuses a write into a framework package, and still allows reading it", async () => {
    const write = await validatePath(project, CORE_FILE, { write: true });
    expect(write.valid).toBe(false);
    expect(write.error).toContain("framework package");
    expect(write.error).toContain("Strada.Core");

    expect((await validatePath(project, CORE_FILE)).valid).toBe(true);
  });

  it("refuses a new file under a folder that does not exist yet", async () => {
    const check = await validatePath(project, "Packages/Submodules/Strada.Core/notes/run-1.md", {
      write: true,
      allowMissingParents: true,
    });
    expect(check.valid).toBe(false);
  });

  it("judges where the write lands: an absolute path or a link into the package is the package", async () => {
    expect((await validatePath(project, join(project, CORE_FILE), { write: true })).valid).toBe(false);
    symlinkSync(join(project, "Packages", "Submodules", "Strada.Core"), join(project, "Assets", "FrameworkLink"), "dir");
    expect((await validatePath(project, "Assets/FrameworkLink/Runtime/Service.cs", { write: true })).valid).toBe(false);
  });

  it("allows a write into the game's own code (guard)", async () => {
    expect((await validatePath(project, "Assets/Scripts/Player.cs", { write: true })).valid).toBe(true);
    expect((await validatePath(project, "Packages/manifest.json", { write: true })).valid).toBe(true);
  });
});

describe("the file tools refuse to write a framework package", () => {
  it("file_write", async () => {
    const result = await new FileWriteTool().execute({ path: "Packages/Submodules/Strada.Core/docs/report.md", content: "# notes" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("framework package");
    expect(existsSync(join(project, "Packages", "Submodules", "Strada.Core", "docs"))).toBe(false);
  });

  it("file_edit", async () => {
    const result = await new FileEditTool().execute(
      { path: CORE_FILE, old_string: "class Service", new_string: "class PatchedService" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("framework package");
  });

  it("file_delete and file_rename, from or into one", async () => {
    expect((await new FileDeleteTool().execute({ path: CORE_FILE }, ctx)).isError).toBe(true);
    expect(existsSync(join(project, ...CORE_FILE.split("/")))).toBe(true);
    writeFileSync(join(project, "Assets", "Scripts", "Mine.cs"), "// mine\n");
    expect((await new FileRenameTool().execute({ old_path: "Assets/Scripts/Mine.cs", new_path: "Packages/Submodules/Strada.Core/Runtime/Mine.cs" }, ctx)).isError).toBe(true);
    expect((await new FileRenameTool().execute({ old_path: CORE_FILE, new_path: "Assets/Scripts/Service.cs" }, ctx)).isError).toBe(true);
  });

  it("still writes the game's own files (guard)", async () => {
    const result = await new FileWriteTool().execute({ path: "Assets/Scripts/Player.cs", content: "// player" }, ctx);
    expect(result.isError).toBeFalsy();
  });
});
