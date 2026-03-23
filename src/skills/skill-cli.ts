// ---------------------------------------------------------------------------
// CLI commands for the skill ecosystem.
//
// Registers `strada skill <subcommand>` under the Commander program.
// ---------------------------------------------------------------------------

import type { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat, rm, readFile } from "node:fs/promises";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { discoverSkills } from "./skill-loader.js";
import { checkGates } from "./skill-gating.js";
import { readSkillConfig, writeSkillConfig, setSkillEnabled } from "./skill-config.js";
import { parseFrontmatter } from "./frontmatter-parser.js";
import { fetchRegistry, searchRegistry } from "./skill-registry-client.js";
// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Manage skills (install, remove, enable, disable, list, update, search, info)");

  // =========================================================================
  // skill install <url>
  // =========================================================================

  skill
    .command("install <url>")
    .description("Install a skill from a git repository URL")
    .action(async (url: string) => {
      // Verify git is available
      const gitCheck = await execFileNoThrow("git", ["--version"]);
      if (gitCheck.exitCode !== 0) {
        console.error("Error: git is not installed or not in PATH.");
        process.exitCode = 1;
        return;
      }

      // Derive skill name from URL (last path segment, sans .git).
      // Sanitize to prevent path traversal: allow only alphanumeric, hyphens,
      // underscores, and dots — no slashes or ".." components.
      const segments = url.replace(/\.git$/, "").split("/");
      const rawName = segments[segments.length - 1] ?? "unknown-skill";
      const repoName = rawName.replace(/[^a-zA-Z0-9._-]/g, "").replace(/^\.+$/, "unknown-skill") || "unknown-skill";

      const targetDir = join(homedir(), ".strada", "skills", repoName);

      // Check if already installed
      try {
        const s = await stat(targetDir);
        if (s.isDirectory()) {
          console.error(`Skill directory already exists: ${targetDir}`);
          console.error("Use 'strada skill update' to update, or remove first.");
          process.exitCode = 1;
          return;
        }
      } catch {
        // Does not exist — good
      }

      console.log(`Cloning ${url} into ${targetDir}...`);
      const result = await execFileNoThrow("git", ["clone", url, targetDir], 60_000);
      if (result.exitCode !== 0) {
        console.error(`Git clone failed (exit ${result.exitCode}):`);
        console.error(result.stderr || result.stdout);
        process.exitCode = 1;
        return;
      }

      // Validate SKILL.md exists
      try {
        await stat(join(targetDir, "SKILL.md"));
      } catch {
        console.error("Warning: Cloned repo does not contain a SKILL.md — it may not be a valid skill.");
      }

      // Enable by default in config
      await setSkillEnabled(repoName, true);
      console.log(`Skill "${repoName}" installed and enabled.`);
    });

  // =========================================================================
  // skill remove <name>
  // =========================================================================

  skill
    .command("remove <name>")
    .description("Remove an installed skill by name")
    .action(async (name: string) => {
      // Sanitize name to prevent path traversal attacks.
      if (!/^[a-zA-Z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
        console.error(`Invalid skill name: "${name}". Only alphanumeric, hyphen, underscore, and dot are allowed.`);
        process.exitCode = 1;
        return;
      }
      const skillDir = join(homedir(), ".strada", "skills", name);

      try {
        const s = await stat(skillDir);
        if (!s.isDirectory()) {
          console.error(`Not a directory: ${skillDir}`);
          process.exitCode = 1;
          return;
        }
      } catch {
        console.error(`Skill "${name}" not found at ${skillDir}`);
        process.exitCode = 1;
        return;
      }

      // Check if other skills depend on this one
      const config = await readSkillConfig();
      const discovered = await discoverSkills();
      const dependents = discovered.filter((s) =>
        s.manifest.requires?.skills?.includes(name),
      );
      if (dependents.length > 0) {
        const depNames = dependents.map((d) => d.manifest.name).join(", ");
        console.error(`Cannot remove "${name}": depended on by: ${depNames}`);
        process.exitCode = 1;
        return;
      }

      await rm(skillDir, { recursive: true, force: true });

      // Remove from config
      if (config.entries[name]) {
        delete config.entries[name];
        await writeSkillConfig(config);
      }

      console.log(`Skill "${name}" removed.`);
    });

  // =========================================================================
  // skill enable <name>
  // =========================================================================

  skill
    .command("enable <name>")
    .description("Enable a disabled skill")
    .action(async (name: string) => {
      const discovered = await discoverSkills();
      const found = discovered.find((s) => s.manifest.name === name);
      if (!found) {
        console.error(`Skill "${name}" not found. Run 'strada skill list' to see available skills.`);
        process.exitCode = 1;
        return;
      }
      await setSkillEnabled(name, true);
      console.log(`Skill '${name}' enabled. Restart to apply.`);
    });

  // =========================================================================
  // skill disable <name>
  // =========================================================================

  skill
    .command("disable <name>")
    .description("Disable a skill without removing it")
    .action(async (name: string) => {
      const discovered = await discoverSkills();
      const found = discovered.find((s) => s.manifest.name === name);
      if (!found) {
        console.error(`Skill "${name}" not found. Run 'strada skill list' to see available skills.`);
        process.exitCode = 1;
        return;
      }
      await setSkillEnabled(name, false);
      console.log(`Skill '${name}' disabled. Restart to apply.`);
    });

  // =========================================================================
  // skill list
  // =========================================================================

  skill
    .command("list")
    .description("List all discovered skills with status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const config = await readSkillConfig();
      const discovered = await discoverSkills();

      const rows: Array<{
        name: string;
        version: string;
        tier: string;
        status: string;
        gateReason?: string;
      }> = [];

      for (const skill of discovered) {
        const { name } = skill.manifest;
        let status = "active";
        let gateReason: string | undefined;

        if (config.entries[name]?.enabled === false) {
          status = "disabled";
        } else {
          const gate = await checkGates(skill.manifest.requires);
          if (!gate.passed) {
            status = "gated";
            gateReason = gate.reasons.join("; ");
          }
        }

        rows.push({
          name,
          version: skill.manifest.version,
          tier: skill.tier,
          status,
          ...(gateReason ? { gateReason } : {}),
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No skills discovered.");
        return;
      }

      // Print table
      console.log("");
      console.log(
        padRight("Name", 25) +
          padRight("Version", 12) +
          padRight("Tier", 12) +
          padRight("Status", 12) +
          "Reason",
      );
      console.log("-".repeat(75));
      for (const row of rows) {
        console.log(
          padRight(row.name, 25) +
            padRight(row.version, 12) +
            padRight(row.tier, 12) +
            padRight(row.status, 12) +
            (row.gateReason ?? ""),
        );
      }
      console.log("");
    });

  // =========================================================================
  // skill update [name]
  // =========================================================================

  skill
    .command("update [name]")
    .description("Update an installed skill (or all managed skills)")
    .action(async (name?: string) => {
      const gitCheck = await execFileNoThrow("git", ["--version"]);
      if (gitCheck.exitCode !== 0) {
        console.error("Error: git is not installed or not in PATH.");
        process.exitCode = 1;
        return;
      }

      const managedDir = join(homedir(), ".strada", "skills");

      if (name) {
        // Sanitize name to prevent path traversal attacks.
        if (!/^[a-zA-Z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
          console.error(`Invalid skill name: "${name}". Only alphanumeric, hyphen, underscore, and dot are allowed.`);
          process.exitCode = 1;
          return;
        }
        // Update specific skill
        const skillDir = join(managedDir, name);
        const result = await updateSkillDir(skillDir, name);
        if (!result) {
          process.exitCode = 1;
        }
      } else {
        // Update all managed skills
        const discovered = await discoverSkills();
        const managed = discovered.filter((s) => s.tier === "managed");
        if (managed.length === 0) {
          console.log("No managed skills to update.");
          return;
        }
        for (const skill of managed) {
          await updateSkillDir(skill.path, skill.manifest.name);
        }
      }
    });

  // =========================================================================
  // skill search <query>
  // =========================================================================

  skill
    .command("search <query>")
    .description("Search the remote skill registry")
    .action(async (query: string) => {
      console.log("Fetching skill registry...");
      const registry = await fetchRegistry();
      const results = searchRegistry(registry, query);

      if (results.length === 0) {
        console.log(`No skills found matching "${query}".`);
        return;
      }

      console.log(`\nFound ${results.length} skill(s) matching "${query}":\n`);
      for (const [name, entry] of results) {
        console.log(`  ${name} (v${entry.version})`);
        console.log(`    ${entry.description}`);
        console.log(`    repo: ${entry.repo}`);
        if (entry.tags.length > 0) {
          console.log(`    tags: ${entry.tags.join(", ")}`);
        }
        console.log("");
      }
    });

  // =========================================================================
  // skill info <name>
  // =========================================================================

  skill
    .command("info <name>")
    .description("Show detailed info about a discovered skill")
    .action(async (name: string) => {
      const discovered = await discoverSkills();
      const skill = discovered.find((s) => s.manifest.name === name);

      if (!skill) {
        console.error(`Skill "${name}" not found. Run 'strada skill list' to see available skills.`);
        process.exitCode = 1;
        return;
      }

      const config = await readSkillConfig();
      const gate = await checkGates(skill.manifest.requires);
      const enabled = config.entries[name]?.enabled !== false;

      console.log(`\nSkill: ${skill.manifest.name}`);
      console.log(`Version: ${skill.manifest.version}`);
      console.log(`Description: ${skill.manifest.description}`);
      if (skill.manifest.author) console.log(`Author: ${skill.manifest.author}`);
      if (skill.manifest.homepage) console.log(`Homepage: ${skill.manifest.homepage}`);
      console.log(`Tier: ${skill.tier}`);
      console.log(`Path: ${skill.path}`);
      console.log(`Enabled: ${enabled}`);
      console.log(`Gates: ${gate.passed ? "passed" : "FAILED"}`);
      if (!gate.passed) {
        for (const reason of gate.reasons) {
          console.log(`  - ${reason}`);
        }
      }
      if (skill.manifest.capabilities?.length) {
        console.log(`Capabilities: ${skill.manifest.capabilities.join(", ")}`);
      }
      if (skill.manifest.requires) {
        const req = skill.manifest.requires;
        if (req.bins?.length) console.log(`Requires bins: ${req.bins.join(", ")}`);
        if (req.env?.length) console.log(`Requires env: ${req.env.join(", ")}`);
        if (req.config?.length) console.log(`Requires config: ${req.config.join(", ")}`);
        if (req.skills?.length) console.log(`Requires skills: ${req.skills.join(", ")}`);
      }

      // Print SKILL.md body content
      try {
        const raw = await readFile(join(skill.path, "SKILL.md"), "utf-8");
        const { content } = parseFrontmatter(raw);
        const body = content.trim();
        if (body) {
          console.log(`\n${body}`);
        }
      } catch {
        // No SKILL.md body
      }

      console.log("");
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str.length >= len ? str + " " : str + " ".repeat(len - str.length);
}

async function updateSkillDir(skillDir: string, name: string): Promise<boolean> {
  try {
    await stat(skillDir);
  } catch {
    console.error(`Skill "${name}" not found at ${skillDir}`);
    return false;
  }

  console.log(`Updating "${name}"...`);
  const result = await execFileNoThrow("git", ["-C", skillDir, "pull"], 60_000);
  if (result.exitCode !== 0) {
    console.error(`  Failed to update "${name}": ${result.stderr || result.stdout}`);
    return false;
  }

  const output = result.stdout.trim();
  console.log(`  ${output.includes("Already up to date") ? "Already up to date." : "Updated."}`);
  return true;
}
