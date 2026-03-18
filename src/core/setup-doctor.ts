/* eslint-disable no-console -- doctor command is a user-facing diagnostic CLI */
import fs from "node:fs";
import path from "node:path";
import { loadConfigSafe, type Config } from "../config/config.js";
import { resolveEmbeddingProvider, describeEmbeddingResolutionFailure } from "../rag/embeddings/embedding-resolver.js";
import { AutoUpdater } from "./auto-updater.js";
import { ChannelActivityRegistry } from "./channel-activity-registry.js";

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

export function collectDoctorReport(options: DoctorOptions = {}): DoctorReport {
  const installRoot = options.installRoot ?? AutoUpdater.resolveInstallRoot();
  const configRoot = options.configRoot ?? process.cwd();
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
  checks.push({
    id: "install-method",
    label: "Install method",
    status: "pass",
    detail: `Detected ${updater.detectInstallMethod()} install rooted at ${installRoot}.`,
  });

  const distIndexPath = path.join(installRoot, "dist", "index.js");
  const webStaticPath = path.join(installRoot, "dist", "channels", "web", "static", "index.html");
  const buildReady = fs.existsSync(distIndexPath) && fs.existsSync(webStaticPath);
  checks.push({
    id: "build",
    label: "Build artifacts",
    status: buildReady ? "pass" : "fail",
    detail: buildReady
      ? "CLI and embedded web dashboard assets are built."
      : "Built CLI/web assets are missing from dist/.",
    fix: buildReady ? undefined : "Run `npm run bootstrap` from the source checkout.",
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

    checks.push({
      id: "providers",
      label: "Response workers",
      status: "pass",
      detail: summarizeResponseWorker(configResult.value),
    });

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
  const report = collectDoctorReport();

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
