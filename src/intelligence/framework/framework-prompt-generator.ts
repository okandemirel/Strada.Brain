/**
 * Framework Prompt Generator
 *
 * Generates system prompt sections from live FrameworkKnowledgeStore data.
 * Replaces hardcoded framework knowledge sections in STRADA_SYSTEM_PROMPT.
 * Falls back to null when no live data is available (caller uses static fallback).
 */

import type { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import type { FrameworkAPISnapshot } from "./framework-types.js";

export class FrameworkPromptGenerator {
  private cachedSection: string | null | undefined = undefined;

  constructor(private readonly store: FrameworkKnowledgeStore) {}

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

    this.cachedSection = sections.length === 0 ? null : sections.join("\n\n");
    return this.cachedSection;
  }

  private buildCoreSection(snapshot: FrameworkAPISnapshot): string {
    const lines: string[] = [
      `## Strada.Core Framework Knowledge (live — v${snapshot.version ?? "unknown"}, ${snapshot.fileCount} files)`,
      "",
    ];

    // Namespaces
    if (snapshot.namespaces.length > 0) {
      lines.push("### Namespaces");
      for (const ns of snapshot.namespaces) {
        lines.push(`- \`${ns}\``);
      }
      lines.push("");
    }

    // Base classes (abstract)
    const abstractClasses = snapshot.classes.filter((c) => c.isAbstract);
    if (abstractClasses.length > 0) {
      lines.push("### Base Classes (abstract)");
      for (const cls of abstractClasses) {
        lines.push(`- \`${cls.name}\` (${cls.namespace})`);
      }
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
      for (const [ns, names] of [...byNamespace].sort((a, b) => a[0].localeCompare(b[0]))) {
        const shown = names.slice(0, 40);
        const rest = names.length - shown.length;
        lines.push(`- \`${ns}\`: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
      }
      lines.push("");
    }


    // Key interfaces
    if (snapshot.interfaces.length > 0) {
      lines.push("### Interfaces");
      for (const iface of snapshot.interfaces.slice(0, 30)) {
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
      for (const en of snapshot.enums.slice(0, 20)) {
        lines.push(
          `- \`${en.name}\` (${en.namespace}): ${en.values.slice(0, 8).join(", ")}${en.values.length > 8 ? ", ..." : ""}`,
        );
      }
      lines.push("");
    }

    // Structs (components)
    if (snapshot.structs.length > 0) {
      lines.push("### Structs");
      for (const st of snapshot.structs.slice(0, 20)) {
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
      for (const ns of snapshot.namespaces) {
        lines.push(`- \`${ns}\``);
      }
      lines.push("");
    }

    if (snapshot.classes.length > 0) {
      lines.push("### Classes");
      for (const cls of snapshot.classes.slice(0, 30)) {
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
      for (const iface of snapshot.interfaces.slice(0, 20)) {
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
      lines.push("### MCP Tools");
      for (const tool of snapshot.tools) {
        lines.push(`- **${tool.name}**: ${tool.description}`);
        if (tool.inputSchemaKeys.length > 0) {
          lines.push(
            `  - Params: ${tool.inputSchemaKeys.join(", ")}`,
          );
        }
      }
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
      for (const cls of snapshot.classes.slice(0, 20)) {
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
