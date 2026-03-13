import { StradaAnalyzer } from "../../../intelligence/strada-analyzer.js";
import type { IMemoryManager } from "../../../memory/memory.interface.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";

export class AnalyzeProjectTool implements ITool {
  readonly name = "strada_analyze_project";
  readonly description =
    "Analyze the entire Strada.Core Unity project. " +
    "Scans all C# files and returns a structured overview of modules, systems, components, " +
    "services, mediators, controllers, and EventBus usage. " +
    "Use this to understand the project architecture before making changes.";

  readonly inputSchema = {
    type: "object",
    properties: {},
    required: [],
  };

  private readonly memoryManager?: IMemoryManager;

  constructor(memoryManager?: IMemoryManager) {
    this.memoryManager = memoryManager;
  }

  async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    try {
      const analyzer = new StradaAnalyzer(context.projectPath);
      const analysis = await analyzer.analyze();
      const formatted = StradaAnalyzer.formatAnalysis(analysis);

      // Cache analysis in memory for future context injection
      if (this.memoryManager) {
        await this.memoryManager.cacheAnalysis(analysis, context.projectPath);
      }

      return { content: formatted };
    } catch {
      return { content: "Error: could not analyze project", isError: true };
    }
  }
}
