import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import type { IRAGPipeline } from "../../rag/rag.interface.js";

/**
 * Tool that allows the LLM to trigger RAG indexing.
 *
 * Run without arguments for a full incremental project index.
 * Pass a file_path to re-index a single file after edits.
 */
export class RAGIndexTool implements ITool {
  readonly name = "rag_index";
  readonly description =
    "Index the project codebase for semantic code search. " +
    "Run without arguments for a full project index, or specify a file path for incremental update. " +
    "Indexing is incremental — only changed files are re-embedded.";

  readonly inputSchema = {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "Optional: specific file to re-index (relative path). " +
          "If omitted, indexes the entire project.",
      },
    },
    required: [],
  };

  constructor(private readonly rag: IRAGPipeline) {}

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const filePath = typeof input["file_path"] === "string" ? input["file_path"].trim() : "";

    if (filePath) {
      return this.indexSingleFile(filePath, context);
    }

    return this.indexProject(context);
  }

  private async indexSingleFile(
    filePath: string,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const absolutePath = resolve(context.projectPath, filePath);

    let content: string;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      return {
        content: `Error: file not found or unreadable: ${filePath}`,
        isError: true,
      };
    }

    try {
      const chunksIndexed = await this.rag.indexFile(absolutePath, content);

      if (chunksIndexed === 0) {
        return {
          content: `Skipped: no changes detected in ${filePath}`,
        };
      }

      return {
        content: `Indexed ${chunksIndexed} chunk(s) from ${filePath}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: failed to index ${filePath}: ${message}`,
        isError: true,
      };
    }
  }

  private async indexProject(context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const stats = await this.rag.indexProject(context.projectPath);

      const changed =
        stats.changedFiles !== undefined ? ` (${stats.changedFiles} changed)` : "";
      const duration = (stats.durationMs / 1000).toFixed(1);

      return {
        content:
          `Indexed project: ${stats.totalFiles} file(s)${changed}, ` +
          `${stats.totalChunks} chunk(s) in ${duration}s`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: project indexing failed: ${message}`,
        isError: true,
      };
    }
  }
}
