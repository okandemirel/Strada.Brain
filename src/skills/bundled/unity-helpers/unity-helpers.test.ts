import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../../agents/tools/tool.interface.js";
import { tools } from "./index.js";

// ---------------------------------------------------------------------------
// Real files in a temporary project. SEC-2: these tools used to resolve the
// directory against process.cwd() and enumerate any tree on disk; it is now
// confined to `context.projectPath` through the built-in tools' path-guard.
// ---------------------------------------------------------------------------

let base: string;
let project: string;
let outside: string;
let context: ToolContext;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "strada-unity-helpers-")));
  project = join(base, "project");
  outside = join(base, "outside");
  await mkdir(project);
  await mkdir(outside);
  context = { projectPath: project, workingDirectory: project, readOnly: false };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function touch(rel: string, root = project): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "");
}

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// unity_find_scripts
// ---------------------------------------------------------------------------

describe("unity_find_scripts", () => {
  const tool = findTool("unity_find_scripts");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({}, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("directory");
  });

  it("finds .cs files in a flat directory", async () => {
    await touch("Player.cs");
    await touch("README.md");
    await touch("Enemy.cs");
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toContain("Found 2 script(s)");
    expect(result.content).toContain("Player.cs");
    expect(result.content).toContain("Enemy.cs");
  });

  it("finds .cs files recursively in nested directories", async () => {
    await touch("Main.cs");
    await touch("Scripts/Utils.cs");
    await touch("Scripts/Player/Movement.cs");
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toContain("Found 3 script(s)");
    expect(result.content).toContain("Main.cs");
    expect(result.content).toContain(join("Scripts", "Utils.cs"));
    expect(result.content).toContain(join("Scripts", "Player", "Movement.cs"));
  });

  it("lists paths relative to the directory searched", async () => {
    await touch("Assets/Scripts/Game.cs");
    const result = await tool.execute({ directory: "Assets" }, context);
    expect(result.content).toBe(`Found 1 script(s):\n${join("Scripts", "Game.cs")}`);
  });

  it("returns message when no .cs files found", async () => {
    await touch("readme.txt");
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toBe("No .cs files found.");
  });
});

// ---------------------------------------------------------------------------
// unity_list_scenes
// ---------------------------------------------------------------------------

describe("unity_list_scenes", () => {
  const tool = findTool("unity_list_scenes");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({}, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("directory");
  });

  it("finds .unity scene files recursively", async () => {
    await touch("Scenes/Main.unity");
    await touch("Scenes/Levels/Level1.unity");
    await touch("Scenes/Levels/Level2.unity");
    await touch("Scripts/Player.cs");
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toContain("Found 3 scene(s)");
    expect(result.content).toContain(join("Scenes", "Main.unity"));
    expect(result.content).toContain(join("Scenes", "Levels", "Level1.unity"));
    expect(result.content).toContain(join("Scenes", "Levels", "Level2.unity"));
  });

  it("returns message when no .unity files found", async () => {
    await touch("Player.cs");
    const result = await tool.execute({ directory: "." }, context);
    expect(result.content).toBe("No .unity scene files found.");
  });
});

// ---------------------------------------------------------------------------
// SEC-2: confinement to the project
// ---------------------------------------------------------------------------

describe("security: confined to the project", () => {
  const scriptsTool = findTool("unity_find_scripts");
  const scenesTool = findTool("unity_list_scenes");

  it("resolves `.` against the project root, not the process working directory", async () => {
    await touch("OnlyInProject.cs");
    const result = await scriptsTool.execute({ directory: "." }, context);
    expect(result.content).toBe("Found 1 script(s):\nOnlyInProject.cs");
  });

  it("refuses directories outside the project, including through a symlink", async () => {
    await touch("Secret.cs", outside);
    await symlink(outside, join(project, "linked"));
    for (const directory of [outside, "..", "linked", "/etc"]) {
      const result = await scriptsTool.execute({ directory }, context);
      expect(result.content, directory).toContain("outside the project directory");
    }
  });

  it("never lists files reached through a symlink or under a sensitive directory", async () => {
    await touch("Game.cs");
    await touch("Secret.cs", outside);
    await touch("Hidden.unity", outside);
    await symlink(outside, join(project, "linked"));
    await symlink(join(outside, "Secret.cs"), join(project, "Linked.cs"));
    await touch(".ssh/Key.cs");
    await touch("node_modules/pkg/Dep.cs");

    const scripts = await scriptsTool.execute({ directory: "." }, context);
    expect(scripts.content).toBe("Found 1 script(s):\nGame.cs");
    const scenes = await scenesTool.execute({ directory: "." }, context);
    expect(scenes.content).toBe("No .unity scene files found.");
    const ssh = await scriptsTool.execute({ directory: ".ssh" }, context);
    expect(ssh.content).toContain("sensitive files is not permitted");
  });

  it("rejects path with null byte", async () => {
    const result = await scriptsTool.execute({ directory: "Assets\0evil" }, context);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("invalid characters");
  });

  it("refuses without a project directory", async () => {
    const result = await scriptsTool.execute({ directory: "." }, { ...context, projectPath: "" });
    expect(result.content).toContain("No project directory");
  });
});
