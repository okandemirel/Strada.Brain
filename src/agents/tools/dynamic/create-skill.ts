// ---------------------------------------------------------------------------
// create_skill — Create a persistent SKILL.md on disk for future sessions.
// ---------------------------------------------------------------------------

import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import type { DynamicSkillSpec } from "./types.js";

export class CreateSkillTool implements ITool {
  readonly name = "create_skill";
  readonly description =
    "Create a new skill (SKILL.md) in the workspace skills directory. " +
    "The skill will be available in future sessions after restart. " +
    "Use this to persist specialized knowledge or instructions.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Skill name (lowercase, alphanumeric with hyphens). Used as the directory name.",
      },
      version: {
        type: "string",
        description: "Semantic version (e.g. '1.0.0').",
      },
      description: {
        type: "string",
        description: "What this skill provides.",
      },
      content: {
        type: "string",
        description:
          "The skill's body content (markdown). This is the knowledge/instructions " +
          "that will be available when the skill is loaded.",
      },
      author: {
        type: "string",
        description: "Optional author name.",
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "Optional capability tags.",
      },
    },
    required: ["name", "version", "description", "content"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // Block in read-only mode — skill creation writes to disk
    if (context.readOnly) {
      return {
        content: "Skill creation is blocked in read-only mode (writes to disk).",
        isError: true,
      };
    }

    const spec: DynamicSkillSpec = {
      name: String(input["name"] ?? "").trim(),
      version: String(input["version"] ?? "1.0.0").trim(),
      description: String(input["description"] ?? "").trim(),
      content: String(input["content"] ?? "").trim(),
      author: input["author"] as string | undefined,
      capabilities: input["capabilities"] as string[] | undefined,
    };

    // Validate
    if (!spec.name) {
      return { content: "Error: skill name is required.", isError: true };
    }
    if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) {
      return {
        content: "Error: skill name must start with a letter and contain only [a-z0-9-].",
        isError: true,
      };
    }
    if (!spec.description) {
      return { content: "Error: skill description is required.", isError: true };
    }
    if (!spec.content) {
      return { content: "Error: skill content is required.", isError: true };
    }
    if (spec.content.length > 50_000) {
      return { content: "Error: skill content exceeds 50,000 character limit.", isError: true };
    }

    // Build SKILL.md content
    const frontmatterLines = [
      "---",
      `name: ${spec.name}`,
      `version: ${spec.version}`,
      `description: ${spec.description}`,
    ];
    if (spec.author) frontmatterLines.push(`author: ${spec.author}`);
    if (spec.capabilities?.length) {
      frontmatterLines.push(`capabilities: [${spec.capabilities.join(", ")}]`);
    }
    frontmatterLines.push("---");

    const skillMd = frontmatterLines.join("\n") + "\n\n" + spec.content + "\n";

    // Determine skills directory — workspace level with path traversal guard
    const safeBase = resolve(context.projectPath, "skills");
    const skillsDir = resolve(safeBase, spec.name);
    if (!skillsDir.startsWith(safeBase + sep) && skillsDir !== safeBase) {
      return { content: "Error: path traversal detected.", isError: true };
    }
    const filePath = join(skillsDir, "SKILL.md");

    // Check if skill already exists
    const exists = await access(filePath).then(() => true, () => false);
    if (exists) {
      return {
        content: `Skill '${spec.name}' already exists at ${filePath}. Remove it first to replace.`,
        isError: true,
      };
    }

    try {
      await mkdir(skillsDir, { recursive: true });
      await writeFile(filePath, skillMd, "utf-8");
    } catch (err) {
      return {
        content: `Failed to write skill: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // Hot-reload: make the skill available in the current session
    let hotReloaded = false;
    if (context.onSkillCreated) {
      try {
        await context.onSkillCreated(skillsDir);
        hotReloaded = true;
      } catch {
        // Non-fatal — skill is on disk and will load next session
      }
    }

    const preview = spec.content.length > 200
      ? spec.content.slice(0, 200) + "..."
      : spec.content;

    return {
      content:
        `Skill '${spec.name}' created at ${filePath}\n\n` +
        (hotReloaded
          ? `The skill has been hot-loaded and is available in the current session.\n\n`
          : `This skill will be discovered automatically in future sessions.\n\n`) +
        `Skill content preview (first 200 chars):\n${preview}`,
    };
  }
}
