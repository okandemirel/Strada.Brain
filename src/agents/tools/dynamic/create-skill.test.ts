import { describe, it, expect } from "vitest";
import { readFile, stat, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CreateSkillTool } from "./create-skill.js";
import { discoverSkills } from "../../../skills/skill-loader.js";
import { SkillManager } from "../../../skills/skill-manager.js";
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
      expect(content).toContain('version: "1.0.0"');
      expect(content).toContain('description: "A test skill"');
      expect(content).toContain('author: "Test Author"');
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

  // Audited 2026-09-02: `version: 1.0` was written unquoted, the frontmatter
  // parser read it back as the NUMBER 1, and discoverSkills skipped the skill
  // at every future boot ("missing or invalid version") while the in-session
  // hot-load coerced it fine — so the tool's promise of persistence was false
  // for any two-segment or bare-integer version.
  it("survives the next boot's discovery when the version looks numeric", async () => {
    await withTempDir(async (dir) => {
      const ctx = createToolContext({ projectPath: dir, workingDirectory: dir });

      for (const [name, version] of [["two-seg", "1.0"], ["bare-int", "2"], ["zero-one", "0.1"]]) {
        const result = await tool.execute(
          { name, version, description: "numeric-looking version", content: "body" },
          ctx,
        );
        expect(result.isError).toBeUndefined();
      }

      const discovered = await discoverSkills(dir);
      const byName = new Map(discovered.map((s) => [s.manifest.name, s]));
      expect(byName.get("two-seg")?.manifest.version).toBe("1.0");
      expect(byName.get("bare-int")?.manifest.version).toBe("2");
      expect(byName.get("zero-one")?.manifest.version).toBe("0.1");
    });
  });
});

/**
 * Audited 2026-09-02: "hot-loaded and available" was claimed from the absence
 * of a throw, but SkillManager.loadSingle never throws — it hands back the
 * entry already held for a colliding name, or one parked as error/gated. The
 * tool must report the loader's verdict, not its own optimism.
 */
describe("CreateSkillTool hot-load verdict", () => {
  const tool = new CreateSkillTool();

  it("says the skill is available only when the loader activated the file just written", async () => {
    await withTempDir(async (dir) => {
      const manager = new SkillManager();
      const ctx = createToolContext({
        projectPath: dir,
        workingDirectory: dir,
        onSkillCreated: (skillPath) => manager.loadSingle(skillPath),
      });

      const result = await tool.execute(
        { name: "fresh-skill", version: "1.0.0", description: "new", content: "# Fresh" },
        ctx,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("hot-loaded and is available");
      expect(manager.getEntries().find((e) => e.manifest.name === "fresh-skill")?.status).toBe("active");
    });
  });

  it("does not claim availability when a skill of that name is already loaded from elsewhere", async () => {
    await withTempDir(async (dir) => {
      // A bundled/managed skill occupies the name; create_skill's exists-check
      // only looks at <projectPath>/skills, so the write goes through.
      const elsewhere = join(dir, "bundled", "collide");
      await mkdir(elsewhere, { recursive: true });
      await writeFile(
        join(elsewhere, "SKILL.md"),
        '---\nname: collide\nversion: "0.0.1"\ndescription: "old"\n---\n\nOLD BODY\n',
      );
      const manager = new SkillManager();
      const preexisting = await manager.loadSingle(elsewhere);
      expect(preexisting?.status).toBe("active");

      const ctx = createToolContext({
        projectPath: dir,
        workingDirectory: dir,
        onSkillCreated: (skillPath) => manager.loadSingle(skillPath),
      });
      const result = await tool.execute(
        { name: "collide", version: "2.0.0", description: "new", content: "NEW BODY" },
        ctx,
      );

      expect(result.content).not.toContain("hot-loaded and is available");
      expect(result.content).toContain("did NOT load this skill");
      expect(result.content).toContain(elsewhere);
      // The session still holds the old entry; the tool must not say otherwise.
      const held = manager.getEntries().find((e) => e.manifest.name === "collide");
      expect(held?.body).toContain("OLD BODY");
    });
  });

  it("reports a loader that returned no entry instead of claiming a hot-load", async () => {
    await withTempDir(async (dir) => {
      const ctx = createToolContext({
        projectPath: dir,
        workingDirectory: dir,
        onSkillCreated: async () => null,
      });

      const result = await tool.execute(
        { name: "unread", version: "1.0.0", description: "new", content: "body" },
        ctx,
      );

      expect(result.content).not.toContain("hot-loaded and is available");
      expect(result.content).toContain("did NOT register the skill");
    });
  });
});
