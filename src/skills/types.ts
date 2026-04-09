// ---------------------------------------------------------------------------
// Skill ecosystem type definitions
// ---------------------------------------------------------------------------

/** External requirements a skill declares in its SKILL.md frontmatter. */
export interface SkillRequirements {
  /** Required binaries that must exist in PATH. */
  bins?: string[];
  /** Required environment variables. */
  env?: string[];
  /** Required config keys (dot-path notation, e.g. "llm.apiKey"). */
  config?: string[];
  /** Other skills this skill depends on (by name). */
  skills?: string[];
}

/** Parsed manifest from a SKILL.md frontmatter block. */
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  requires?: SkillRequirements;
  capabilities?: string[];
}

/** Runtime status of a loaded skill. */
export type SkillStatus = "active" | "disabled" | "gated" | "error" | "incomplete";

/** A fully-resolved skill entry held by the SkillLoader. */
export interface SkillEntry {
  manifest: SkillManifest;
  status: SkillStatus;
  tier: "workspace" | "managed" | "bundled" | "extra";
  path: string;
  /** Present when status is "gated" — explains why the skill cannot activate. */
  gateReason?: string;
  /** Markdown body content from SKILL.md — knowledge/instructions for the agent. */
  body?: string;
}

/** One entry in the remote skill registry index. */
export interface RegistryEntry {
  repo: string;
  description: string;
  tags: string[];
  version: string;
  tag?: string;
  author?: string;
}

/** Top-level shape of the remote skill registry JSON. */
export interface SkillRegistry {
  version: number;
  skills: Record<string, RegistryEntry>;
}

/** Per-skill user configuration (persisted in skills.json or equivalent). */
export interface SkillConfig {
  entries: Record<
    string,
    {
      enabled: boolean;
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    }
  >;
}
