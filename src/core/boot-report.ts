import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BootReport,
  BootStageReport,
  CapabilityDescriptor,
  CapabilityStatus,
  CapabilityTruth,
} from "../common/capability-contract.js";
import type { Config } from "../config/config.js";
import { resolveRuntimePaths } from "../common/runtime-paths.js";

interface EmbeddingStatusLike {
  state: "disabled" | "active" | "degraded";
  verified: boolean;
  usingHashFallback: boolean;
  notice?: string;
}

interface StradaMcpRuntimeStatusLike {
  installed: boolean;
  sourcePath: string | null;
  version: string | null;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  bridgeConfigured: boolean;
  bridgeConnected: boolean;
  bridgeState: string;
  availableToolCount: number;
  unavailableToolCount: number;
  bridgeUnavailableReason?: string;
  lastError?: string;
}

export interface CapabilitySnapshotOptions {
  config: Config;
  installRoot?: string;
  channelType: string;
  channelHealthy?: boolean;
  daemonMode?: boolean;
  providerHealthy?: boolean;
  embeddingStatus?: EmbeddingStatusLike;
  deploymentWired?: boolean;
  alertingWired?: boolean;
  backupWired?: boolean;
  stradaMcpRuntime?: StradaMcpRuntimeStatusLike;
}

export interface CapabilityHealthSummary {
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

const REQUIRED_PENTEST_SCRIPTS = [
  "pentest/scripts/run-all-tests.sh",
  "pentest/scripts/test-sast.sh",
  "pentest/scripts/test-path-traversal.sh",
  "pentest/scripts/test-command-injection.sh",
  "pentest/scripts/test-ssrf.sh",
] as const;

function createCapability(
  id: string,
  name: string,
  area: string,
  tier: CapabilityDescriptor["tier"],
  status: CapabilityStatus,
  truth: CapabilityTruth,
  detail: string,
  defaultSurface: boolean,
): CapabilityDescriptor {
  return { id, name, area, tier, status, truth, detail, defaultSurface };
}

function hasPackageDependency(installRoot: string, packageName: string): boolean {
  if (existsSync(join(installRoot, "node_modules", packageName))) {
    return true;
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(packageJson.dependencies?.[packageName] || packageJson.devDependencies?.[packageName]);
  } catch {
    return false;
  }
}

function hasRequiredPentestScripts(installRoot: string): boolean {
  return REQUIRED_PENTEST_SCRIPTS.every((path) => existsSync(join(installRoot, path)));
}

export function buildCapabilitySnapshot(options: CapabilitySnapshotOptions): CapabilityDescriptor[] {
  const installRoot = options.installRoot ?? resolveRuntimePaths({ moduleUrl: import.meta.url }).installRoot;
  const nodemailerInstalled = hasPackageDependency(installRoot, "nodemailer");
  const pentestScriptsReady = hasRequiredPentestScripts(installRoot);
  const embeddingStatus = options.embeddingStatus;
  const ragStatus: CapabilityStatus = !options.config.rag.enabled
    ? "inactive"
    : embeddingStatus?.state === "degraded"
      ? "degraded"
      : "active";
  const ragTruth: CapabilityTruth = !options.config.rag.enabled
    ? "wired"
    : embeddingStatus?.verified
      ? "health-checked"
      : embeddingStatus?.state === "active"
        ? "wired"
        : "declared-only";
  const extendedChannelsConfigured = Boolean(
    options.config.telegram.botToken
      || options.config.discord.botToken
      || options.config.slack.botToken
      || (options.config.whatsapp.allowedNumbers?.length ?? 0) > 0
      || options.config.matrix.accessToken
      || options.config.irc.server
      || options.config.teams.appId,
  );
  const stradaMcpRuntime = options.stradaMcpRuntime;
  const stradaMcpInstalled = stradaMcpRuntime?.installed === true;
  const unityBridgeStatus: CapabilityStatus = !stradaMcpInstalled
    ? "inactive"
    : stradaMcpRuntime?.bridgeConnected
      ? "active"
      : "degraded";
  const unityBridgeTruth: CapabilityTruth = stradaMcpRuntime?.bridgeConnected
    ? "health-checked"
    : stradaMcpInstalled
      ? "wired"
      : "declared-only";
  const unityBridgeDetail = !stradaMcpInstalled
    ? "Strada.MCP is not installed, so live Unity bridge features are unavailable."
    : stradaMcpRuntime?.bridgeConnected
      ? `Unity bridge is connected (${stradaMcpRuntime.bridgeState}).`
      : stradaMcpRuntime?.bridgeUnavailableReason
        ?? "Strada.MCP is installed, but the Unity bridge is not connected.";
  const unitySurfaceStatus: CapabilityStatus = !stradaMcpInstalled
    ? "inactive"
    : stradaMcpRuntime?.bridgeConnected
      ? "active"
      : "degraded";
  const unitySurfaceTruth: CapabilityTruth = stradaMcpRuntime?.bridgeConnected
    ? "health-checked"
    : stradaMcpInstalled
      ? "wired"
      : "declared-only";

  return [
    createCapability(
      "strada-mcp-runtime",
      "Strada.MCP Runtime",
      "Unity",
      "beta",
      stradaMcpInstalled ? "active" : "inactive",
      stradaMcpInstalled ? "wired" : "declared-only",
      stradaMcpInstalled
        ? `Strada.MCP is installed with ${stradaMcpRuntime?.toolCount ?? 0} tools, ${stradaMcpRuntime?.resourceCount ?? 0} resources, and ${stradaMcpRuntime?.promptCount ?? 0} prompts.`
        : "Install Strada.MCP to expose the Unity runtime surface inside Brain.",
      true,
    ),
    createCapability(
      "unity-bridge",
      "Unity Bridge",
      "Unity",
      "beta",
      unityBridgeStatus,
      unityBridgeTruth,
      unityBridgeDetail,
      true,
    ),
    createCapability(
      "unity-console",
      "Unity Console",
      "Unity",
      "beta",
      unitySurfaceStatus,
      unitySurfaceTruth,
      stradaMcpInstalled
        ? (stradaMcpRuntime?.bridgeConnected
            ? "Live Unity console reads and error analysis are available."
            : "Unity console tools are installed but unavailable until the live bridge connects.")
        : "Install Strada.MCP to unlock live Unity console reads and analysis.",
      true,
    ),
    createCapability(
      "unity-build",
      "Unity Build Pipeline",
      "Unity",
      "beta",
      unitySurfaceStatus,
      unitySurfaceTruth,
      stradaMcpInstalled
        ? (stradaMcpRuntime?.bridgeConnected
            ? "Multi-platform Unity build execution is available through the live bridge."
            : "Unity build pipeline tools are installed but unavailable until the live bridge connects.")
        : "Install Strada.MCP to unlock Unity build execution.",
      false,
    ),
    createCapability(
      "unity-package-manager",
      "Unity Package Manager",
      "Unity",
      "beta",
      unitySurfaceStatus,
      unitySurfaceTruth,
      stradaMcpInstalled
        ? (stradaMcpRuntime?.bridgeConnected
            ? "Unity Package Manager operations are available through the live bridge."
            : "Unity Package Manager tools are installed but unavailable until the live bridge connects.")
        : "Install Strada.MCP to unlock Unity package management.",
      false,
    ),
    createCapability(
      "unity-project-settings",
      "Unity Project Settings",
      "Unity",
      "beta",
      unitySurfaceStatus,
      unitySurfaceTruth,
      stradaMcpInstalled
        ? (stradaMcpRuntime?.bridgeConnected
            ? "Typed Unity project and player/build/quality settings access is available."
            : "Unity settings tools are installed but unavailable until the live bridge connects.")
        : "Install Strada.MCP to unlock live Unity settings control.",
      false,
    ),
    createCapability(
      "unity-editor-preferences",
      "Unity Editor Preferences",
      "Unity",
      "beta",
      unitySurfaceStatus,
      unitySurfaceTruth,
      stradaMcpInstalled
        ? (stradaMcpRuntime?.bridgeConnected
            ? "Unity EditorPrefs/Preferences access is available."
            : "Unity editor preference tools are installed but unavailable until the live bridge connects.")
        : "Install Strada.MCP to unlock Unity editor preferences control.",
      false,
    ),
    createCapability(
      "web-surface",
      "Web Surface",
      "Golden Path",
      "production",
      options.config.dashboard.enabled ? "active" : "inactive",
      options.config.dashboard.enabled ? "wired" : "declared-only",
      options.config.dashboard.enabled
        ? "Local web chat and dashboard are enabled for the default recovery path."
        : "Web surface is disabled in config.",
      true,
    ),
    createCapability(
      "cli-surface",
      "CLI Surface",
      "Golden Path",
      "production",
      "active",
      "wired",
      "Interactive CLI remains available as the fallback protected surface.",
      true,
    ),
    createCapability(
      "strada-coding-loop",
      "Strada Coding Loop",
      "Golden Path",
      "production",
      "active",
      options.providerHealthy === true ? "health-checked" : "wired",
      "Core orchestration, tool execution, and Strada-aware coding flow are online.",
      true,
    ),
    createCapability(
      "response-workers",
      "Response Workers",
      "Providers",
      "production",
      options.providerHealthy === false ? "degraded" : "active",
      options.providerHealthy === true ? "health-checked" : "wired",
      options.providerHealthy === false
        ? "Primary provider chain booted, but the runtime health check failed."
        : "Primary provider chain is configured for the current runtime.",
      true,
    ),
    createCapability(
      "rag-search",
      "RAG Search",
      "Knowledge",
      "beta",
      ragStatus,
      ragTruth,
      !options.config.rag.enabled
        ? "Semantic retrieval is disabled in the current config."
        : embeddingStatus?.state === "degraded"
          ? embeddingStatus.notice ?? "RAG is configured but the embedding path degraded."
          : "Semantic retrieval is available for the coding loop.",
      false,
    ),
    createCapability(
      "daemon-automation",
      "Daemon Automation",
      "Operations",
      "beta",
      options.daemonMode ? "active" : "inactive",
      "wired",
      options.daemonMode
        ? "Daemon mode is active in this runtime."
        : "Daemon automation is available but remains opt-in during recovery.",
      false,
    ),
    createCapability(
      "extended-channels",
      "Extended Channels",
      "Channels",
      "beta",
      extendedChannelsConfigured ? "active" : "inactive",
      "wired",
      extendedChannelsConfigured
        ? "At least one non-default channel is configured."
        : "Non-default channels remain outside the protected recovery surface.",
      false,
    ),
    createCapability(
      "multi-agent",
      "Multi-Agent Orchestration",
      "Execution",
      "experimental",
      options.config.agent.enabled ? "active" : "inactive",
      "wired",
      options.config.agent.enabled
        ? "Multi-agent mode is enabled in config."
        : "Multi-agent execution is now treated as opt-in during recovery.",
      false,
    ),
    createCapability(
      "delegation",
      "Sub-Agent Delegation",
      "Execution",
      "experimental",
      options.config.delegation.enabled ? "active" : "inactive",
      "wired",
      options.config.delegation.enabled
        ? "Delegation is enabled in config."
        : "Delegation stays opt-in until the default surfaces harden.",
      false,
    ),
    createCapability(
      "deployment",
      "Deployment Automation",
      "Operations",
      "experimental",
      options.config.deployment.enabled
        ? (options.deploymentWired ? "active" : "degraded")
        : "inactive",
      options.deploymentWired ? "wired" : "declared-only",
      options.config.deployment.enabled
        ? (options.deploymentWired
            ? "Deployment automation is wired into the current runtime."
            : "Deployment is enabled in config but not fully wired into the protected runtime path.")
        : "Deployment automation remains experimental and off by default.",
      false,
    ),
    createCapability(
      "alerting",
      "Alerting Stack",
      "Operations",
      "experimental",
      options.alertingWired ? "active" : "inactive",
      options.alertingWired ? "wired" : "declared-only",
      options.alertingWired
        ? "Alerting is wired into this runtime."
        : "Alerting code exists but is not wired into bootstrap yet.",
      false,
    ),
    createCapability(
      "backup",
      "Backup Monitoring",
      "Operations",
      "experimental",
      options.backupWired ? "active" : "inactive",
      options.backupWired ? "wired" : "declared-only",
      options.backupWired
        ? "Backup monitoring is wired into this runtime."
        : "Backup monitoring remains outside the default runtime wiring.",
      false,
    ),
    createCapability(
      "email-alerts",
      "Email Alert Delivery",
      "Operations",
      "experimental",
      nodemailerInstalled ? "active" : "inactive",
      nodemailerInstalled ? "wired" : "declared-only",
      nodemailerInstalled
        ? "Optional email delivery dependency is present."
        : "Email alert delivery remains experimental until the optional dependency is installed.",
      false,
    ),
    createCapability(
      "pentest-scripts",
      "Security Test Scripts",
      "Operations",
      "experimental",
      pentestScriptsReady ? "active" : "degraded",
      pentestScriptsReady ? "wired" : "declared-only",
      pentestScriptsReady
        ? "Package scripts resolve to repository-backed security smoke checks."
        : "Advertised security scripts are missing from the install root.",
      false,
    ),
    createCapability(
      "siem-export",
      "SIEM Export",
      "Operations",
      "experimental",
      "inactive",
      "declared-only",
      "SIEM export remains explicitly experimental until the audit sink is fully implemented.",
      false,
    ),
  ];
}

function buildOperationsStage(capabilities: CapabilityDescriptor[]): BootStageReport {
  const blockingExperimental = capabilities.filter((capability) =>
    capability.tier === "experimental"
      && capability.status === "degraded",
  );

  if (blockingExperimental.length === 0) {
    return {
      id: "ops",
      label: "Operations Surface",
      status: "ready",
      detail: "Default runtime operations are within the protected recovery surface.",
    };
  }

  return {
    id: "ops",
    label: "Operations Surface",
    status: "degraded",
    detail: `Experimental operations still need truthfulness work: ${blockingExperimental.map((capability) => capability.name).join(", ")}.`,
  };
}

export function buildBootReport(
  options: CapabilitySnapshotOptions & { startupNotices?: string[] },
): BootReport {
  const capabilities = buildCapabilitySnapshot(options);
  const providerStage: BootStageReport = {
    id: "providers",
    label: "Response Workers",
    status: options.providerHealthy === false ? "degraded" : "ready",
    detail: options.providerHealthy === false
      ? "Provider chain booted but the runtime health probe failed."
      : "Primary provider chain booted successfully.",
  };
  const knowledgeStage: BootStageReport = {
    id: "knowledge",
    label: "Memory / RAG",
    status: options.embeddingStatus?.state === "degraded" ? "degraded" : "ready",
    detail: !options.config.rag.enabled
      ? "Semantic retrieval is disabled; memory remains available."
      : options.embeddingStatus?.state === "degraded"
        ? options.embeddingStatus.notice ?? "Embeddings degraded; semantic retrieval is not fully available."
        : "Memory and semantic retrieval initialized for the current runtime.",
  };
  const currentSurface = options.channelType === "web" || options.channelType === "cli"
    ? "protected"
    : "extended";
  const channelStage: BootStageReport = {
    id: "channel",
    label: "User Surface",
    status: options.channelHealthy === false ? "degraded" : "ready",
    detail: options.channelHealthy === false
      ? `Current channel '${options.channelType}' started but did not report healthy.`
      : `Current channel '${options.channelType}' is online on the ${currentSurface} runtime surface.`,
  };

  return {
    generatedAt: new Date().toISOString(),
    channelType: options.channelType,
    stages: [
      {
        id: "runtime",
        label: "Runtime",
        status: "ready",
        detail: "Bootstrap completed and Strada accepted work on the current runtime.",
      },
      providerStage,
      knowledgeStage,
      channelStage,
      buildOperationsStage(capabilities),
    ],
    capabilities,
    goldenPath: {
      channels: ["web", "cli"],
      recommendedPreset: "balanced",
      protectedWorkflows: [
        "Strada-aware coding loop",
        "Provider preflight and startup diagnostics",
        "Fresh setup to first chat handoff",
      ],
    },
    startupNotices: [...new Set((options.startupNotices ?? []).filter(Boolean))],
  };
}

export function summarizeBootReport(report: BootReport): string {
  const degradedStages = report.stages.filter((stage) => stage.status !== "ready");
  const degradedCapabilities = report.capabilities.filter((capability) => capability.status === "degraded");

  if (degradedStages.length === 0 && degradedCapabilities.length === 0) {
    return "Boot report clean: protected surfaces are active and no capability truth gaps are currently degrading runtime behavior.";
  }

  const parts: string[] = [];
  if (degradedStages.length > 0) {
    parts.push(`degraded stages: ${degradedStages.map((stage) => stage.label).join(", ")}`);
  }
  if (degradedCapabilities.length > 0) {
    parts.push(`degraded capabilities: ${degradedCapabilities.map((capability) => capability.name).join(", ")}`);
  }
  return `Boot report warnings: ${parts.join("; ")}.`;
}

export function summarizeCapabilityHealth(capabilities: CapabilityDescriptor[]): CapabilityHealthSummary {
  const blocking = capabilities.filter((capability) =>
    capability.tier === "production"
      && (capability.status !== "active" || capability.truth === "declared-only"),
  );
  if (blocking.length > 0) {
    return {
      status: "fail",
      detail: `Protected runtime capabilities are not fully trustworthy: ${blocking.map((capability) => capability.name).join(", ")}.`,
      fix: "Restore the protected web/CLI coding loop to active, wired status before expanding platform breadth.",
    };
  }

  const warnings = capabilities.filter((capability) =>
    capability.status === "degraded"
      || (capability.tier === "beta" && capability.truth === "declared-only"),
  );
  if (warnings.length > 0) {
    return {
      status: "warn",
      detail: `Some non-core capabilities still need truthfulness work: ${warnings.map((capability) => capability.name).join(", ")}.`,
      fix: "Either wire these features into the runtime and CI path, or keep them explicitly experimental and off by default.",
    };
  }

  return {
    status: "pass",
    detail: "Capability tiers are internally consistent: protected surfaces are active and opt-in surfaces remain clearly scoped.",
  };
}
