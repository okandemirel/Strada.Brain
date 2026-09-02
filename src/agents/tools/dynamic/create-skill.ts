// ---------------------------------------------------------------------------
// create_skill — Create a persistent SKILL.md on disk for future sessions.
// ---------------------------------------------------------------------------

import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import type { DynamicSkillSpec } from "./types.js";

/**
 * Emit a frontmatter scalar as a double-quoted string the parser reads back
 * verbatim (it strips one pair of outer quotes and does no escape handling),
 * so quotes are dropped and newlines folded rather than escaped.
 */
function quoteScalar(value: string): string {
  return `"${value.replace(/"/g, "").replace(/\r?\n/g, " ")}"`;
}

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

    // Build SKILL.md content.
    // Audited 2026-09-02: `version: 1.0` written bare is read back by the
    // frontmatter parser as the NUMBER 1, and discoverSkills then skipped the
    // skill at every future boot ("missing or invalid version") while the
    // in-session hot-load coerced it and reported success. Quote every free-
    // text scalar so the parser returns the string that was given; a newline
    // in one would break the line-based fence, so it is folded to a space.
    const frontmatterLines = [
      "---",
      `name: ${spec.name}`,
      `version: ${quoteScalar(spec.version)}`,
      `description: ${quoteScalar(spec.description)}`,
    ];
    if (spec.author) frontmatterLines.push(`author: ${quoteScalar(spec.author)}`);
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

    // Hot-reload: make the skill available in the current session.
    // Audited 2026-09-02: "hot-loaded and available" was claimed from the mere
    // absence of a throw, but loadSingle never throws — it returns the entry
    // already held for that name (a bundled "web-search" collision loads
    // nothing new), an entry parked as error/gated, or null. Report what the
    // loader actually holds, and say "available" only for an active entry
    // loaded from the directory just written.
    let hotLoadOutcome = "This skill will be discovered automatically in future sessions.";
    if (context.onSkillCreated) {
      try {
        const entry = await context.onSkillCreated(skillsDir);
        if (entry === null) {
          hotLoadOutcome =
            "Hot-load did NOT register the skill: the loader could not read the SKILL.md just written. " +
            "It is on disk and discovery will retry at the next session start.";
        } else if (resolve(entry.path) !== skillsDir) {
          hotLoadOutcome =
            `Hot-load did NOT load this skill: a skill named '${spec.name}' is already loaded from ${entry.path} ` +
            `(status: ${entry.status}) and the session keeps that one. The new file is on disk only — ` +
            "choose another name, or remove the existing skill first.";
        } else if (entry.status === "active") {
          hotLoadOutcome = "The skill has been hot-loaded and is available in the current session.";
        } else {
          hotLoadOutcome =
            `Hot-load registered the skill with status '${entry.status}'` +
            `${entry.gateReason ? ` (${entry.gateReason})` : ""} — it is NOT available in this session.`;
        }
      } catch (err) {
        hotLoadOutcome =
          `Hot-load failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "The skill is on disk and discovery will retry at the next session start.";
      }
    }

    const preview = spec.content.length > 200
      ? spec.content.slice(0, 200) + "..."
      : spec.content;

    return {
      content:
        `Skill '${spec.name}' created at ${filePath}\n\n` +
        `${hotLoadOutcome}\n\n` +
        `Skill content preview (first 200 chars):\n${preview}`,
    };
  }
}
