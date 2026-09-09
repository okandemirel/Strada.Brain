// ---------------------------------------------------------------------------
// What the tool schemas cost per turn, measured. 2026-09-09 14:12: 59 tools,
// 29 863 chars on every worker turn, and nothing said which tools carried it.
// ---------------------------------------------------------------------------

export interface ToolSchemaSize {
  readonly name: string;
  readonly chars: number;
}

export interface ToolSchemaBudget {
  readonly tools: number;
  readonly totalChars: number;
  /** Largest first, at most `top`. */
  readonly largest: readonly ToolSchemaSize[];
  /** Share of totalChars carried by `largest`, 0-1. */
  readonly largestShare: number;
}

/** JSON length of one definition as the provider sees it. */
export function toolSchemaChars(definition: { name: string; description: string; input_schema: unknown }): number {
  return JSON.stringify({ name: definition.name, description: definition.description, input_schema: definition.input_schema }).length;
}

export function summarizeToolSchemaSizes(
  definitions: ReadonlyArray<{ name: string; description: string; input_schema: unknown }>,
  top = 10,
): ToolSchemaBudget {
  const sizes = definitions.map((d) => ({ name: d.name, chars: toolSchemaChars(d) }));
  const totalChars = sizes.reduce((sum, s) => sum + s.chars, 0);
  const largest = [...sizes].sort((a, b) => b.chars - a.chars).slice(0, top);
  const largestChars = largest.reduce((sum, s) => sum + s.chars, 0);
  return {
    tools: sizes.length,
    totalChars,
    largest,
    largestShare: totalChars > 0 ? largestChars / totalChars : 0,
  };
}
