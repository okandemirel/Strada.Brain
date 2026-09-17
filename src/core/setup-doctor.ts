/* eslint-disable no-console -- doctor command is a user-facing diagnostic CLI */
import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePaths } from "../common/runtime-paths.js";
import {
  getPackagedAppHomeDescription,
  getSourceLauncherCommand,
  getSourceSetupCommand,
} from "../common/launcher-guidance.js";
import { inspectClaudeSubscriptionAuth } from "../common/claude-subscription-auth.js";
import { inspectOpenAiSubscriptionAuth } from "../common/openai-subscription-auth.js";
import { loadConfigSafe, type Config } from "../config/config.js";
import {
  checkStradaDeps,
  evaluateProjectSupport,
  formatProjectMatrix,
  type ProjectSupportVerdict,
} from "../config/strada-deps.js";
import { resolveEmbeddingProvider, describeEmbeddingResolutionFailure } from "../rag/embeddings/embedding-resolver.js";
import { AutoUpdater } from "./auto-updater.js";
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import {
  collectProviderCredentials,
  detectConfiguredResponseProviders,
  hasConfiguredAnthropicSubscription,
  normalizeProviderNames,
} from "./provider-config.js";
import { preflightResponseProviders } from "./response-provider-preflight.js";
import { buildCapabilitySnapshot, summarizeCapabilityHealth } from "./boot-report.js";
import { evaluateChainReadiness, type ChainReadinessVerdict } from "./chain-readiness.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
  /** Provider-chain verdict shared with setup and boot (plan 2.2). */
  readiness?: ChainReadinessVerdict;
  /** Per-row supported-project matrix, when this check evaluated it (plan 6.10). */
  matrix?: ProjectSupportVerdict;
}

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
}

interface ConfigResultOk {
  kind: "ok";
  value: Config;
}

interface ConfigResultErr {
  /**
   * BOTH SPELLINGS, because production only ever produces one of them.
   * `loadConfigSafe` returns `Result<Config, string>`, whose failure is
   * `kind: "err"` — this file declared `"error"` and cast, so an INVALID
   * configuration matched neither branch, fell through to the success path
   * and read `.value.language` off an object with no value. The doctor then
   * crashed with `Cannot read properties of undefined` exactly when a new
   * developer needed it to say what was wrong (found by the plan-6.8
   * first-run rehearsal).
   */
  kind: "err" | "error";
  error: string;
}

type ConfigResult = ConfigResultOk | ConfigResultErr;

interface DoctorOptions {
  installRoot?: string;
  configRoot?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  configResult?: ConfigResult;
}

function parseNodeMajor(nodeVersion: string): number {
  return Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
}

function formatStatus(status: DoctorStatus): string {
  if (status === "pass") return "PASS";
  if (status === "warn") return "WARN";
  return "FAIL";
}

function computeOverallStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function summarizeResponseWorker(config: Config): string {
  const providerChain = config.providerChain
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(", ");
  const claudeMode = hasConfiguredAnthropicSubscription(config)
    ? "Claude can use the configured subscription auth token."
    : "Claude uses API billing when selected.";
  const openaiMode = config.openaiAuthMode === "chatgpt-subscription"
    ? "OpenAI conversation turns can reuse the local ChatGPT/Codex subscription session."
    : "OpenAI uses API billing when selected.";

  return providerChain
    ? `Strada control plane ready. Primary orchestration pool: ${providerChain}. ${claudeMode} ${openaiMode}`
    : `Strada control plane ready. ${claudeMode} ${openaiMode}`;
}

/**
 * Turn the supported project matrix into one doctor check (plan 6.10).
 *
 * The doctor used to say nothing about whether the project it was pointed at is
 * one this system supports: a Unity 2022 project, a directory that is not a
 * Unity project at all, or a Strada.MCP checkout with no node_modules all
 * produced a clean bill of health and failed later with something vague. Each
 * of those is now a named row.
 *
 * Status policy, deliberately narrow:
 *   - a `required` row that is missing or unsupported FAILS;
 *   - anything the checker could not determine (`unknown`) or a `recommended`
 *     gap WARNS — an undetermined row must never read as a pass;
 *   - `not-measured` rows (the second machine, and Strada.MCP's dependency tree
 *     when Strada.MCP itself is absent) are printed as not measured and do not
 *     move the status, because nothing was attempted. That is the same
 *     distinction `delivery-package.ts` draws and the reason the doctor stopped
 *     warning about the supervisor it never constructed.
 */
function buildProjectMatrixCheck(matrix: ProjectSupportVerdict): DoctorCheck {
  const blocking = matrix.rows.filter(
    (row) => row.requirement === "required" && (row.status === "missing" || row.status === "unsupported"),
  );
  const recommendedGaps = matrix.rows.filter(
    (row) => row.requirement === "recommended" && (row.status === "missing" || row.status === "unsupported"),
  );
  const undetermined = matrix.rows.filter((row) => row.status === "unknown");
  const notMeasured = matrix.rows.filter((row) => row.status === "not-measured");

  const status: DoctorStatus = blocking.length > 0
    ? "fail"
    : (undetermined.length > 0 || recommendedGaps.length > 0 ? "warn" : "pass");

  const named = [...blocking, ...recommendedGaps, ...undetermined]
    .map((row) => `${row.label} — ${row.detail}`)
    .join(" ");
  const unmeasuredText = notMeasured
    .map((row) => `NOT MEASURED — ${row.label}: ${row.detail}`)
    .join(" ");
  const fixes = [...blocking, ...recommendedGaps, ...undetermined]
    .map((row) => row.fix)
    .filter((fix): fix is string => Boolean(fix));

  return {
    id: "project-matrix",
    label: "Supported project matrix",
    status,
    detail: [matrix.summary, named, unmeasuredText].filter(Boolean).join(" "),
    ...(fixes.length > 0 ? { fix: fixes.join(" ") } : {}),
    matrix,
  };
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const platform = options.platform ?? process.platform;
  const runtimePaths = resolveRuntimePaths({ moduleUrl: import.meta.url, platform });
  const installRoot = options.installRoot ?? runtimePaths.installRoot;
  const configRoot = options.configRoot ?? runtimePaths.configRoot;
  const configResult = options.configResult ?? (loadConfigSafe() as ConfigResult);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks: DoctorCheck[] = [];

  const nodeMajor = parseNodeMajor(nodeVersion);
  checks.push({
    id: "node",
    label: "Node.js",
    status: nodeMajor >= 20 ? "pass" : "fail",
    detail: `Detected Node.js ${nodeVersion}.`,
    fix: nodeMajor >= 20 ? undefined : "Install Node.js 20 or newer before running Strada.",
  });

  const updater = new AutoUpdater(
    {
      autoUpdate: {
        enabled: true,
        intervalHours: 6,
        idleTimeoutMin: 5,
        channel: "latest",
        notify: false,
        autoRestart: false,
      },
    },
    new ChannelActivityRegistry(),
    { hasRunningTasks: () => false },
    { installRoot },
  );
  const installMethod = updater.detectInstallMethod();
  checks.push({
    id: "install-method",
    label: "Install method",
    status: "pass",
    detail: `Detected ${installMethod} install rooted at ${installRoot}.`,
  });

  const distIndexPath = path.join(installRoot, "dist", "index.js");
  const webStaticPath = path.join(installRoot, "dist", "channels", "web", "static", "index.html");
  const buildReady = fs.existsSync(distIndexPath) && fs.existsSync(webStaticPath);
  const sourceRuntimeReady =
    fs.existsSync(path.join(installRoot, "package.json"))
    && fs.existsSync(path.join(installRoot, "src", "index.ts"))
    && fs.existsSync(path.join(installRoot, "node_modules"));
  const buildStatus: DoctorStatus = buildReady
    ? "pass"
    : (installMethod === "git" && sourceRuntimeReady ? "warn" : "fail");
  checks.push({
    id: "build",
    label: "Build artifacts",
    status: buildStatus,
    detail: buildReady
      ? "CLI and embedded web dashboard assets are built."
      : (installMethod === "git" && sourceRuntimeReady
          ? `Built dist/ artifacts are missing, but this source checkout can still run through \`${getSourceLauncherCommand(platform)}\` or the installed bare \`strada\` command.`
          : "Built CLI/web assets are missing from dist/."),
    fix: buildReady
      ? undefined
      : (installMethod === "git" && sourceRuntimeReady
          ? `Optional: run \`cd "${installRoot}" && npm run bootstrap\` if you want dist/ artifacts for this source checkout.`
          : `Run \`cd "${installRoot}" && npm run bootstrap\` from the source checkout.`),
  });

  const envPath = path.join(configRoot, ".env");
  const envExists = fs.existsSync(envPath);
  if (!envExists) {
    checks.push({
      id: "config",
      label: "Configuration",
      status: "fail",
      detail: `No .env file was found in ${configRoot}.`,
      fix: `Run \`${getSourceSetupCommand(platform, "web")}\`, \`${getSourceSetupCommand(platform, "terminal")}\`, or \`npm run setup:web\`.`,
    });
  } else if (configResult.kind !== "ok") {
    checks.push({
      id: "config",
      label: "Configuration",
      status: "fail",
      detail: `Config validation failed: ${configResult.error}`,
      fix: `Re-run \`${getSourceSetupCommand(platform, "web")}\` or \`${getSourceSetupCommand(platform, "terminal")}\` and save a valid configuration.`,
    });
  } else {
    checks.push({
      id: "config",
      label: "Configuration",
      status: "pass",
      detail: `Loaded .env successfully. Language=${configResult.value.language}, web port=${configResult.value.web.port}.`,
    });

    // One dependency scan feeds both the matrix and the capability snapshot
    // below; two scans of the same project would only invite them to disagree.
    const stradaDeps = checkStradaDeps(
      configResult.value.unityProjectPath,
      configResult.value.strada,
    );
    checks.push(buildProjectMatrixCheck(evaluateProjectSupport({
      unityProjectPath: configResult.value.unityProjectPath,
      config: configResult.value.strada,
      deps: stradaDeps,
      unityEditorPath:
        configResult.value.strada.unityEditorPath ?? process.env["STRADA_UNITY_BIN"] ?? null,
    })));

    const providerCheck: DoctorCheck = {
      id: "providers",
      label: "Response workers",
      status: "pass",
      detail: summarizeResponseWorker(configResult.value),
    };
    const configuredProviders = normalizeProviderNames(configResult.value.providerChain);
    const requestedResponseProviders = configuredProviders.length > 0
      ? configuredProviders
      : detectConfiguredResponseProviders(configResult.value);
    // providerModels already carries opencode (config.ts maps
    // OPENCODE_DEFAULT_MODEL into it); the saved OPENCODE_BASE_URL was not
    // passed, so the doctor probed the default endpoint instead of the one
    // the user configured (audit 10.4 / D28).
    const preflightResult = await preflightResponseProviders(
      requestedResponseProviders,
      collectProviderCredentials(configResult.value),
      configResult.value.providerModels,
      configResult.value.providerBaseUrls,
    );
    // ONE readiness policy shared with setup save and boot (plan 2.2): the
    // doctor used to report ANY failure as FAIL while boot ran happily on a
    // fallback. "degraded" is now the same warning the other two show.
    const readiness = evaluateChainReadiness(preflightResult, {
      requestedProviderIds: requestedResponseProviders,
    });
    providerCheck.readiness = readiness;
    if (readiness.state === "unavailable") {
      providerCheck.status = "fail";
      providerCheck.detail = `${providerCheck.detail} ${readiness.error}`;
      providerCheck.fix =
        `Re-run \`${getSourceSetupCommand(platform)}\` and fix the failing response-worker credentials before starting Strada.`;
    } else if (readiness.state === "degraded") {
      providerCheck.status = "warn";
      providerCheck.detail = `${providerCheck.detail} ${readiness.warning}`;
      providerCheck.fix =
        `Re-run \`${getSourceSetupCommand(platform)}\` to fix the failing response-worker credentials; Strada runs on the healthy ones meanwhile.`;
    }
    checks.push(providerCheck);

    const responseChain = configResult.value.providerChain
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      ?? [];
    const claudeInResponsePool = responseChain.length === 0
      ? Boolean(configResult.value.anthropicApiKey || hasConfiguredAnthropicSubscription(configResult.value))
      : responseChain.includes("claude") || responseChain.includes("anthropic");
    if (claudeInResponsePool && configResult.value.anthropicAuthMode === "claude-subscription") {
      const authInspection = inspectClaudeSubscriptionAuth({
        authToken: configResult.value.anthropicAuthToken,
      });
      const claudeIsOnlyResponseWorker = responseChain.length <= 1;
      checks.push({
        id: "claude-subscription",
        label: "Claude subscription token",
        status: authInspection.ok ? "pass" : (claudeIsOnlyResponseWorker ? "fail" : "warn"),
        detail: authInspection.ok
          ? authInspection.detail
          : `${authInspection.detail} Claude conversation turns will fail until you add a token or switch Claude to API-key mode.`,
        fix: authInspection.ok
          ? undefined
          : `Run \`claude auth login --claudeai\`, then \`claude setup-token\`, paste the generated token into setup, or re-run \`${getSourceSetupCommand(platform)}\` and switch Claude to API-key mode.`,
      });
    }

    const openAiInResponsePool = responseChain.length === 0
      ? configResult.value.openaiAuthMode === "chatgpt-subscription"
      : responseChain.includes("openai");
    if (openAiInResponsePool && configResult.value.openaiAuthMode === "chatgpt-subscription") {
      const authInspection = inspectOpenAiSubscriptionAuth({
        authFile: configResult.value.openaiChatgptAuthFile,
        accessToken: configResult.value.openaiSubscriptionAccessToken,
        accountId: configResult.value.openaiSubscriptionAccountId,
      });
      const openAiIsOnlyResponseWorker = responseChain.length <= 1;
      checks.push({
        id: "openai-subscription",
        label: "OpenAI subscription session",
        status: authInspection.ok ? "pass" : (openAiIsOnlyResponseWorker ? "fail" : "warn"),
        detail: authInspection.ok
          ? authInspection.detail
          : `${authInspection.detail} OpenAI conversation turns will fail until you sign in again or switch auth mode.`,
        fix: authInspection.ok
          ? undefined
          : `Sign in again with Codex/ChatGPT on this machine, or re-run \`${getSourceSetupCommand(platform)}\` and switch OpenAI to API-key mode.`,
      });
    }

    if (!configResult.value.rag.enabled) {
      checks.push({
        id: "embeddings",
        label: "Embeddings / RAG",
        status: "warn",
        detail: "RAG is disabled in the current config.",
        fix: "Enable RAG in setup or set `RAG_ENABLED=true` with an embedding-capable provider.",
      });
    } else {
      const embeddingResolution = resolveEmbeddingProvider(configResult.value);
      checks.push({
        id: "embeddings",
        label: "Embeddings / RAG",
        status: embeddingResolution ? "pass" : "fail",
        detail: embeddingResolution
          ? `Resolved ${embeddingResolution.provider.name} via ${embeddingResolution.source}.`
          : describeEmbeddingResolutionFailure(configResult.value, "doctor"),
        fix: embeddingResolution
          ? undefined
          : "Add a usable embedding credential or switch `EMBEDDING_PROVIDER` to a supported local/remote provider.",
      });
    }

    const capabilities = buildCapabilitySnapshot({
      stradaMcpRuntime: (() => {
        const deps = stradaDeps;
        return {
          installed: deps.mcpInstalled,
          sourcePath: deps.mcpPath,
          version: deps.mcpVersion,
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
          bridgeConfigured: deps.mcpInstalled && configResult.value.strada.unityBridgeAutoConnect,
          bridgeConnected: false,
          bridgeState: deps.mcpInstalled ? "disconnected" : "inactive",
          availableToolCount: 0,
          unavailableToolCount: 0,
          bridgeUnavailableReason: deps.mcpInstalled
            ? "Doctor cannot confirm a live Unity bridge connection from static config alone."
            : "Strada.MCP is not installed.",
        };
      })(),
      config: configResult.value,
      installRoot,
      channelType: "doctor",
      daemonMode: false,
      providerHealthy: undefined,
      embeddingStatus: {
        state: configResult.value.rag.enabled
          ? (resolveEmbeddingProvider(configResult.value) ? "active" : "degraded")
          : "disabled",
        verified: false,
        usingHashFallback: !resolveEmbeddingProvider(configResult.value),
      },
      deploymentWired: false,
      alertingWired: false,
      backupWired: false,
      // The doctor reads static config; it never boots, so it never constructs
      // a SupervisorBrain. Omitting this left the capability declared-only,
      // which listed "Supervisor Brain" under "still need truthfulness work" on
      // every healthy install with the supervisor enabled — a warning about a
      // check that was never run (audited 2026-09-02).
      supervisorWired: "not-measured",
    });
    const capabilityHealth = summarizeCapabilityHealth(capabilities);
    checks.push({
      id: "capability-truth",
      label: "Capability truth",
      status: capabilityHealth.status,
      detail: capabilityHealth.detail,
      fix: capabilityHealth.fix,
    });
  }

  return {
    status: computeOverallStatus(checks),
    checks,
  };
}

export async function runDoctorCommand(): Promise<number> {
  const report = await collectDoctorReport();

  console.log("\nStrada Doctor");
  console.log("=============");
  console.log(`Runtime app home default: ${getPackagedAppHomeDescription(process.platform)}\n`);
  for (const check of report.checks) {
    console.log(`[${formatStatus(check.status)}] ${check.label}`);
    console.log(`  ${check.detail}`);
    // The matrix is the one check whose value is per-row: "which of the eight
    // things this project needs is missing" is what someone moving the demo to
    // another machine has to read (plan 6.10).
    if (check.matrix) {
      for (const line of formatProjectMatrix(check.matrix)) {
        console.log(`  ${line}`);
      }
    }
    if (check.fix) {
      console.log(`  Fix: ${check.fix}`);
    }
    console.log("");
  }

  if (report.status === "fail") {
    console.log("Doctor finished with blocking issues.");
    return 1;
  }
  if (report.status === "warn") {
    console.log("Doctor finished with warnings.");
    return 0;
  }

  console.log("Doctor finished successfully.");
  return 0;
}
