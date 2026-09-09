/**
 * Framework Prompt Generator
 *
 * Generates system prompt sections from live FrameworkKnowledgeStore data.
 * Replaces hardcoded framework knowledge sections in STRADA_SYSTEM_PROMPT.
 * Falls back to null when no live data is available (caller uses static fallback).
 */

import type { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";

/**
 * Cap on the framework knowledge section, in chars. Measured 2026-09-09 on the
 * user's project: the section was 21 715 chars (7 088 of them "Classes by
 * namespace") inside a 72k-char system prompt, on every turn of every worker —
 * including a node whose whole job was one unity_delivery_measure call — and
 * the free-tier model stopped answering 57k-token turns. Floor 2 000; unset =
 * 12 000. Trimming keeps every subsection and halves the list lengths.
 */
export const FRAMEWORK_PROMPT_MAX_CHARS: number = (() => {
  const raw = Math.floor(Number(process.env["FRAMEWORK_PROMPT_MAX_CHARS"]));
  return Number.isFinite(raw) && raw >= 2_000 ? raw : 12_000;
})();

const DENSITIES = [1, 0.5, 0.25, 0.125] as const;

export class FrameworkPromptGenerator {
  private cachedSection: string | null | undefined = undefined;
  private readonly maxChars: number;
  /** How the list lengths were scaled to fit maxChars (1 = untrimmed). */
  private density = 1;
  private lastTrim: { density: number; untrimmedChars: number; chars: number } | null = null;

  constructor(private readonly store: FrameworkKnowledgeStore, options?: { maxChars?: number }) {
    this.maxChars = options?.maxChars ?? FRAMEWORK_PROMPT_MAX_CHARS;
  }

  /** The trim applied to the cached section, or null when it fit untrimmed. */
  getLastTrim(): { density: number; untrimmedChars: number; chars: number } | null {
    return this.lastTrim;
  }

  /** A list length under the current density (never below 3). */
  private limit(n: number): number {
    return Math.max(3, Math.round(n * this.density));
  }

  /** Invalidate cached prompt section (call after sync) */
  invalidateCache(): void {
    this.cachedSection = undefined;
  }

  /**
   * Generate the complete framework knowledge section.
   * Returns null if no live data is available (caller should use static fallback).
   * Result is cached until invalidateCache() is called.
   */
  buildFrameworkKnowledgeSection(): string | null {
    if (this.cachedSection !== undefined) return this.cachedSection;
    let untrimmed: string | null = null;
    let chosen: string | null = null;
    for (const density of DENSITIES) {
      this.density = density;
      chosen = this.buildAtCurrentDensity();
      if (untrimmed === null) untrimmed = chosen;
      if (chosen === null || chosen.length <= this.maxChars) break;
    }
    this.lastTrim =
      chosen !== null && untrimmed !== null && this.density < 1
        ? { density: this.density, untrimmedChars: untrimmed.length, chars: chosen.length }
        : null;
    this.cachedSection = chosen;
    return this.cachedSection;
  }

  private buildAtCurrentDensity(): string | null {
    const sections: string[] = [];

    const coreSnapshot = this.store.getLatestSnapshot("core");
    if (coreSnapshot) {
      sections.push(this.buildCoreSection(coreSnapshot));
    }

    const modulesSnapshot = this.store.getLatestSnapshot("modules");
    if (modulesSnapshot) {
      sections.push(this.buildModulesSection(modulesSnapshot));
    }

    const mcpSnapshot = this.store.getLatestSnapshot("mcp");
    if (mcpSnapshot) {
      sections.push(this.buildMCPSection(mcpSnapshot));
    }

    const generatorDirective = mcpSnapshot ? buildGeneratorPreference(mcpSnapshot) : null;
    if (generatorDirective) {
      sections.push(generatorDirective);
    }

    return sections.length === 0 ? null : sections.join("\n\n");
  }

  private buildCoreSection(snapshot: FrameworkAPISnapshot): string {
    const lines: string[] = [
      `## Strada.Core Framework Knowledge (live — v${snapshot.version ?? "unknown"}, ${snapshot.fileCount} files)`,
      "",
    ];

    // Namespaces
    if (snapshot.namespaces.length > 0) {
      lines.push("### Namespaces");
      const shownNs = snapshot.namespaces.slice(0, this.limit(60));
      for (const ns of shownNs) {
        lines.push(`- \`${ns}\``);
      }
      if (snapshot.namespaces.length > shownNs.length) lines.push(`- ... and ${snapshot.namespaces.length - shownNs.length} more`);
      lines.push("");
    }

    // Base classes (abstract)
    const abstractClasses = snapshot.classes.filter((c) => c.isAbstract);
    if (abstractClasses.length > 0) {
      lines.push("### Base Classes (abstract)");
      const shownAbstract = abstractClasses.slice(0, this.limit(40));
      for (const cls of shownAbstract) {
        lines.push(`- \`${cls.name}\` (${cls.namespace})`);
      }
      if (abstractClasses.length > shownAbstract.length) lines.push(`- ... and ${abstractClasses.length - shownAbstract.length} more`);
      lines.push("");
    }

    // Concrete classes, grouped by namespace.
    //
    // The extractor captures every public type; this section used to render
    // only the abstract ones, so 306 of Strada.Core's 355 classes reached
    // nobody. ViewRegistry, ViewSyncRunner and StradaLog were among them —
    // exactly the names a plan needs in order to put something on screen or to
    // log without reaching for Debug.Log. Names and namespaces only: a plan
    // needs to know what exists, and can read the source for signatures.
    const concrete = snapshot.classes.filter((c) => !c.isAbstract);
    if (concrete.length > 0) {
      const byNamespace = new Map<string, string[]>();
      for (const cls of concrete) {
        const bucket = byNamespace.get(cls.namespace) ?? [];
        bucket.push(cls.name);
        byNamespace.set(cls.namespace, bucket);
      }
      lines.push("### Classes by namespace");
      const buckets = [...byNamespace].sort((a, b) => a[0].localeCompare(b[0]));
      const shownBuckets = buckets.slice(0, this.limit(30));
      for (const [ns, names] of shownBuckets) {
        const shown = names.slice(0, this.limit(40));
        const rest = names.length - shown.length;
        lines.push(`- \`${ns}\`: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
      }
      if (buckets.length > shownBuckets.length) lines.push(`- ... and ${buckets.length - shownBuckets.length} more namespaces`);
      lines.push("");
    }


    // Key interfaces
    if (snapshot.interfaces.length > 0) {
      lines.push("### Interfaces");
      for (const iface of snapshot.interfaces.slice(0, this.limit(30))) {
        const methods =
          iface.methods.length > 0
            ? ` — ${iface.methods.join(", ")}`
            : "";
        lines.push(`- \`${iface.name}\` (${iface.namespace})${methods}`);
      }
      if (snapshot.interfaces.length > 30) {
        lines.push(
          `- ... and ${snapshot.interfaces.length - 30} more`,
        );
      }
      lines.push("");
    }

    // Enums
    if (snapshot.enums.length > 0) {
      lines.push("### Enums");
      for (const en of snapshot.enums.slice(0, this.limit(20))) {
        lines.push(
          `- \`${en.name}\` (${en.namespace}): ${en.values.slice(0, this.limit(8)).join(", ")}${en.values.length > 8 ? ", ..." : ""}`,
        );
      }
      lines.push("");
    }

    // Structs (components)
    if (snapshot.structs.length > 0) {
      lines.push("### Structs");
      for (const st of snapshot.structs.slice(0, this.limit(20))) {
        lines.push(`- \`${st.name}\` (${st.namespace})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private buildModulesSection(snapshot: FrameworkAPISnapshot): string {
    const lines: string[] = [
      `## Strada.Modules Knowledge (live — v${snapshot.version ?? "unknown"}, ${snapshot.fileCount} files)`,
      "",
    ];

    if (snapshot.namespaces.length > 0) {
      lines.push("### Namespaces");
      const shownNs = snapshot.namespaces.slice(0, this.limit(60));
      for (const ns of shownNs) {
        lines.push(`- \`${ns}\``);
      }
      if (snapshot.namespaces.length > shownNs.length) lines.push(`- ... and ${snapshot.namespaces.length - shownNs.length} more`);
      lines.push("");
    }

    if (snapshot.classes.length > 0) {
      lines.push("### Classes");
      for (const cls of snapshot.classes.slice(0, this.limit(30))) {
        const base =
          cls.baseTypes.length > 0 ? ` : ${cls.baseTypes[0]}` : "";
        lines.push(`- \`${cls.name}\`${base} (${cls.namespace})`);
      }
      if (snapshot.classes.length > 30) {
        lines.push(
          `- ... and ${snapshot.classes.length - 30} more`,
        );
      }
      lines.push("");
    }

    if (snapshot.interfaces.length > 0) {
      lines.push("### Interfaces");
      for (const iface of snapshot.interfaces.slice(0, this.limit(20))) {
        lines.push(`- \`${iface.name}\` (${iface.namespace})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private buildMCPSection(snapshot: FrameworkAPISnapshot): string {
    const lines: string[] = [
      `## Strada.MCP Knowledge (live — v${snapshot.version ?? "unknown"}, ${snapshot.fileCount} files)`,
      "",
    ];

    if (snapshot.tools.length > 0) {
      // Names only. Measured 2026-09-08 04:54: this section listed every tool
      // with its description and parameter names — 10 156 of the framework
      // section's 30 338 chars, on every turn — while the same tools were in
      // the request as full schemas (71k chars for 104 tools). The catalog is
      // for knowing what exists; the schema is where the model reads how to
      // call it.
      lines.push("### MCP Tools");
      // Measured 2026-09-08 05:43: five calls to unity_instantiate_prefab, each
      // answered "Requires a live Unity bridge connection" — a name read here
      // while the bridge was down and the tool absent from the request.
      lines.push(
        `${snapshot.tools.length} tools known to the framework: ` +
          snapshot.tools.map((tool) => tool.name).join(", ") +
          ". Only the tools in THIS request's tool list can be called. A name here that is not in " +
          "your tool list is not callable in this turn — it needs a live Unity Editor bridge, or the " +
          "current phase allows read-only tools only; when writing is allowed, the file-based tools " +
          "(unity_place_prefab, unity_bind_sprite, unity_scene_build) do the same jobs without a bridge.",
      );
      lines.push("");
    }

    if (snapshot.resources.length > 0) {
      lines.push("### MCP Resources");
      for (const res of snapshot.resources) {
        lines.push(
          `- **${res.name}** (\`${res.uri}\`): ${res.description}`,
        );
      }
      lines.push("");
    }

    if (snapshot.prompts.length > 0) {
      lines.push("### MCP Prompts");
      for (const prompt of snapshot.prompts) {
        lines.push(`- **${prompt.name}**: ${prompt.description}`);
      }
      lines.push("");
    }

    if (snapshot.classes.length > 0) {
      lines.push("### Classes");
      for (const cls of snapshot.classes.slice(0, this.limit(20))) {
        lines.push(`- \`${cls.name}\``);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

/** Tools whose whole purpose is producing framework-shaped code. */
const GENERATOR_TOOL_RE = /^strada_(create|scaffold)_/;

/**
 * States the preference the knowledge section only implied.
 *
 * The MCP section already lists every generator with its description and
 * parameter names — including `moduleName`, which is exactly the argument an
 * agent got wrong by sending `name` and had its call rejected. What was missing
 * is any statement that these tools are the RIGHT way to create Strada-shaped
 * code. Measured: a greenfield task with Strada.Core and Strada.Modules
 * installed produced 19 hand-written files in a Modules/<Name>Module layout
 * that looks like the framework's, references none of its APIs, and never
 * called a generator.
 *
 * Deliberately scoped: emitted only when the framework is actually installed
 * (this whole section is), and only lists generators that really exist in the
 * live snapshot, so it can never advertise a tool the agent cannot call.
 */
function buildGeneratorPreference(snapshot: FrameworkAPISnapshot): string | null {
  const generators = snapshot.tools
    .filter((tool) => GENERATOR_TOOL_RE.test(tool.name))
    .map((tool) => tool.name);
  if (generators.length === 0) return null;

  return [
    "## Creating Strada Code",
    "",
    "This project has Strada installed. To create a new module, component, mediator or system, call the generator rather than writing the files by hand:",
    ...generators.map((name) => `- \`${name}\``),
    "",
    "They produce the layout, base classes and registration the framework expects; hand-written files reproduce the folder shape but not the contracts.",
    "Use their exact parameter names as listed above — a mismatched argument is rejected, and inside a batch the rejection is easy to miss.",
    "Write files by hand only for code that is genuinely outside the framework's patterns.",
  ].join("\n");
}
