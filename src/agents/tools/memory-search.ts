import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";

/**
 * Tool that allows the AI to search its persistent memory.
 *
 * The AI can use this to recall previous conversations, project analysis results,
 * and stored notes. This enables long-term context beyond the session window.
 */
export class MemorySearchTool implements ITool {
  readonly name = "memory_search";
  readonly description =
    "Search your persistent memory for relevant context from past conversations, " +
    "project analysis, and stored notes. Use this to recall previous discussions, " +
    "decisions, and project knowledge that may have been trimmed from the current session.";

  readonly inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Text query to search for (e.g., 'combat system design', 'DI registration pattern', " +
          "'previous module creation')",
      },
      type: {
        type: "string",
        enum: ["conversation", "analysis", "note"],
        description: "Optional: filter by memory type",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default: 5, max: 10)",
      },
    },
    required: ["query"],
  };

  private readonly memory: IMemoryManager;

  constructor(memory: IMemoryManager) {
    this.memory = memory;
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = String(input["query"] ?? "");
    if (!query) {
      return { content: "Error: 'query' is required", isError: true };
    }

    const type = input["type"] as "conversation" | "analysis" | "note" | undefined;
    const rawLimit = input["limit"];
    const limit = Math.min(Math.max(typeof rawLimit === "number" ? rawLimit : 5, 1), 10);

    try {
      const results = await this.memory.retrieve(query, {
        type,
        limit,
        minScore: 0.1,
      });

      if (results.length === 0) {
        const stats = this.memory.getStats();
        return {
          content: `No relevant memories found for: "${query}"\n\n` +
            `Memory stats: ${stats.totalEntries} total entries ` +
            `(${stats.conversationCount} conversations, ${stats.noteCount} notes)`,
        };
      }

      const lines = results.map((r, i) => {
        const entry = r.entry;
        const score = (r.score * 100).toFixed(1);
        const date = entry.createdAt.toISOString().split("T")[0];
        const typeLabel = entry.type.toUpperCase();
        const chatLabel = entry.chatId ? ` [chat: ${entry.chatId}]` : "";
        const tags = entry.tags.length > 0 ? ` tags: ${entry.tags.join(", ")}` : "";
        const preview = entry.content.length > 300
          ? entry.content.substring(0, 300) + "..."
          : entry.content;

        return `${i + 1}. [${typeLabel}] (${score}% match, ${date}${chatLabel}${tags})\n${preview}`;
      });

      return {
        content: `Found ${results.length} relevant memory(s):\n\n${lines.join("\n\n")}`,
      };
    } catch {
      return { content: "Error: memory search failed", isError: true };
    }
  }
}
