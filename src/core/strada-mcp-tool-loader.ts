import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config/config.js";
import { detectStradaMcp, type StradaMcpInstall } from "../config/strada-deps.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import type { ToolCategory as BrainToolCategory, ToolMetadata as BrainToolMetadata } from "./tool-registry.js";
import { getLogger } from "../utils/logger.js";

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

interface StradaMcpResourceLike {
  readonly name?: string;
}

interface StradaMcpPromptLike {
  readonly name?: string;
}

interface BridgeAware {
  setBridgeClient(client: unknown): void;
}

interface StradaMcpBootstrapResult {
  readonly tools?: StradaMcpToolLike[];
  readonly resources?: StradaMcpResourceLike[];
  readonly prompts?: StradaMcpPromptLike[];
  readonly bridgeAwareTools?: BridgeAware[];
  readonly bridgeAwareResources?: BridgeAware[];
  readonly toolContext?: {
    projectPath?: string;
    workingDirectory?: string;
    readOnly?: boolean;
    unityBridgeConnected?: boolean;
    allowedPaths?: string[];
  };
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
  }): StradaMcpBootstrapResult;
}

interface StradaMcpToolRegistryModule {
  ToolRegistry: new () => {
    register(tool: StradaMcpToolLike): void;
  };
}

interface StradaMcpBridgeManagerLike {
  readonly client?: unknown;
  readonly isConnected?: boolean;
  readonly state?: unknown;
  on(event: "stateChange", listener: (state: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  connect(): Promise<void>;
  destroy(): void;
}

interface StradaMcpBridgeManagerModule {
  BridgeManager: {
    fromConfig(config: Record<string, unknown>): StradaMcpBridgeManagerLike;
  };
}

export interface StradaMcpToolLoadResult {
  readonly source: StradaMcpInstall;
  readonly tools: StradaMcpToolLike[];
}

export interface StradaMcpRuntimeStatus {
  readonly installed: boolean;
  readonly sourcePath: string | null;
  readonly version: string | null;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly bridgeConfigured: boolean;
  readonly bridgeConnected: boolean;
  readonly bridgeState: string;
  readonly availableToolCount: number;
  readonly unavailableToolCount: number;
  readonly bridgeUnavailableReason?: string;
  readonly lastError?: string;
}

interface ToolRegistryLike {
  has(name: string): boolean;
  register(tool: ITool, metadata?: Partial<BrainToolMetadata>): void;
}

const STRADA_MCP_PACKAGE_NAME = "strada-mcp";
const DEFAULT_BRIDGE_UNAVAILABLE_REASON = "Requires a live Unity bridge connection.";

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

async function importOptionalFirstAvailable<T>(paths: string[]): Promise<T | null> {
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
    } catch {
      continue;
    }
  }

  return null;
}

function isBridgeAware(value: unknown): value is BridgeAware {
  return typeof value === "object"
    && value !== null
    && "setBridgeClient" in value
    && typeof (value as { setBridgeClient?: unknown }).setBridgeClient === "function";
}

function normalizeBootstrapResult(
  result: StradaMcpBootstrapResult,
  config: Config,
): Required<StradaMcpBootstrapResult> {
  return {
    tools: [...(result.tools ?? [])],
    resources: [...(result.resources ?? [])],
    prompts: [...(result.prompts ?? [])],
    bridgeAwareTools: (result.bridgeAwareTools ?? []).filter(isBridgeAware),
    bridgeAwareResources: (result.bridgeAwareResources ?? []).filter(isBridgeAware),
    toolContext: {
      projectPath: result.toolContext?.projectPath ?? config.unityProjectPath,
      workingDirectory: result.toolContext?.workingDirectory ?? config.unityProjectPath,
      readOnly: result.toolContext?.readOnly ?? config.security.readOnlyMode,
      unityBridgeConnected: result.toolContext?.unityBridgeConnected ?? false,
      allowedPaths: result.toolContext?.allowedPaths ?? [config.unityProjectPath],
    },
  };
}

export class StradaMcpRuntime {
  readonly source: StradaMcpInstall;
  readonly tools: readonly StradaMcpToolLike[];
  readonly resources: readonly StradaMcpResourceLike[];
  readonly prompts: readonly StradaMcpPromptLike[];
  readonly bridgeAwareTools: readonly BridgeAware[];
  readonly bridgeAwareResources: readonly BridgeAware[];

  private readonly toolContext: Required<StradaMcpBootstrapResult>["toolContext"];
  private readonly bridgeConfigured: boolean;
  private readonly registeredBridgeTools = new Set<string>();
  private readonly registeredTools = new Set<string>();
  private metadataMap?: Map<string, BrainToolMetadata>;
  private bridgeManager: StradaMcpBridgeManagerLike | null = null;
  private bridgeConnected = false;
  private bridgeState = "disconnected";
  private bridgeUnavailableReason = DEFAULT_BRIDGE_UNAVAILABLE_REASON;
  private lastError?: string;

  constructor(
    private readonly config: Config,
    source: StradaMcpInstall,
    normalizedBootstrap: Required<StradaMcpBootstrapResult>,
    bridgeManager: StradaMcpBridgeManagerLike | null,
  ) {
    this.source = source;
    this.tools = normalizedBootstrap.tools;
    this.resources = normalizedBootstrap.resources;
    this.prompts = normalizedBootstrap.prompts;
    this.bridgeAwareTools = normalizedBootstrap.bridgeAwareTools;
    this.bridgeAwareResources = normalizedBootstrap.bridgeAwareResources;
    this.toolContext = normalizedBootstrap.toolContext;
    this.bridgeConfigured = Boolean(this.config.strada.unityBridgeAutoConnect);
    this.bridgeManager = bridgeManager;
    this.syncBridgeState(false, this.bridgeConfigured ? "disconnected" : "disabled", this.getInitialBridgeReason());
  }

  async start(): Promise<void> {
    if (!this.bridgeManager) {
      return;
    }

    this.bridgeManager.on("stateChange", (state) => {
      const normalizedState = String(state ?? "unknown");
      const connected = normalizedState.toLowerCase() === "connected"
        || this.bridgeManager?.isConnected === true;
      this.syncBridgeState(connected, normalizedState, connected ? undefined : this.reasonForState(normalizedState));
    });
    this.bridgeManager.on("error", (error) => {
      this.lastError = error.message;
      this.syncBridgeState(false, "error", error.message);
      getLogger().warn("Strada.MCP Unity bridge error", {
        error: error.message,
        sourcePath: this.source.path,
      });
    });

    if (!this.bridgeConfigured) {
      return;
    }

    this.syncBridgeState(false, "connecting", "Connecting to the Unity bridge.");
    try {
      await this.bridgeManager.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.syncBridgeState(false, "error", message);
      getLogger().warn("Failed to connect Strada.MCP Unity bridge", {
        error: message,
        sourcePath: this.source.path,
      });
    }
  }

  shutdown(): void {
    this.bridgeAwareTools.forEach((tool) => tool.setBridgeClient(null));
    this.bridgeAwareResources.forEach((resource) => resource.setBridgeClient(null));
    this.toolContext.unityBridgeConnected = false;
    this.bridgeManager?.destroy();
    this.bridgeManager = null;
  }

  registerTool(name: string, requiresBridge: boolean): void {
    this.registeredTools.add(name);
    if (requiresBridge) {
      this.registeredBridgeTools.add(name);
    }
    this.syncToolMetadata(name);
  }

  bindToolMetadataMap(metadataMap: Map<string, BrainToolMetadata>): void {
    this.metadataMap = metadataMap;
    this.syncAllToolMetadata();
  }

  createToolExecutionContext(context: ToolContext): {
    projectPath: string;
    workingDirectory: string;
    readOnly: boolean;
    unityBridgeConnected: boolean;
    allowedPaths?: string[];
  } {
    return {
      projectPath: context.projectPath,
      workingDirectory: context.workingDirectory,
      readOnly: context.readOnly,
      unityBridgeConnected: this.bridgeConnected,
      allowedPaths: this.toolContext.allowedPaths,
    };
  }

  getToolAvailability(
    metadata: Pick<StradaMcpToolMetadata, "requiresBridge">,
  ): Pick<BrainToolMetadata, "available" | "availabilityReason"> {
    if (!metadata.requiresBridge) {
      return { available: true };
    }

    return {
      available: this.bridgeConnected,
      availabilityReason: this.bridgeConnected ? undefined : this.bridgeUnavailableReason,
    };
  }

  getStatus(): StradaMcpRuntimeStatus {
    const unavailableToolCount = this.tools.filter((tool) => tool.metadata.requiresBridge && !this.bridgeConnected).length;
    return {
      installed: true,
      sourcePath: this.source.path,
      version: this.source.version,
      toolCount: this.tools.length,
      resourceCount: this.resources.length,
      promptCount: this.prompts.length,
      bridgeConfigured: this.bridgeConfigured,
      bridgeConnected: this.bridgeConnected,
      bridgeState: this.bridgeState,
      availableToolCount: this.tools.length - unavailableToolCount,
      unavailableToolCount,
      bridgeUnavailableReason: unavailableToolCount > 0 ? this.bridgeUnavailableReason : undefined,
      lastError: this.lastError,
    };
  }

  private getInitialBridgeReason(): string {
    if (!this.bridgeManager) {
      return "Strada.MCP bridge manager is not available in this installation.";
    }
    if (!this.bridgeConfigured) {
      return "UNITY_BRIDGE_AUTO_CONNECT=false. Bridge-only Unity tools stay unavailable until a bridge is attached.";
    }
    return DEFAULT_BRIDGE_UNAVAILABLE_REASON;
  }

  private reasonForState(state: string): string {
    switch (state.toLowerCase()) {
      case "connecting":
        return "Connecting to the Unity bridge.";
      case "disconnected":
        return DEFAULT_BRIDGE_UNAVAILABLE_REASON;
      case "error":
        return this.lastError ?? "Unity bridge reported an error.";
      default:
        return `Unity bridge state: ${state}.`;
    }
  }

  private syncBridgeState(connected: boolean, state: string, reason?: string): void {
    this.bridgeConnected = connected;
    this.bridgeState = state;
    this.bridgeUnavailableReason = connected ? "" : (reason ?? DEFAULT_BRIDGE_UNAVAILABLE_REASON);
    this.toolContext.unityBridgeConnected = connected;
    const client = connected ? (this.bridgeManager?.client ?? null) : null;
    this.bridgeAwareTools.forEach((tool) => tool.setBridgeClient(client));
    this.bridgeAwareResources.forEach((resource) => resource.setBridgeClient(client));
    this.syncAllToolMetadata();
  }

  private syncAllToolMetadata(): void {
    for (const name of this.registeredTools) {
      this.syncToolMetadata(name);
    }
  }

  private syncToolMetadata(name: string): void {
    const metadata = this.metadataMap?.get(name);
    if (!metadata) {
      return;
    }

    const requiresBridge = this.registeredBridgeTools.has(name) || metadata.requiresBridge === true;
    const availability = requiresBridge
      ? { available: this.bridgeConnected, availabilityReason: this.bridgeConnected ? undefined : this.bridgeUnavailableReason }
      : { available: true, availabilityReason: undefined };

    this.metadataMap?.set(name, {
      ...metadata,
      ...availability,
    });
  }
}

export async function loadInstalledStradaMcpRuntime(config: Config): Promise<StradaMcpRuntime | null> {
  const install = detectStradaMcp(config.strada);
  if (!install.installed || !install.path) {
    return null;
  }

  if (!isTrustedStradaMcpPackageRoot(install.path)) {
    throw new Error(`Refusing to load Strada.MCP from untrusted path: ${install.path}`);
  }

  const [{ bootstrap }, { ToolRegistry }, bridgeModule] = await Promise.all([
    importFirstAvailable<StradaMcpBootstrapModule>(resolveModuleCandidates(install.path, "bootstrap.ts")),
    importFirstAvailable<StradaMcpToolRegistryModule>(resolveModuleCandidates(install.path, "tools/tool-registry.ts")),
    importOptionalFirstAvailable<StradaMcpBridgeManagerModule>(resolveModuleCandidates(install.path, "bridge/bridge-manager.ts")),
  ]);

  const externalToolRegistry = new ToolRegistry();
  const noOpServer = {
    registerTool: (..._args: unknown[]) => { /* no-op */ },
    resource: (..._args: unknown[]) => { /* no-op */ },
    prompt: (..._args: unknown[]) => { /* no-op */ },
  };

  const bootstrapResult = bootstrap({
    config: {
      unityProjectPath: config.unityProjectPath,
      readOnly: config.security.readOnlyMode,
      allowedPaths: config.unityProjectPath,
      scriptExecuteEnabled: config.strada.scriptExecuteEnabled,
      reflectionInvokeEnabled: config.strada.reflectionInvokeEnabled,
      unityBridgePort: config.strada.unityBridgePort,
      unityBridgeAutoConnect: config.strada.unityBridgeAutoConnect,
      unityBridgeTimeout: config.strada.unityBridgeTimeout,
      unityEditorPath: config.strada.unityEditorPath,
      logLevel: config.logLevel,
    },
    server: noOpServer,
    toolRegistry: externalToolRegistry,
    resourceRegistry: { register: (_resource: unknown) => { /* no-op */ } },
    promptRegistry: { register: (_prompt: unknown) => { /* no-op */ } },
  });

  const normalized = normalizeBootstrapResult(bootstrapResult, config);
  const bridgeManager = bridgeModule?.BridgeManager?.fromConfig({
    unityBridgePort: config.strada.unityBridgePort,
    unityBridgeAutoConnect: config.strada.unityBridgeAutoConnect,
    unityBridgeTimeout: config.strada.unityBridgeTimeout,
    logLevel: config.logLevel,
  }) ?? null;

  const runtime = new StradaMcpRuntime(config, install, normalized, bridgeManager);
  await runtime.start();
  return runtime;
}

export async function loadInstalledStradaMcpTools(config: Config): Promise<StradaMcpToolLoadResult | null> {
  const runtime = await loadInstalledStradaMcpRuntime(config);
  if (!runtime) {
    return null;
  }

  return {
    source: runtime.source,
    tools: [...runtime.tools],
  };
}

class StradaMcpToolAdapter implements ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  constructor(
    private readonly tool: StradaMcpToolLike,
    private readonly runtime?: StradaMcpRuntime,
  ) {
    this.name = tool.name;
    this.description = tool.description;
    this.inputSchema = tool.inputSchema;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const result = await this.tool.execute(
      input,
      this.runtime?.createToolExecutionContext(context) ?? {
        projectPath: context.projectPath,
        workingDirectory: context.workingDirectory,
        readOnly: context.readOnly,
        unityBridgeConnected: false,
        allowedPaths: [context.projectPath],
      },
    );

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
  runtime?: StradaMcpRuntime,
): { registered: number; skipped: number } {
  let registered = 0;
  let skipped = 0;

  for (const tool of tools) {
    if (registry.has(tool.name)) {
      skipped++;
      continue;
    }

    registry.register(new StradaMcpToolAdapter(tool, runtime), {
      category: mapCategory(tool.metadata.category),
      dangerous: tool.metadata.dangerous,
      requiresConfirmation: tool.metadata.dangerous && !tool.metadata.readOnly,
      readOnly: tool.metadata.readOnly,
      dependencies: [STRADA_MCP_PACKAGE_NAME],
      requiresBridge: tool.metadata.requiresBridge,
      ...runtime?.getToolAvailability(tool.metadata),
    });
    runtime?.registerTool(tool.name, tool.metadata.requiresBridge);
    registered++;
  }

  return { registered, skipped };
}
