import { describe, it, expect } from "vitest";
import { readFile, stat, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CreateSkillTool } from "./create-skill.js";
import { withTempDir, createToolContext } from "../../../test-helpers.js";

describe("CreateSkillTool", () => {
  const tool = new CreateSkillTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("create_skill");
    expect(tool.inputSchema.required).toContain("name");
    expect(tool.inputSchema.required).toContain("version");
    expect(tool.inputSchema.required).toContain("description");
    expect(tool.inputSchema.required).toContain("content");
  });

  it("creates SKILL.md in workspace skills directory", async () => {
    await withTempDir(async (dir) => {
      const ctx = createToolContext({ projectPath: dir, workingDirectory: dir });

      const result = await tool.execute(
        {
          name: "test-skill",
          version: "1.0.0",
          description: "A test skill",
          content: "# Test Skill\n\nThis is a test skill for unit testing.",
          author: "Test Author",
          capabilities: ["testing", "demo"],
        },
        ctx,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("test-skill");
      expect(result.content).toContain("created at");

      // Verify file was written
      const skillPath = join(dir, "skills", "test-skill", "SKILL.md");
      const content = await readFile(skillPath, "utf-8");
      expect(content).toContain("name: test-skill");
      expect(content).toContain("version: 1.0.0");
      expect(content).toContain("description: A test skill");
      expect(content).toContain("author: Test Author");
      expect(content).toContain("capabilities: [testing, demo]");
      expect(content).toContain("# Test Skill");
    });
  });

  it("rejects empty name", async () => {
    const result = await tool.execute(
      { name: "", version: "1.0.0", description: "test", content: "test" },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("name is required");
  });

  it("rejects invalid name format", async () => {
    const result = await tool.execute(
      { name: "Invalid_Name", version: "1.0.0", description: "test", content: "test" },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must start with a letter");
  });

  it("rejects empty description", async () => {
    const result = await tool.execute(
      { name: "valid-name", version: "1.0.0", description: "", content: "test" },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("description is required");
  });

  it("rejects empty content", async () => {
    const result = await tool.execute(
      { name: "valid-name", version: "1.0.0", description: "test", content: "" },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content is required");
  });

  it("rejects content exceeding 50,000 characters", async () => {
    const result = await tool.execute(
      {
        name: "valid-name",
        version: "1.0.0",
        description: "test",
        content: "x".repeat(50_001),
      },
      createToolContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("50,000 character limit");
  });

  it("rejects if skill already exists", async () => {
    await withTempDir(async (dir) => {
      const ctx = createToolContext({ projectPath: dir, workingDirectory: dir });

      // Create first
      await tool.execute(
        { name: "existing-skill", version: "1.0.0", description: "test", content: "test" },
        ctx,
      );

      // Try again
      const result = await tool.execute(
        { name: "existing-skill", version: "1.0.0", description: "test", content: "test" },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("already exists");
    });
  });

  it("creates skill without optional fields", async () => {
    await withTempDir(async (dir) => {
      const ctx = createToolContext({ projectPath: dir, workingDirectory: dir });

      const result = await tool.execute(
        {
          name: "minimal-skill",
          version: "0.1.0",
          description: "Minimal skill",
          content: "Just some content",
        },
        ctx,
      );

      expect(result.isError).toBeUndefined();

      const skillPath = join(dir, "skills", "minimal-skill", "SKILL.md");
      const content = await readFile(skillPath, "utf-8");
      expect(content).not.toContain("author:");
      expect(content).not.toContain("capabilities:");
    });
  });

  it("shows content preview in success message", async () => {
    await withTempDir(async (dir) => {
      const ctx = createToolContext({ projectPath: dir, workingDirectory: dir });

      const result = await tool.execute(
        {
          name: "preview-skill",
          version: "1.0.0",
          description: "test",
          content: "A".repeat(300),
        },
        ctx,
      );

      expect(result.content).toContain("preview");
      expect(result.content).toContain("...");
    });
  });

  it("blocks skill creation in read-only mode", async () => {
    const ctx = createToolContext({ readOnly: true });

    const result = await tool.execute(
      {
        name: "blocked-skill",
        version: "1.0.0",
        description: "should be blocked",
        content: "This should not be written.",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Skill creation is blocked in read-only mode");
  });
});
