import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config/config.js";
import { detectStradaMcp, type StradaMcpInstall } from "../config/strada-deps.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import type { ToolCategory as BrainToolCategory, ToolMetadata as BrainToolMetadata } from "./tool-registry.js";

interface StradaMcpToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: {
    readonly executionTimeMs?: number;
    readonly filesAffected?: string[];
  };
}

interface StradaMcpToolMetadata {
  readonly category:
    | "strada"
    | "unity-runtime"
    | "unity-scene"
    | "unity-asset"
    | "unity-subsystem"
    | "unity-config"
    | "file"
    | "search"
    | "git"
    | "dotnet"
    | "analysis"
    | "advanced";
  readonly requiresBridge: boolean;
  readonly dangerous: boolean;
  readonly readOnly: boolean;
}

interface StradaMcpToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly metadata: StradaMcpToolMetadata;
  execute(
    input: Record<string, unknown>,
    context: {
      projectPath: string;
      workingDirectory: string;
      readOnly: boolean;
      unityBridgeConnected: boolean;
      allowedPaths?: string[];
    },
  ): Promise<StradaMcpToolResult>;
}

interface StradaMcpBootstrapModule {
  bootstrap(options: {
    config: Record<string, unknown>;
    server: {
      registerTool: (...args: unknown[]) => void;
      resource: (...args: unknown[]) => void;
      prompt: (...args: unknown[]) => void;
    };
    toolRegistry: { register(tool: StradaMcpToolLike): void };
    resourceRegistry: { register(resource: unknown): void };
    promptRegistry: { register(prompt: unknown): void };
  }): {
    tools: StradaMcpToolLike[];
  };
}

interface StradaMcpToolRegistryModule {
  ToolRegistry: new () => {
    register(tool: StradaMcpToolLike): void;
  };
}

export interface StradaMcpToolLoadResult {
  readonly source: StradaMcpInstall;
  readonly tools: StradaMcpToolLike[];
}

interface ToolRegistryLike {
  has(name: string): boolean;
  register(tool: ITool, metadata?: Partial<BrainToolMetadata>): void;
}

const STRADA_MCP_PACKAGE_NAME = "strada-mcp";

function mapCategory(category: StradaMcpToolMetadata["category"]): BrainToolCategory {
  switch (category) {
    case "file":
      return "file";
    case "search":
      return "search";
    case "git":
      return "git";
    case "dotnet":
      return "dotnet";
    case "strada":
      return "strada";
    case "analysis":
      return "code";
    default:
      return "custom";
  }
}

function isTrustedStradaMcpPackageRoot(pkgRoot: string): boolean {
  const packageJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return parsed.name === STRADA_MCP_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function resolveModuleCandidates(pkgRoot: string, relativePath: string): string[] {
  return [
    join(pkgRoot, "src", relativePath.replace(/\.js$/u, ".ts")),
    join(pkgRoot, "dist", relativePath.replace(/\.ts$/u, ".js")),
  ];
}

async function importFirstAvailable<T>(paths: string[]): Promise<T> {
  let lastError: unknown;

  for (const candidate of paths) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      if (candidate.endsWith(".ts")) {
        const { tsImport } = await import("tsx/esm/api");
        return await tsImport(candidate, import.meta.url) as T;
      }
      return await import(pathToFileURL(candidate).href) as T;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`No loadable module found. Tried: ${paths.join(", ")}`);
}

export async function loadInstalledStradaMcpTools(config: Config): Promise<StradaMcpToolLoadResult | null> {
  const install = detectStradaMcp(config.strada);
  if (!install.installed || !install.path) {
    return null;
  }

  if (!isTrustedStradaMcpPackageRoot(install.path)) {
    throw new Error(`Refusing to load Strada.MCP from untrusted path: ${install.path}`);
  }

  const [{ bootstrap }, { ToolRegistry }] = await Promise.all([
    importFirstAvailable<StradaMcpBootstrapModule>(resolveModuleCandidates(install.path, "bootstrap.ts")),
    importFirstAvailable<StradaMcpToolRegistryModule>(resolveModuleCandidates(install.path, "tools/tool-registry.ts")),
  ]);

  const externalToolRegistry = new ToolRegistry();
  const noOpServer = {
    registerTool: (..._args: unknown[]) => { /* no-op */ },
    resource: (..._args: unknown[]) => { /* no-op */ },
    prompt: (..._args: unknown[]) => { /* no-op */ },
  };

  const result = bootstrap({
    config: {
      unityProjectPath: config.unityProjectPath,
      readOnly: config.security.readOnlyMode,
      allowedPaths: config.unityProjectPath,
      scriptExecuteEnabled: false,
      reflectionInvokeEnabled: false,
    },
    server: noOpServer,
    toolRegistry: externalToolRegistry,
    resourceRegistry: { register: (_resource: unknown) => { /* no-op */ } },
    promptRegistry: { register: (_prompt: unknown) => { /* no-op */ } },
  });

  return {
    source: install,
    tools: result.tools,
  };
}

class StradaMcpToolAdapter implements ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  constructor(private readonly tool: StradaMcpToolLike) {
    this.name = tool.name;
    this.description = tool.description;
    this.inputSchema = tool.inputSchema;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const result = await this.tool.execute(input, {
      projectPath: context.projectPath,
      workingDirectory: context.workingDirectory,
      readOnly: context.readOnly,
      unityBridgeConnected: false,
      allowedPaths: [context.projectPath],
    });

    return {
      content: result.content,
      isError: result.isError,
      metadata: {
        executionTimeMs: result.metadata?.executionTimeMs,
        filesAffected: result.metadata?.filesAffected,
      },
    };
  }
}

export function registerStradaMcpTools(
  registry: ToolRegistryLike,
  tools: readonly StradaMcpToolLike[],
): { registered: number; skipped: number } {
  let registered = 0;
  let skipped = 0;

  for (const tool of tools) {
    if (registry.has(tool.name)) {
      skipped++;
      continue;
    }

    registry.register(new StradaMcpToolAdapter(tool), {
      category: mapCategory(tool.metadata.category),
      dangerous: tool.metadata.dangerous,
      requiresConfirmation: tool.metadata.dangerous && !tool.metadata.readOnly,
      readOnly: tool.metadata.readOnly,
      dependencies: [STRADA_MCP_PACKAGE_NAME],
      requiresBridge: tool.metadata.requiresBridge,
    });
    registered++;
  }

  return { registered, skipped };
}
