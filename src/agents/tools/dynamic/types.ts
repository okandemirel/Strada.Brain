/**
 * The shape a model-authored skill is created from.
 *
 * The tool-creation types that used to live beside this — DynamicToolSpec,
 * DynamicToolRecord, CompositeStep, DynamicToolStrategy — described runtime
 * tools the model could invent for itself, backed by a full shell. That
 * machinery is gone: it produced a writer that corrupted five .asmdef files and
 * reported success on all five. A skill is a SKILL.md on disk, not an
 * executable, which is why this one stays.
 */

export interface DynamicSkillSpec {
  /** Skill name (used as directory name). */
  name: string;
  /** Semantic version string. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** SKILL.md body content (markdown). */
  content: string;
  /** Optional author attribution. */
  author?: string;
  /** Optional capability tags. */
  capabilities?: string[];
}

/** Tracks metadata for a dynamically registered tool. */
