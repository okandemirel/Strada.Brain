/* eslint-disable no-console -- doctor command is a user-facing diagnostic CLI */
import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePaths } from "../common/runtime-paths.js";
import { inspectOpenAiSubscriptionAuth } from "../common/openai-subscription-auth.js";
import { loadConfigSafe, type Config } from "../config/config.js";
import { resolveEmbeddingProvider, describeEmbeddingResolutionFailure } from "../rag/embeddings/embedding-resolver.js";
import { AutoUpdater } from "./auto-updater.js";
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import {
  collectProviderCredentials,
  detectConfiguredResponseProviders,
  normalizeProviderNames,
} from "./provider-config.js";
import {
  formatProviderPreflightFailures,
  preflightResponseProviders,
} from "./response-provider-preflight.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
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
  kind: "error";
  error: string;
}

type ConfigResult = ConfigResultOk | ConfigResultErr;

interface DoctorOptions {
  installRoot?: string;
  configRoot?: string;
  nodeVersion?: string;
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
  const openaiMode = config.openaiAuthMode === "chatgpt-subscription"
    ? "OpenAI conversation turns can reuse the local ChatGPT/Codex subscription session."
    : "OpenAI uses API billing when selected.";

  return providerChain
    ? `Strada control plane ready. Primary orchestration pool: ${providerChain}. ${openaiMode}`
    : `Strada control plane ready. ${openaiMode}`;
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const runtimePaths = resolveRuntimePaths({ moduleUrl: import.meta.url });
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
        intervalHours: 24,
        idleTimeoutMin: 5,
        channel: "stable",
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
          ? "Built dist/ artifacts are missing, but this source checkout can still run through `strada` / `./strada`."
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
      fix: "Run `strada setup --web`, `strada setup --terminal`, or `npm run setup:web`.",
    });
  } else if (configResult.kind === "error") {
    checks.push({
      id: "config",
      label: "Configuration",
      status: "fail",
      detail: `Config validation failed: ${configResult.error}`,
      fix: "Re-run `strada setup --web` or `strada setup --terminal` and save a valid configuration.",
    });
  } else {
    checks.push({
      id: "config",
      label: "Configuration",
      status: "pass",
      detail: `Loaded .env successfully. Language=${configResult.value.language}, web port=${configResult.value.web.port}.`,
    });

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
    const preflightResult = await preflightResponseProviders(
      requestedResponseProviders,
      collectProviderCredentials(configResult.value),
      configResult.value.providerModels,
    );
    if (preflightResult.failures.length > 0) {
      providerCheck.status = "fail";
      providerCheck.detail =
        `${providerCheck.detail} Failed preflight: ${formatProviderPreflightFailures(preflightResult.failures)}`;
      providerCheck.fix =
        "Re-run `strada setup` and fix the failing response-worker credentials before starting Strada.";
    }
    checks.push(providerCheck);

    const responseChain = configResult.value.providerChain
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      ?? [];
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
          : "Sign in again with Codex/ChatGPT on this machine, or re-run `strada setup` and switch OpenAI to API-key mode.",
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
  }

  return {
    status: computeOverallStatus(checks),
    checks,
  };
}

export async function runDoctorCommand(): Promise<number> {
  const report = await collectDoctorReport();

  console.log("\nStrada Doctor");
  console.log("=============\n");
  for (const check of report.checks) {
    console.log(`[${formatStatus(check.status)}] ${check.label}`);
    console.log(`  ${check.detail}`);
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
