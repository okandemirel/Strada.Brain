/**
 * Mermaid Diagram Renderer
 *
 * Converts GoalTree DAGs and chain visualizations into Mermaid flowchart syntax.
 * Web channel: inline mermaid.js rendering. Other channels: mermaid.ink link.
 */

import type { GoalTree, GoalStatus } from "../goals/types.js";

/** Mermaid status styling */
const STATUS_STYLES: Record<GoalStatus, string> = {
  pending: ":::pending",
  executing: ":::executing",
  completed: ":::completed",
  failed: ":::failed",
  skipped: ":::skipped",
};

const STATUS_LABELS: Record<GoalStatus, string> = {
  pending: "?",
  executing: "~",
  completed: "v",
  failed: "!",
  skipped: "-",
};

/** Shared classDef styles used by all Mermaid diagrams */
const MERMAID_CLASS_DEFS = [
  "  classDef pending fill:#6b7280,stroke:#9ca3af,color:#fff",
  "  classDef executing fill:#3b82f6,stroke:#60a5fa,color:#fff",
  "  classDef completed fill:#22c55e,stroke:#4ade80,color:#fff",
  "  classDef failed fill:#ef4444,stroke:#f87171,color:#fff",
  "  classDef skipped fill:#a855f7,stroke:#c084fc,color:#fff",
];

/**
 * Render a GoalTree as a Mermaid flowchart.
 */
export function renderGoalTreeMermaid(tree: GoalTree): string {
  const lines: string[] = ["flowchart TD", ...MERMAID_CLASS_DEFS];

  const nodes = tree.nodes;

  // Render nodes
  for (const [id, node] of nodes) {
    const label = sanitizeMermaidLabel(node.task);
    const statusIcon = STATUS_LABELS[node.status];
    const style = STATUS_STYLES[node.status];
    lines.push(`  ${id}["[${statusIcon}] ${label}"]${style}`);
  }

  // Render edges (parent -> child)
  for (const [id, node] of nodes) {
    if (node.parentId && nodes.has(node.parentId)) {
      lines.push(`  ${node.parentId} --> ${id}`);
    }

    // Dependency edges (dashed)
    for (const depId of node.dependsOn) {
      if (depId !== node.parentId && nodes.has(depId)) {
        lines.push(`  ${depId} -.-> ${id}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Render a chain/workflow as a Mermaid sequence diagram.
 */
export function renderChainMermaid(
  steps: Array<{ name: string; status: string; duration?: number }>,
): string {
  const lines: string[] = ["flowchart LR"];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const id = `step${i}`;
    const durationLabel = step.duration ? ` (${Math.round(step.duration)}ms)` : "";
    const label = sanitizeMermaidLabel(step.name + durationLabel);
    const styleClass = STATUS_STYLES[step.status as GoalStatus] ?? ":::pending";
    lines.push(`  ${id}["${label}"]${styleClass}`);

    if (i > 0) {
      lines.push(`  step${i - 1} --> ${id}`);
    }
  }

  lines.push(...MERMAID_CLASS_DEFS);

  return lines.join("\n");
}

/**
 * Generate a mermaid.ink URL for rendering in non-web channels.
 */
export function getMermaidInkUrl(mermaidCode: string): string {
  const encoded = Buffer.from(mermaidCode, "utf-8").toString("base64url");
  return `https://mermaid.ink/img/${encoded}`;
}

/**
 * Wrap Mermaid code for inline rendering in the web channel.
 */
export function wrapMermaidForWeb(mermaidCode: string): string {
  return `<div class="mermaid">\n${mermaidCode}\n</div>`;
}

/** Sanitize text for Mermaid labels (escape HTML entities and Mermaid syntax chars) */
function sanitizeMermaidLabel(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/\(/g, "&#40;")
    .replace(/\)/g, "&#41;")
    .replace(/;/g, "&#59;")
    .replace(/\|/g, "&#124;")
    .replace(/[\n\r]/g, " ")
    .slice(0, 60);
}
