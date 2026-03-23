import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs/promises before importing the module under test
// ---------------------------------------------------------------------------

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockRealpath = vi.fn();
const mockStat = vi.fn();

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  realpath: (...args: unknown[]) => mockRealpath(...args),
  stat: (...args: unknown[]) => mockStat(...args),
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

function setupTree(tree: Record<string, MockDirent[]>) {
  mockReaddir.mockImplementation((dirPath: string, _opts: unknown) => {
    const entries = tree[dirPath];
    if (!entries) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(entries);
  });
}

beforeEach(() => {
  mockReaddir.mockReset();
  mockReadFile.mockReset();
  mockRealpath.mockReset();
  mockStat.mockReset();
  // Default: realpath resolves to the path as-is (no symlink remapping)
  mockRealpath.mockImplementation((p: unknown) => Promise.resolve(p as string));
});

// ---------------------------------------------------------------------------
// file_stats
// ---------------------------------------------------------------------------

describe("file_stats", () => {
  const tool = findTool("file_stats");

  it("returns file statistics for a valid file", async () => {
    const content = "hello world\nfoo bar baz\n";
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({
      isFile: () => true,
      size: content.length,
    });

    const result = await tool.execute({ path: "/project/test.txt" }, dummyContext);
    expect(result.content).toContain("Lines: 3");
    expect(result.content).toContain("Words: 5");
    expect(result.content).toContain("Characters: 24");
    expect(result.content).toContain("Size:");
  });

  it("returns error when path parameter is missing", async () => {
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("returns error when path is not a file", async () => {
    mockReadFile.mockResolvedValue("");
    mockStat.mockResolvedValue({
      isFile: () => false,
      size: 0,
    });

    const result = await tool.execute({ path: "/project/somedir" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not a file");
  });

  it("returns error when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));
    mockStat.mockRejectedValue(new Error("ENOENT: no such file"));

    const result = await tool.execute({ path: "/nonexistent/file.txt" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("ENOENT");
  });

  it("rejects path with null byte", async () => {
    const result = await tool.execute({ path: "/project/evil\0file.txt" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("invalid characters");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("rejects sensitive file paths", async () => {
    mockRealpath.mockResolvedValue("/etc/passwd");
    const result = await tool.execute({ path: "/etc/passwd" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// file_find_large
// ---------------------------------------------------------------------------

describe("file_find_large", () => {
  const tool = findTool("file_find_large");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({}, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("finds large files sorted by size descending", async () => {
    setupTree({
      "/project": [file("big.bin"), file("small.txt"), file("medium.log")],
    });

    mockStat.mockImplementation((filePath: string) => {
      if (filePath.endsWith("big.bin")) return Promise.resolve({ size: 2 * 1024 * 1024 });
      if (filePath.endsWith("medium.log")) return Promise.resolve({ size: 1.5 * 1024 * 1024 });
      if (filePath.endsWith("small.txt")) return Promise.resolve({ size: 100 });
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await tool.execute({ directory: "/project", minSizeKb: 1024 }, dummyContext);
    expect(result.content).toContain("Found 2 file(s)");
    expect(result.content).toContain("big.bin");
    expect(result.content).toContain("medium.log");
    // big.bin should appear before medium.log (largest first)
    const bigIdx = result.content.indexOf("big.bin");
    const medIdx = result.content.indexOf("medium.log");
    expect(bigIdx).toBeLessThan(medIdx);
  });

  it("uses default minSizeKb of 1024 when not specified", async () => {
    setupTree({
      "/project": [file("large.bin")],
    });

    // 500KB — under default 1MB threshold
    mockStat.mockResolvedValue({ size: 500 * 1024 });

    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("No files larger than");
  });

  it("returns no results message when no files exceed threshold", async () => {
    setupTree({
      "/project": [file("tiny.txt")],
    });

    mockStat.mockResolvedValue({ size: 10 });

    const result = await tool.execute({ directory: "/project", minSizeKb: 1 }, dummyContext);
    expect(result.content).toContain("No files larger than");
  });

  it("limits results to 20 files", async () => {
    const files: MockDirent[] = [];
    for (let i = 0; i < 25; i++) {
      files.push(file(`file${i}.bin`));
    }
    setupTree({ "/project": files });

    mockStat.mockResolvedValue({ size: 2 * 1024 * 1024 });

    const result = await tool.execute({ directory: "/project", minSizeKb: 1 }, dummyContext);
    expect(result.content).toContain("Found 25 file(s)");
    // Count the file entries in the output — should be 20 lines max
    // Header line + 20 file entries = 21 lines total. Check that the file entries are capped at 20.
    const outputLines = result.content.split("\n").filter((l: string) => /file\d+\.bin/.test(l));
    expect(outputLines.length).toBeLessThanOrEqual(20);
  });

  it("rejects sensitive directories", async () => {
    mockRealpath.mockResolvedValue("/etc");
    const result = await tool.execute({ directory: "/etc" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("rejects path with null byte", async () => {
    const result = await tool.execute({ directory: "/project\0evil" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("invalid characters");
  });
});

// ---------------------------------------------------------------------------
// file_line_search
// ---------------------------------------------------------------------------

describe("file_line_search", () => {
  const tool = findTool("file_line_search");

  it("returns error when directory parameter is missing", async () => {
    const result = await tool.execute({ pattern: "test" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("returns error when pattern parameter is missing", async () => {
    const result = await tool.execute({ directory: "/project" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("required");
  });

  it("finds matching lines in files", async () => {
    setupTree({
      "/project": [file("app.ts"), file("readme.md")],
    });

    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.endsWith("app.ts")) {
        return Promise.resolve("import express from 'express';\nconst TODO = 'fix this';\nexport default app;");
      }
      if (filePath.endsWith("readme.md")) {
        return Promise.resolve("# README\nThis is a TODO item\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await tool.execute({ directory: "/project", pattern: "TODO" }, dummyContext);
    expect(result.content).toContain("Found 2 match(es)");
    expect(result.content).toContain("app.ts:2:");
    expect(result.content).toContain("readme.md:2:");
  });

  it("supports regex patterns", async () => {
    setupTree({
      "/project": [file("code.ts")],
    });

    mockReadFile.mockResolvedValue("const x = 42;\nfunction hello() {}\nconst y = 99;\n");

    const result = await tool.execute({ directory: "/project", pattern: "^const\\s+\\w+\\s*=" }, dummyContext);
    expect(result.content).toContain("Found 2 match(es)");
    expect(result.content).toContain("code.ts:1:");
    expect(result.content).toContain("code.ts:3:");
  });

  it("returns error for invalid regex", async () => {
    const result = await tool.execute({ directory: "/project", pattern: "[invalid" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("Invalid regex");
  });

  it("returns no matches message when nothing found", async () => {
    setupTree({
      "/project": [file("empty.txt")],
    });

    mockReadFile.mockResolvedValue("nothing here\n");

    const result = await tool.execute({ directory: "/project", pattern: "MISSING" }, dummyContext);
    expect(result.content).toContain("No matches found");
  });

  it("limits results to 50 matches", async () => {
    setupTree({
      "/project": [file("big.txt")],
    });

    // Create file with 60 matching lines
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} MATCH`).join("\n");
    mockReadFile.mockResolvedValue(lines);

    const result = await tool.execute({ directory: "/project", pattern: "MATCH" }, dummyContext);
    expect(result.content).toContain("Found 50 match(es)");
    expect(result.content).toContain("Results limited to 50");
  });

  it("rejects sensitive directories", async () => {
    mockRealpath.mockResolvedValue("/root");
    const result = await tool.execute({ directory: "/root", pattern: "test" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("rejects path with null byte", async () => {
    const result = await tool.execute({ directory: "/project\0evil", pattern: "test" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("invalid characters");
  });

  it("handles unreadable files gracefully", async () => {
    setupTree({
      "/project": [file("binary.dat"), file("text.txt")],
    });

    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.endsWith("binary.dat")) return Promise.reject(new Error("Cannot read binary"));
      if (filePath.endsWith("text.txt")) return Promise.resolve("hello FIND_ME\n");
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await tool.execute({ directory: "/project", pattern: "FIND_ME" }, dummyContext);
    expect(result.content).toContain("Found 1 match(es)");
    expect(result.content).toContain("text.txt:1:");
  });
});

// ---------------------------------------------------------------------------
// Security: directory traversal / sensitive path rejection
// ---------------------------------------------------------------------------

describe("security: sensitive path rejection", () => {
  const statsTool = findTool("file_stats");
  const largeTool = findTool("file_find_large");
  const searchTool = findTool("file_line_search");

  it("rejects /etc for file_find_large", async () => {
    mockRealpath.mockResolvedValue("/etc");
    const result = await largeTool.execute({ directory: "/etc" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("rejects ~/.ssh for file_line_search", async () => {
    const sshPath = "/Users/testuser/.ssh";
    mockRealpath.mockResolvedValue(sshPath);
    const result = await searchTool.execute({ directory: sshPath, pattern: "key" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("rejects symlink pointing to sensitive dir", async () => {
    mockRealpath.mockResolvedValue("/etc");
    const result = await largeTool.execute({ directory: "/project/symlink-to-etc" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
  });

  it("rejects file_stats for sensitive file path", async () => {
    mockRealpath.mockResolvedValue("/etc/shadow");
    const result = await statsTool.execute({ path: "/etc/shadow" }, dummyContext);
    expect(result.content).toContain("Error");
    expect(result.content).toContain("not permitted");
  });

  it("allows a normal directory", async () => {
    mockRealpath.mockResolvedValue("/home/user/project");
    setupTree({
      "/home/user/project": [file("readme.txt")],
    });
    mockReadFile.mockResolvedValue("hello\n");

    const result = await searchTool.execute({ directory: "/home/user/project", pattern: "hello" }, dummyContext);
    expect(result.content).toContain("Found 1 match(es)");
  });
});
