import { describe, it, expect, beforeEach } from "vitest";
import { isValidCSharpIdentifier, isValidCSharpType, validatePath } from "./path-guard.js";
import { withTempDir } from "../test-helpers.js";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("isValidCSharpIdentifier", () => {
  it("accepts simple identifiers", () => {
    expect(isValidCSharpIdentifier("MyClass")).toBe(true);
    expect(isValidCSharpIdentifier("_field")).toBe(true);
    expect(isValidCSharpIdentifier("x")).toBe(true);
    expect(isValidCSharpIdentifier("A1")).toBe(true);
  });

  it("rejects identifiers starting with digits", () => {
    expect(isValidCSharpIdentifier("123Bad")).toBe(false);
    expect(isValidCSharpIdentifier("0abc")).toBe(false);
  });

  it("rejects empty and null-like inputs", () => {
    expect(isValidCSharpIdentifier("")).toBe(false);
  });

  it("rejects inputs exceeding 256 chars", () => {
    expect(isValidCSharpIdentifier("a".repeat(256))).toBe(true);
    expect(isValidCSharpIdentifier("a".repeat(257))).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidCSharpIdentifier("bad;inject")).toBe(false);
    expect(isValidCSharpIdentifier("bad name")).toBe(false);
    expect(isValidCSharpIdentifier("bad{}")).toBe(false);
    expect(isValidCSharpIdentifier("bad()")).toBe(false);
  });

  it("handles dotted names when allowDots=true", () => {
    expect(isValidCSharpIdentifier("Game.Modules.Combat", true)).toBe(true);
    expect(isValidCSharpIdentifier("A.B.C", true)).toBe(true);
  });

  it("rejects dotted names when allowDots=false", () => {
    expect(isValidCSharpIdentifier("Game.Module", false)).toBe(false);
    expect(isValidCSharpIdentifier("Game.Module")).toBe(false);
  });

  it("rejects invalid dotted names", () => {
    expect(isValidCSharpIdentifier(".Bad", true)).toBe(false);
    expect(isValidCSharpIdentifier("Bad.", true)).toBe(false);
    expect(isValidCSharpIdentifier("Bad..Name", true)).toBe(false);
    expect(isValidCSharpIdentifier("1Bad.Name", true)).toBe(false);
  });
});

describe("isValidCSharpType", () => {
  it("accepts basic types", () => {
    expect(isValidCSharpType("float3")).toBe(true);
    expect(isValidCSharpType("int")).toBe(true);
    expect(isValidCSharpType("string")).toBe(true);
    expect(isValidCSharpType("bool")).toBe(true);
  });

  it("accepts generic types", () => {
    expect(isValidCSharpType("List<int>")).toBe(true);
    expect(isValidCSharpType("Dictionary<string, int>")).toBe(true);
  });

  it("accepts array and nullable types", () => {
    expect(isValidCSharpType("int[]")).toBe(true);
    expect(isValidCSharpType("float?")).toBe(true);
  });

  it("rejects code injection characters", () => {
    expect(isValidCSharpType("bad;inject")).toBe(false);
    expect(isValidCSharpType("bad{}")).toBe(false);
    expect(isValidCSharpType("bad()")).toBe(false);
    expect(isValidCSharpType("x=1")).toBe(false);
  });

  it("rejects empty and oversized inputs", () => {
    expect(isValidCSharpType("")).toBe(false);
    expect(isValidCSharpType("a".repeat(257))).toBe(false);
  });
});

describe("validatePath", () => {
  it("accepts a valid relative path", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "test.cs"), "content");
      const result = await validatePath(dir, "test.cs");
      expect(result.valid).toBe(true);
      expect(result.fullPath).toContain("test.cs");
    });
  });

  it("rejects empty path", async () => {
    await withTempDir(async (dir) => {
      const result = await validatePath(dir, "");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Path is required");
    });
  });

  it("rejects path traversal attempts", async () => {
    await withTempDir(async (dir) => {
      const result = await validatePath(dir, "../../../etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("outside the project directory");
    });
  });

  it("rejects symlink escape", async () => {
    await withTempDir(async (dir) => {
      await symlink("/tmp", join(dir, "escape-link"));
      const result = await validatePath(dir, "escape-link");
      expect(result.valid).toBe(false);
    });
  });

  it("rejects sensitive files: .env", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".env"), "SECRET=x");
      const result = await validatePath(dir, ".env");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Access to sensitive files is not permitted");
    });
  });

  it("rejects sensitive files: .env.production", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".env.production"), "SECRET=x");
      const result = await validatePath(dir, ".env.production");
      expect(result.valid).toBe(false);
    });
  });

  it("rejects sensitive paths: .git/config", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, ".git", "config"), "");
      const result = await validatePath(dir, ".git/config");
      expect(result.valid).toBe(false);
    });
  });

  it("rejects node_modules paths", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "index.js"), "");
      const result = await validatePath(dir, "node_modules/pkg/index.js");
      expect(result.valid).toBe(false);
    });
  });

  it("allows new file when parent directory exists", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "Assets"), { recursive: true });
      const result = await validatePath(dir, "Assets/NewFile.cs");
      expect(result.valid).toBe(true);
    });
  });

  it("rejects new file when parent directory does not exist outside project", async () => {
    await withTempDir(async (dir) => {
      const result = await validatePath(dir, "../../outside/NewFile.cs");
      expect(result.valid).toBe(false);
    });
  });

  it("allows project root itself", async () => {
    await withTempDir(async (dir) => {
      const result = await validatePath(dir, ".");
      expect(result.valid).toBe(true);
    });
  });

  it("rejects non-existent project root", async () => {
    const result = await validatePath("/nonexistent/project/path/xyz", "file.cs");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Project root does not exist");
  });

  it("allows nested subdirectory file", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "Assets", "Scripts"), { recursive: true });
      await writeFile(join(dir, "Assets", "Scripts", "Player.cs"), "class Player {}");
      const result = await validatePath(dir, "Assets/Scripts/Player.cs");
      expect(result.valid).toBe(true);
    });
  });

  it("rejects absolute path that escapes project", async () => {
    await withTempDir(async (dir) => {
      const result = await validatePath(dir, "/etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("outside the project directory");
    });
  });
});
