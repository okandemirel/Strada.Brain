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
  readonly requiredBridgeMethods?: readonly string[];
  readonly requiredBridgeCapabilities?: readonly string[];
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

interface EditorRouterAware {
  setEditorRouter(router: unknown): void;
}

interface StradaMcpBootstrapResult {
  readonly tools?: StradaMcpToolLike[];
  readonly resources?: StradaMcpResourceLike[];
  readonly prompts?: StradaMcpPromptLike[];
  readonly bridgeAwareTools?: BridgeAware[];
  readonly bridgeAwareResources?: BridgeAware[];
  readonly editorRouterAwareTools?: EditorRouterAware[];
  readonly toolContext?: {
    projectPath?: string;
    workingDirectory?: string;
    readOnly?: boolean;
    unityBridgeConnected?: boolean;
    allowedPaths?: string[];
  };
}

interface StradaMcpToolContext {
  projectPath: string;
  workingDirectory: string;
  readOnly: boolean;
  unityBridgeConnected: boolean;
  allowedPaths?: string[];
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

interface StradaMcpUnityEditorRouteStatus {
  readonly connected?: boolean;
  readonly connectionState?: string;
  readonly activePort?: number | null;
  readonly activeInstance?: {
    readonly instanceId?: string;
    readonly projectName?: string;
    readonly projectPath?: string;
  } | null;
  readonly selectionSource?: string | null;
  readonly warnings?: string[];
  readonly discoveredCount?: number;
}

interface StradaMcpUnityEditorRouterLike {
  initialize(): Promise<StradaMcpUnityEditorRouteStatus | void>;
  getStatus(options?: { includeDiscovered?: boolean }): StradaMcpUnityEditorRouteStatus;
  getBridgeClient?(): unknown;
  destroy(): void;
}

interface StradaMcpBridgeCapabilities {
  readonly manifestVersion?: number;
  readonly bridgeVersion?: string;
  readonly protocolVersion?: string;
  readonly source?: string;
  readonly supportedMethods?: readonly string[];
  readonly supportedFeatures?: readonly string[];
}

interface StradaMcpCapabilityAwareBridgeClientLike {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  getCapabilities?(): Promise<StradaMcpBridgeCapabilities>;
  ensureCapabilities?(forceRefresh?: boolean): Promise<StradaMcpBridgeCapabilities>;
}

interface StradaMcpUnityEditorRouterModule {
  UnityEditorRouter: new (options: {
    projectPath: string;
    preferredPort: number;
    preferredInstanceId?: string;
    discoveryEnabled: boolean;
    staleAfterMs: number;
    autoConnect: boolean;
    timeoutMs: number;
    logLevel?: "debug" | "info" | "warn" | "error";
    logger: {
      debug(message: string, meta?: Record<string, unknown>): void;
      info(message: string, meta?: Record<string, unknown>): void;
      warn(message: string, meta?: Record<string, unknown>): void;
      error(message: string, meta?: Record<string, unknown>): void;
      child(_component: string): unknown;
    };
    toolContext: {
      projectPath: string;
      workingDirectory: string;
      readOnly: boolean;
      unityBridgeConnected: boolean;
      allowedPaths?: string[];
    };
    bridgeAwareTools: BridgeAware[];
    bridgeAwareResources: BridgeAware[];
    editorRouterAwareTools?: EditorRouterAware[];
  }) => StradaMcpUnityEditorRouterLike;
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
  readonly activeEditorPort?: number | null;
  readonly activeEditorInstanceId?: string | null;
  readonly activeEditorProjectName?: string | null;
  readonly editorSelectionSource?: string | null;
  readonly editorDiscoveryCount?: number;
  readonly bridgeUnavailableReason?: string;
  readonly lastError?: string;
  readonly bridgeProtocolVersion?: string;
  readonly bridgeCapabilityMethodCount?: number;
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

function isEditorRouterAware(value: unknown): value is EditorRouterAware {
  return typeof value === "object"
    && value !== null
    && "setEditorRouter" in value
    && typeof (value as { setEditorRouter?: unknown }).setEditorRouter === "function";
}

function normalizeBootstrapResult(
  result: StradaMcpBootstrapResult,
  config: Config,
): Omit<Required<StradaMcpBootstrapResult>, "toolContext"> & { toolContext: StradaMcpToolContext } {
  return {
    tools: [...(result.tools ?? [])],
    resources: [...(result.resources ?? [])],
    prompts: [...(result.prompts ?? [])],
    bridgeAwareTools: (result.bridgeAwareTools ?? []).filter(isBridgeAware),
    bridgeAwareResources: (result.bridgeAwareResources ?? []).filter(isBridgeAware),
    editorRouterAwareTools: (result.editorRouterAwareTools ?? []).filter(isEditorRouterAware),
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
  readonly editorRouterAwareTools: readonly EditorRouterAware[];

  private readonly toolContext: StradaMcpToolContext;
  private readonly bridgeConfigured: boolean;
  private readonly registeredBridgeTools = new Set<string>();
  private readonly registeredTools = new Set<string>();
  private readonly registeredToolRequirements = new Map<string, {
    readonly requiredBridgeMethods: readonly string[];
    readonly requiredBridgeCapabilities: readonly string[];
  }>();
  private metadataMap?: Map<string, BrainToolMetadata>;
  private bridgeManager: StradaMcpBridgeManagerLike | null = null;
  private unityEditorRouter: StradaMcpUnityEditorRouterLike | null = null;
  private bridgeConnected = false;
  private bridgeState = "disconnected";
  private bridgeUnavailableReason = DEFAULT_BRIDGE_UNAVAILABLE_REASON;
  private activeEditorPort: number | null = null;
  private activeEditorInstanceId: string | null = null;
  private activeEditorProjectName: string | null = null;
  private editorSelectionSource: string | null = null;
  private editorDiscoveryCount = 0;
  private bridgeCapabilities: StradaMcpBridgeCapabilities | null = null;
  private lastError?: string;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(
    private readonly config: Config,
    source: StradaMcpInstall,
    normalizedBootstrap: Omit<Required<StradaMcpBootstrapResult>, "toolContext"> & { toolContext: StradaMcpToolContext },
    unityEditorRouter: StradaMcpUnityEditorRouterLike | null,
    bridgeManager: StradaMcpBridgeManagerLike | null,
  ) {
    this.source = source;
    this.tools = normalizedBootstrap.tools;
    this.resources = normalizedBootstrap.resources;
    this.prompts = normalizedBootstrap.prompts;
    this.bridgeAwareTools = normalizedBootstrap.bridgeAwareTools;
    this.bridgeAwareResources = normalizedBootstrap.bridgeAwareResources;
    this.editorRouterAwareTools = normalizedBootstrap.editorRouterAwareTools;
    this.toolContext = normalizedBootstrap.toolContext;
    this.bridgeConfigured = Boolean(this.config.strada.unityBridgeAutoConnect);
    this.unityEditorRouter = unityEditorRouter;
    this.bridgeManager = bridgeManager;
    this.syncBridgeState(false, this.bridgeConfigured ? "disconnected" : "disabled", this.getInitialBridgeReason());
  }

  async start(): Promise<void> {
    if (this.unityEditorRouter) {
      try {
        await this.unityEditorRouter.initialize();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.syncBridgeState(false, "error", message);
        getLogger().warn("Failed to initialize Strada.MCP Unity editor router", {
          error: message,
          sourcePath: this.source.path,
        });
      }
      this.refreshIntegrationState();
      await this.refreshBridgeCapabilities();
      return;
    }

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
      await this.refreshBridgeCapabilities();
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.syncBridgeState(false, "error", message);
      getLogger().warn("Failed to connect Strada.MCP Unity bridge", {
        error: message,
        sourcePath: this.source.path,
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.bridgeConfigured || !this.bridgeManager || this.bridgeConnected) {
      return;
    }
    this.clearReconnectTimer();
    const RECONNECT_BASE_DELAY_MS = 15_000;
    const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
    const attempt = ++this.reconnectAttempt;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimerId = setTimeout(async () => {
      if (this.bridgeConnected || !this.bridgeManager) return;
      getLogger().info("Attempting Unity bridge reconnect", { attempt });
      this.syncBridgeState(false, "connecting", "Reconnecting to the Unity bridge.");
      try {
        await this.bridgeManager.connect();
        await this.refreshBridgeCapabilities();
        this.reconnectAttempt = 0;
        this.reconnectTimerId = null;
        getLogger().info("Unity bridge reconnected successfully");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        this.syncBridgeState(false, "error", msg);
        getLogger().debug("Unity bridge reconnect failed", { error: msg, attempt });
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  shutdown(): void {
    this.clearReconnectTimer();
    this.bridgeAwareTools.forEach((tool) => tool.setBridgeClient(null));
    this.bridgeAwareResources.forEach((resource) => resource.setBridgeClient(null));
    this.editorRouterAwareTools.forEach((tool) => tool.setEditorRouter(null));
    this.toolContext.unityBridgeConnected = false;
    this.unityEditorRouter?.destroy();
    this.unityEditorRouter = null;
    this.bridgeManager?.destroy();
    this.bridgeManager = null;
  }

  refreshIntegrationState(): void {
    if (!this.unityEditorRouter) {
      return;
    }

    const status = this.unityEditorRouter.getStatus({ includeDiscovered: false });
    const connected = status.connected === true;
    this.activeEditorPort = status.activePort ?? null;
    this.activeEditorInstanceId = status.activeInstance?.instanceId ?? null;
    this.activeEditorProjectName = status.activeInstance?.projectName ?? null;
    this.editorSelectionSource = status.selectionSource ?? null;
    this.editorDiscoveryCount = status.discoveredCount ?? 0;
    this.syncBridgeState(
      connected,
      status.connectionState ?? (connected ? "connected" : "disconnected"),
      connected
        ? undefined
        : (status.warnings?.[0]
          ?? DEFAULT_BRIDGE_UNAVAILABLE_REASON),
    );
    if (connected) {
      void this.refreshBridgeCapabilities();
    }
  }

  registerTool(
    name: string,
    metadata: Pick<
      StradaMcpToolMetadata,
      "requiresBridge" | "requiredBridgeMethods" | "requiredBridgeCapabilities"
    >,
  ): void {
    this.registeredTools.add(name);
    if (metadata.requiresBridge) {
      this.registeredBridgeTools.add(name);
    }
    this.registeredToolRequirements.set(name, {
      requiredBridgeMethods: [...(metadata.requiredBridgeMethods ?? [])],
      requiredBridgeCapabilities: [...(metadata.requiredBridgeCapabilities ?? [])],
    });
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
    metadata: Pick<
      StradaMcpToolMetadata,
      "requiresBridge" | "requiredBridgeMethods" | "requiredBridgeCapabilities"
    >,
  ): Pick<BrainToolMetadata, "available" | "availabilityReason"> {
    if (!metadata.requiresBridge) {
      return { available: true };
    }

    return this.resolveBridgeAvailability(
      metadata.requiredBridgeMethods,
      metadata.requiredBridgeCapabilities,
    );
  }

  getStatus(): StradaMcpRuntimeStatus {
    const unavailableToolCount = this.tools.filter((tool) => {
      const availability = this.getToolAvailability(tool.metadata);
      return availability.available === false;
    }).length;
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
      activeEditorPort: this.activeEditorPort,
      activeEditorInstanceId: this.activeEditorInstanceId,
      activeEditorProjectName: this.activeEditorProjectName,
      editorSelectionSource: this.editorSelectionSource,
      editorDiscoveryCount: this.editorDiscoveryCount,
      bridgeUnavailableReason: unavailableToolCount > 0 ? this.bridgeUnavailableReason : undefined,
      lastError: this.lastError,
      bridgeProtocolVersion: this.bridgeCapabilities?.protocolVersion,
      bridgeCapabilityMethodCount: this.bridgeCapabilities?.supportedMethods?.length ?? 0,
    };
  }

  private getInitialBridgeReason(): string {
    if (this.unityEditorRouter) {
      if (!this.bridgeConfigured) {
        return "UNITY_BRIDGE_AUTO_CONNECT=false. Unity editor routing is available, but live bridge tools stay unavailable until you connect to an editor.";
      }
      return DEFAULT_BRIDGE_UNAVAILABLE_REASON;
    }
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
    if (!connected) {
      this.bridgeCapabilities = null;
    }
    this.toolContext.unityBridgeConnected = connected;
    if (!this.unityEditorRouter) {
      const client = connected ? (this.bridgeManager?.client ?? null) : null;
      this.bridgeAwareTools.forEach((tool) => tool.setBridgeClient(client));
      this.bridgeAwareResources.forEach((resource) => resource.setBridgeClient(client));
    }
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
      ? this.resolveBridgeAvailability(
        this.registeredToolRequirements.get(name)?.requiredBridgeMethods,
        this.registeredToolRequirements.get(name)?.requiredBridgeCapabilities,
      )
      : { available: true, availabilityReason: undefined };

    this.metadataMap?.set(name, {
      ...metadata,
      ...availability,
    });
  }

  private resolveBridgeAvailability(
    bridgeMethods: readonly string[] | undefined,
    bridgeCapabilities: readonly string[] | undefined,
  ): Pick<BrainToolMetadata, "available" | "availabilityReason"> {
    if (!this.bridgeConnected) {
      return {
        available: false,
        availabilityReason: this.bridgeUnavailableReason,
      };
    }

    const supportedMethods = new Set(this.bridgeCapabilities?.supportedMethods ?? []);
    const supportedCapabilities = new Set(this.bridgeCapabilities?.supportedFeatures ?? []);
    if (bridgeMethods && bridgeMethods.length > 0 && supportedMethods.size > 0) {
      const missing = bridgeMethods.filter((method) => !supportedMethods.has(method));
      if (missing.length > 0) {
        return {
          available: false,
          availabilityReason:
            `Unity bridge is connected, but the active editor does not expose: ${missing.join(", ")}`,
        };
      }
    }

    if (bridgeCapabilities && bridgeCapabilities.length > 0 && supportedCapabilities.size > 0) {
      const missing = bridgeCapabilities.filter((feature) => !supportedCapabilities.has(feature));
      if (missing.length > 0) {
        return {
          available: false,
          availabilityReason:
            `Unity bridge is connected, but the active editor does not advertise: ${missing.join(", ")}`,
        };
      }
    }

    return {
      available: true,
      availabilityReason: undefined,
    };
  }

  private getActiveBridgeClient(): StradaMcpCapabilityAwareBridgeClientLike | null {
    const routerClient = this.unityEditorRouter?.getBridgeClient?.();
    if (routerClient && typeof (routerClient as StradaMcpCapabilityAwareBridgeClientLike).request === "function") {
      return routerClient as StradaMcpCapabilityAwareBridgeClientLike;
    }

    const managerClient = this.bridgeManager?.client;
    if (managerClient && typeof (managerClient as StradaMcpCapabilityAwareBridgeClientLike).request === "function") {
      return managerClient as StradaMcpCapabilityAwareBridgeClientLike;
    }

    return null;
  }

  private async refreshBridgeCapabilities(): Promise<void> {
    if (!this.bridgeConnected) {
      this.bridgeCapabilities = null;
      this.syncAllToolMetadata();
      return;
    }

    const client = this.getActiveBridgeClient();
    if (!client) {
      return;
    }

    try {
      const capabilities = typeof client.getCapabilities === "function"
        ? await client.getCapabilities()
        : typeof client.ensureCapabilities === "function"
          ? await client.ensureCapabilities()
        : await client.request<StradaMcpBridgeCapabilities>("bridge.getCapabilities", {});
      this.bridgeCapabilities = capabilities ?? null;
      this.syncAllToolMetadata();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      getLogger().debug("Failed to refresh Strada.MCP bridge capabilities", {
        error: this.lastError,
        sourcePath: this.source.path,
      });
    }
  }
}

export async function loadInstalledStradaMcpRuntime(config: Config): Promise<StradaMcpRuntime | null> {
  const install = detectStradaMcp(config.strada, config.unityProjectPath);
  if (!install.installed || !install.path) {
    return null;
  }

  if (!isTrustedStradaMcpPackageRoot(install.path)) {
    throw new Error(`Refusing to load Strada.MCP from untrusted path: ${install.path}`);
  }

  const [{ bootstrap }, { ToolRegistry }, bridgeModule, unityEditorRouterModule] = await Promise.all([
    importFirstAvailable<StradaMcpBootstrapModule>(resolveModuleCandidates(install.path, "bootstrap.ts")),
    importFirstAvailable<StradaMcpToolRegistryModule>(resolveModuleCandidates(install.path, "tools/tool-registry.ts")),
    importOptionalFirstAvailable<StradaMcpBridgeManagerModule>(resolveModuleCandidates(install.path, "bridge/bridge-manager.ts")),
    importOptionalFirstAvailable<StradaMcpUnityEditorRouterModule>(resolveModuleCandidates(install.path, "bridge/unity-editor-router.ts")),
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
  const unityEditorRouter = unityEditorRouterModule?.UnityEditorRouter
    ? new unityEditorRouterModule.UnityEditorRouter({
      projectPath: config.unityProjectPath,
      preferredPort: config.strada.unityBridgePort,
      preferredInstanceId: undefined,
      discoveryEnabled: true,
      staleAfterMs: 20_000,
      autoConnect: config.strada.unityBridgeAutoConnect,
      timeoutMs: config.strada.unityBridgeTimeout,
      logLevel: config.logLevel,
      logger: (() => {
        const logger = getLogger();
        return {
          debug(message: string, meta?: Record<string, unknown>) { logger.debug(message, meta); },
          info(message: string, meta?: Record<string, unknown>) { logger.info(message, meta); },
          warn(message: string, meta?: Record<string, unknown>) { logger.warn(message, meta); },
          error(message: string, meta?: Record<string, unknown>) { logger.error(message, meta); },
          child() { return this; },
        };
      })(),
      toolContext: normalized.toolContext,
      bridgeAwareTools: normalized.bridgeAwareTools,
      bridgeAwareResources: normalized.bridgeAwareResources,
      editorRouterAwareTools: normalized.editorRouterAwareTools,
    })
    : null;

  const bridgeManager = unityEditorRouter
    ? null
    : (bridgeModule?.BridgeManager?.fromConfig({
      unityBridgePort: config.strada.unityBridgePort,
      unityBridgeAutoConnect: config.strada.unityBridgeAutoConnect,
      unityBridgeTimeout: config.strada.unityBridgeTimeout,
      logLevel: config.logLevel,
    }) ?? null);

  const runtime = new StradaMcpRuntime(config, install, normalized, unityEditorRouter, bridgeManager);
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
    this.runtime?.refreshIntegrationState();

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
    runtime?.registerTool(tool.name, tool.metadata);
    registered++;
  }

  return { registered, skipped };
}
