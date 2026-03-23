import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs/promises before importing the module under test
// ---------------------------------------------------------------------------

const mockReaddir = vi.fn();
const mockRealpath = vi.fn();

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  realpath: (...args: unknown[]) => mockRealpath(...args),
}));

// Must import *after* vi.mock so the mock is in place.
const { tools } = await import("./index.js");

const dummyContext = {} as Parameters<(typeof tools)[0]["execute"]>[1];

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// Helpers for building mock directory entries
// ---------------------------------------------------------------------------

interface MockDirent {
  name: string;
  isDirectory: () => boolean;
}

function file(name: string): MockDirent {
  return { name, isDirectory: () => false };
}

function dir(name: string): MockDirent {
  return { name, isDirectory: () => true };
}

/**
 * Configure mockReaddir to return the expected entries for each directory path.
 * `tree` maps absolute directory paths to arrays of MockDirent.
 */
function setupTree(tree: Record<string, MockDirent[]>) {
  mockReaddir.mockImplementation((dirPath: string, _opts: unknown) => {
    const entries = tree[dirPath];
    if (!entries) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(entries);
  });
}

beforeEach(() => {
  mockReaddir.mockReset();
  // Default: realpath resolves to the path as-is (no symlink remapping)
  mockRealpath.mockImplementation((p: unknown) => Promise.resolve(p as string));
});

// ---------------------------------------------------------------------------
// unity_find_scripts
// ---------------------------------------------------------------------------

describe("unity_find_scripts", () => {
  const tool = findTool("unity_find_scripts");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("directory");
  });

  it("finds .cs files in a flat directory", async () => {
    setupTree({
      "/project": [file("Player.cs"), file("README.md"), file("Enemy.cs")],
    });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("Found 2 script(s)");
    expect(result.content).toContain("Player.cs");
    expect(result.content).toContain("Enemy.cs");
  });

  it("finds .cs files recursively in nested directories", async () => {
    setupTree({
      "/project": [dir("Scripts"), file("Main.cs")],
      "/project/Scripts": [dir("Player"), file("Utils.cs")],
      "/project/Scripts/Player": [file("Movement.cs")],
    });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("Found 3 script(s)");
    expect(result.content).toContain("Main.cs");
    expect(result.content).toContain("Scripts/Utils.cs");
    expect(result.content).toContain("Scripts/Player/Movement.cs");
  });

  it("returns message when no .cs files found", async () => {
    setupTree({
      "/empty": [file("readme.txt")],
    });

    const result = await tool.execute({ directory: "/empty" }, dummyContext);
    expect(result.content).toBe("No .cs files found.");
  });

  it("handles unreadable subdirectories gracefully", async () => {
    setupTree({
      "/project": [dir("locked"), file("Game.cs")],
      // "/project/locked" is not in the tree → readdir will reject
    });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("Found 1 script(s)");
    expect(result.content).toContain("Game.cs");
  });
});

// ---------------------------------------------------------------------------
// unity_list_scenes
// ---------------------------------------------------------------------------

describe("unity_list_scenes", () => {
  const tool = findTool("unity_list_scenes");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("directory");
  });

  it("finds .unity scene files in a flat directory", async () => {
    setupTree({
      "/project": [file("MainMenu.unity"), file("Level1.unity"), file("Player.cs")],
    });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("Found 2 scene(s)");
    expect(result.content).toContain("MainMenu.unity");
    expect(result.content).toContain("Level1.unity");
  });

  it("finds .unity files recursively in nested directories", async () => {
    setupTree({
      "/project": [dir("Scenes"), dir("Scripts")],
      "/project/Scenes": [file("Main.unity"), dir("Levels")],
      "/project/Scenes/Levels": [file("Level1.unity"), file("Level2.unity")],
      "/project/Scripts": [file("Player.cs")],
    });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("Found 3 scene(s)");
    expect(result.content).toContain("Scenes/Main.unity");
    expect(result.content).toContain("Scenes/Levels/Level1.unity");
    expect(result.content).toContain("Scenes/Levels/Level2.unity");
  });

  it("returns message when no .unity files found", async () => {
    setupTree({
      "/project": [file("Player.cs"), file("readme.txt")],
    });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toBe("No .unity scene files found.");
  });
});

// ---------------------------------------------------------------------------
// Security: directory traversal / sensitive path rejection
// ---------------------------------------------------------------------------

describe("security: sensitive path rejection", () => {
  const scriptsTool = findTool("unity_find_scripts");
  const scenesTool = findTool("unity_list_scenes");

  it("rejects /etc for unity_find_scripts", async () => {
    mockRealpath.mockResolvedValue("/etc");
    const result = await scriptsTool.execute({ directory: "/etc" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("rejects ~/.ssh for unity_list_scenes", async () => {
    const sshPath = "/Users/testuser/.ssh";
    mockRealpath.mockResolvedValue(sshPath);
    const result = await scenesTool.execute({ directory: sshPath }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("rejects symlink pointing to sensitive dir", async () => {
    // The input looks innocent but realpath resolves to /etc
    mockRealpath.mockResolvedValue("/etc");
    const result = await scriptsTool.execute({ directory: "/project/symlink-to-etc" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
  });

  it("rejects path with null byte", async () => {
    const result = await scriptsTool.execute({ directory: "/project\0evil" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("invalid characters");
    expect(mockRealpath).not.toHaveBeenCalled();
  });

  it("allows a normal project directory", async () => {
    mockRealpath.mockResolvedValue("/home/user/my-game");
    setupTree({
      "/home/user/my-game": [file("Player.cs")],
    });
    const result = await scriptsTool.execute({ directory: "/home/user/my-game" }, dummyContext);
    expect(result.content).toContain("Found 1 script(s)");
  });
});
