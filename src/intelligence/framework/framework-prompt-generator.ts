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
