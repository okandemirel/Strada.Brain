import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import type { IRAGPipeline, SearchOptions } from "../../rag/rag.interface.js";
import { isCodeChunk } from "../../rag/rag.interface.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 15;
const MIN_LIMIT = 1;

/**
 * Tool that exposes semantic (vector) code search to the LLM.
 *
 * Unlike grep, this understands intent and concept — "damage calculation logic"
 * will surface relevant methods even if the words don't appear literally.
 */
export class CodeSearchTool implements ITool {
  readonly name = "code_search";
  readonly description =
    "Search the codebase using natural language. Unlike grep (literal text matching), " +
    "this uses semantic understanding to find relevant code. Examples: " +
    "'damage calculation logic', 'systems that use PhysicsComponent', " +
    "'how modules are registered'. Use grep_search for exact text; " +
    "use code_search for conceptual queries.";

  readonly inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language description of what you're looking for",
      },
      kind: {
        type: "string",
        enum: ["class", "struct", "method", "constructor", "file_header"],
        description: "Optional: filter by code structure type",
      },
      file_pattern: {
        type: "string",
        description: "Optional: glob pattern to restrict search (e.g., '**/Combat/**')",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default: 8, max: 15)",
      },
    },
    required: ["query"],
  };

  constructor(private readonly rag: IRAGPipeline) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = String(input["query"] ?? "");
    if (!query) {
      return { content: "Error: 'query' is required", isError: true };
    }

    const rawLimit = input["limit"];
    const limit = Math.min(
      Math.max(typeof rawLimit === "number" ? Math.floor(rawLimit) : DEFAULT_LIMIT, MIN_LIMIT),
      MAX_LIMIT
    );

    const kind = input["kind"] as SearchOptions["kinds"] extends (infer K)[] ? K : never | undefined;
    const filePattern = typeof input["file_pattern"] === "string" ? input["file_pattern"] : undefined;

    const options: SearchOptions = {
      topK: limit,
      ...(kind !== undefined && { kinds: [kind as "class" | "struct" | "method" | "constructor" | "file_header"] }),
      ...(filePattern !== undefined && { filePattern }),
    };

    try {
      const results = await this.rag.search(query, options);

      if (results.length === 0) {
        return {
          content: `No results found for: "${query}"`,
        };
      }

      const lines: string[] = [`Found ${results.length} result(s) for: "${query}"\n`];

      for (const result of results) {
        const { chunk, finalScore } = result;
        const score = (finalScore * 100).toFixed(1);
        const kindLabel = chunk.kind.toUpperCase();
        
        // Use type guard to safely access CodeChunk-specific properties
        const symbol = isCodeChunk(chunk) && chunk.symbol ? ` — ${chunk.symbol}` : "";
        const namespace = isCodeChunk(chunk) && chunk.namespace ? ` [${chunk.namespace}]` : "";
        const lineRange = isCodeChunk(chunk) ? `L${chunk.startLine}–${chunk.endLine}` : "";

        lines.push(`### [${kindLabel}] ${chunk.filePath}${lineRange ? ":" + lineRange : ""}${symbol}${namespace} (${score}% match)`);
        lines.push("```");
        lines.push(chunk.content);
        lines.push("```");
        lines.push("");
      }

      return { content: lines.join("\n") };
    } catch {
      return { content: "Error: code search failed", isError: true };
    }
  }
}
