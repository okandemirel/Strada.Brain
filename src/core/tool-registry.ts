/**
 * Tool Registry with Auto-Discovery
 * 
 * Provides:
 * - Automatic tool discovery via metadata
 * - Manual tool registration
 * - Tool categories and filtering
 * - Plugin tool loading
 */

import type { Config } from "../config/config.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import { PluginLoader } from "../agents/plugins/plugin-loader.js";
import { getLogger } from "../utils/logger.js";
import { ValidationError } from "../common/errors.js";

// Tool category metadata
export const ToolCategories = {
  FILE: "file",
  CODE: "code",
  SEARCH: "search",
  STRATA: "strata",
  SHELL: "shell",
  GIT: "git",
  DOTNET: "dotnet",
  MEMORY: "memory",
  BROWSER: "browser",
  COMPOSITE: "composite",
} as const;

export type ToolCategory = (typeof ToolCategories)[keyof typeof ToolCategories];

// Tool metadata decorator
export interface ToolMetadata {
  name: string;
  description: string;
  category: ToolCategory;
  dangerous: boolean;
  requiresConfirmation: boolean;
  readOnly: boolean;
  dependencies?: string[];
}

// ============================================================================
// Built-in Tool Imports
// ============================================================================

// File operations
import { FileReadTool } from "../agents/tools/file-read.js";
import { FileWriteTool } from "../agents/tools/file-write.js";
import { FileEditTool } from "../agents/tools/file-edit.js";
import {
  FileDeleteTool,
  FileRenameTool,
  FileDeleteDirectoryTool,
} from "../agents/tools/file-manage.js";

// Search operations
import {
  GlobSearchTool,
  GrepSearchTool,
  ListDirectoryTool,
} from "../agents/tools/search.js";

// Strata-specific tools
import { AnalyzeProjectTool } from "../agents/tools/strata/analyze-project.js";
import { ModuleCreateTool } from "../agents/tools/strata/module-create.js";
import { ComponentCreateTool } from "../agents/tools/strata/component-create.js";
import { MediatorCreateTool } from "../agents/tools/strata/mediator-create.js";
import { SystemCreateTool } from "../agents/tools/strata/system-create.js";

// Code quality and search
import { CodeQualityTool } from "../agents/tools/code-quality.js";
import { CodeSearchTool } from "../agents/tools/code-search.js";
import { RAGIndexTool } from "../agents/tools/rag-index.js";

// Shell and git
import { ShellExecTool } from "../agents/tools/shell-exec.js";
import {
  GitStatusTool,
  GitDiffTool,
  GitLogTool,
  GitCommitTool,
  GitBranchTool,
  GitPushTool,
  GitStashTool,
} from "../agents/tools/git-tools.js";

// .NET tools
import { DotnetBuildTool, DotnetTestTool } from "../agents/tools/dotnet-tools.js";

// Memory tools
import { MemorySearchTool } from "../agents/tools/memory-search.js";

// ============================================================================
// Tool Registry
// ============================================================================

export interface ToolRegistryOptions {
  memoryManager?: IMemoryManager;
  ragPipeline?: IRAGPipeline;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ITool>();
  private readonly metadata = new Map<string, ToolMetadata>();
  private readonly categories = new Map<ToolCategory, Set<string>>();
  private readonly pluginLoader?: PluginLoader;
  private initialized = false;

  constructor(pluginDirs?: string[]) {
    if (pluginDirs && pluginDirs.length > 0) {
      this.pluginLoader = new PluginLoader(pluginDirs);
    }
  }

  /**
   * Initialize the registry with all tools
   */
  async initialize(_config: Config, options: ToolRegistryOptions = {}): Promise<void> {
    if (this.initialized) {
      return;
    }

    const logger = getLogger();
    logger.info("Initializing tool registry...");

    // Register built-in tools
    this.registerBuiltinTools(options);

    // Load plugin tools
    if (this.pluginLoader) {
      try {
        const pluginTools = await this.pluginLoader.loadAll();
        for (const tool of pluginTools) {
          this.register(tool, { category: "code", dangerous: false, readOnly: true });
        }
        logger.info(`Loaded ${pluginTools.length} plugin tools`);
      } catch (error) {
        logger.warn("Failed to load plugin tools", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.initialized = true;
    logger.info(`Tool registry initialized with ${this.tools.size} tools`);
  }

  /**
   * Register a tool manually
   */
  register(tool: ITool, metadata?: Partial<ToolMetadata>): void {
    if (this.tools.has(tool.name)) {
      throw new ValidationError(`Tool '${tool.name}' is already registered`);
    }

    this.tools.set(tool.name, tool);

    if (metadata) {
      const fullMetadata: ToolMetadata = {
        name: tool.name,
        description: tool.description,
        category: metadata.category ?? "code",
        dangerous: metadata.dangerous ?? false,
        requiresConfirmation: metadata.requiresConfirmation ?? false,
        readOnly: metadata.readOnly ?? true,
        dependencies: metadata.dependencies,
      };
      this.metadata.set(tool.name, fullMetadata);

      // Add to category index
      const categoryTools = this.categories.get(fullMetadata.category);
      if (categoryTools) {
        categoryTools.add(tool.name);
      } else {
        this.categories.set(fullMetadata.category, new Set([tool.name]));
      }
    }
  }

  /**
   * Register or update a tool. If the tool already exists, removes the old
   * entry first (including category index) then re-registers.
   * Used by chain synthesis to update composite tools without throwing.
   */
  registerOrUpdate(tool: ITool, metadata?: Partial<ToolMetadata>): void {
    if (this.tools.has(tool.name)) {
      this.unregister(tool.name);
    }
    this.register(tool, metadata);
  }

  /**
   * Unregister a tool by name. Returns true if the tool was found and removed,
   * false if it was not registered.
   */
  unregister(name: string): boolean {
    if (!this.tools.has(name)) return false;

    // Remove from category index
    const meta = this.metadata.get(name);
    if (meta) {
      const categorySet = this.categories.get(meta.category);
      if (categorySet) {
        categorySet.delete(name);
      }
    }

    // Remove from maps
    this.tools.delete(name);
    this.metadata.delete(name);
    return true;
  }

  /**
   * Get a tool by name
   */
  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): ITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: ToolCategory): ITool[] {
    const toolNames = this.categories.get(category);
    if (!toolNames) return [];
    return Array.from(toolNames)
      .map((name) => this.tools.get(name))
      .filter((t): t is ITool => t !== undefined);
  }

  /**
   * Get dangerous tools (that require confirmation)
   */
  getDangerousTools(): ITool[] {
    return this.getAllTools().filter((tool) => {
      const meta = this.metadata.get(tool.name);
      return meta?.dangerous ?? false;
    });
  }

  /**
   * Get read-only tools (safe for read-only mode)
   */
  getReadOnlyTools(): ITool[] {
    return this.getAllTools().filter((tool) => {
      const meta = this.metadata.get(tool.name);
      return meta?.readOnly ?? true;
    });
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get tool metadata
   */
  getMetadata(name: string): ToolMetadata | undefined {
    return this.metadata.get(name);
  }

  /**
   * Get all tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool count
   */
  get count(): number {
    return this.tools.size;
  }

  /**
   * Create a filtered registry with only specified tools
   */
  createFiltered(allowedNames: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const name of allowedNames) {
      const tool = this.tools.get(name);
      const meta = this.metadata.get(name);
      if (tool) {
        filtered.register(tool, meta);
      }
    }
    return filtered;
  }

  /**
   * Execute a tool by name (convenience method)
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Error: Tool '${name}' not found`,
        isError: true,
      };
    }
    return tool.execute(input, context);
  }

  /**
   * Clear all tools (useful for testing)
   */
  clear(): void {
    this.tools.clear();
    this.metadata.clear();
    this.categories.clear();
    this.initialized = false;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private registerBuiltinTools(options: ToolRegistryOptions): void {
    const { memoryManager, ragPipeline } = options;

    // File operations
    this.register(new FileReadTool(), {
      category: ToolCategories.FILE,
      dangerous: false,
      readOnly: true,
    });

    this.register(new FileWriteTool(), {
      category: ToolCategories.FILE,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new FileEditTool(), {
      category: ToolCategories.FILE,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new FileDeleteTool(), {
      category: ToolCategories.FILE,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new FileRenameTool(), {
      category: ToolCategories.FILE,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new FileDeleteDirectoryTool(), {
      category: ToolCategories.FILE,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    // Search operations
    this.register(new GlobSearchTool(), {
      category: ToolCategories.SEARCH,
      dangerous: false,
      readOnly: true,
    });

    this.register(new GrepSearchTool(), {
      category: ToolCategories.SEARCH,
      dangerous: false,
      readOnly: true,
    });

    this.register(new ListDirectoryTool(), {
      category: ToolCategories.SEARCH,
      dangerous: false,
      readOnly: true,
    });

    // Strata-specific
    this.register(new AnalyzeProjectTool(memoryManager), {
      category: ToolCategories.STRATA,
      dangerous: false,
      readOnly: true,
    });

    this.register(new ModuleCreateTool(), {
      category: ToolCategories.STRATA,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new ComponentCreateTool(), {
      category: ToolCategories.STRATA,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new MediatorCreateTool(), {
      category: ToolCategories.STRATA,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new SystemCreateTool(), {
      category: ToolCategories.STRATA,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    // Code quality
    this.register(new CodeQualityTool(), {
      category: ToolCategories.CODE,
      dangerous: false,
      readOnly: true,
    });

    // Shell operations
    this.register(new ShellExecTool(), {
      category: ToolCategories.SHELL,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    // Git operations
    this.register(new GitStatusTool(), {
      category: ToolCategories.GIT,
      dangerous: false,
      readOnly: true,
    });

    this.register(new GitDiffTool(), {
      category: ToolCategories.GIT,
      dangerous: false,
      readOnly: true,
    });

    this.register(new GitLogTool(), {
      category: ToolCategories.GIT,
      dangerous: false,
      readOnly: true,
    });

    this.register(new GitCommitTool(), {
      category: ToolCategories.GIT,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new GitBranchTool(), {
      category: ToolCategories.GIT,
      dangerous: false,
      readOnly: true,
    });

    this.register(new GitPushTool(), {
      category: ToolCategories.GIT,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    this.register(new GitStashTool(), {
      category: ToolCategories.GIT,
      dangerous: true,
      requiresConfirmation: true,
      readOnly: false,
    });

    // .NET operations
    this.register(new DotnetBuildTool(), {
      category: ToolCategories.DOTNET,
      dangerous: false,
      readOnly: true,
    });

    this.register(new DotnetTestTool(), {
      category: ToolCategories.DOTNET,
      dangerous: false,
      readOnly: true,
    });

    // Memory operations
    if (memoryManager) {
      this.register(new MemorySearchTool(memoryManager), {
        category: ToolCategories.MEMORY,
        dangerous: false,
        readOnly: true,
      });
    }

    // RAG operations
    if (ragPipeline) {
      this.register(new CodeSearchTool(ragPipeline), {
        category: ToolCategories.SEARCH,
        dangerous: false,
        readOnly: true,
      });

      this.register(new RAGIndexTool(ragPipeline), {
        category: ToolCategories.SEARCH,
        dangerous: false,
        readOnly: false,
      });
    }
  }
}

// ============================================================================
// Static Tool Lists (for type-safe references)
// ============================================================================

export const FileTools = {
  READ: "file_read",
  WRITE: "file_write",
  EDIT: "file_edit",
  DELETE: "file_delete",
  RENAME: "file_rename",
  DELETE_DIR: "file_delete_directory",
} as const;

export const SearchTools = {
  GLOB: "glob_search",
  GREP: "grep_search",
  LIST_DIR: "list_directory",
  CODE_SEARCH: "code_search",
  MEMORY_SEARCH: "memory_search",
} as const;

export const StrataTools = {
  ANALYZE_PROJECT: "analyze_project",
  CREATE_MODULE: "create_module",
  CREATE_COMPONENT: "create_component",
  CREATE_MEDIATOR: "create_mediator",
  CREATE_SYSTEM: "create_system",
} as const;

export const GitTools = {
  STATUS: "git_status",
  DIFF: "git_diff",
  LOG: "git_log",
  COMMIT: "git_commit",
  BRANCH: "git_branch",
  PUSH: "git_push",
  STASH: "git_stash",
} as const;

export const DotnetTools = {
  BUILD: "dotnet_build",
  TEST: "dotnet_test",
} as const;

export const ShellTools = {
  EXEC: "shell_exec",
} as const;
