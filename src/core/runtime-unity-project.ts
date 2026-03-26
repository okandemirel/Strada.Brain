import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { platform as getPlatform } from "node:os";
import { normalize } from "node:path";

interface SpawnSyncResultLike {
  readonly stdout: string;
  readonly status: number | null;
  readonly error?: Error;
}

type SpawnSyncLike = (
  command: string,
  args: readonly string[],
) => SpawnSyncResultLike;

interface RuntimeUnityProjectDeps {
  spawnSync?: SpawnSyncLike;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
}

export interface RuntimeUnityProjectResolution {
  readonly configuredProjectPath: string;
  readonly effectiveProjectPath: string;
  readonly detectedProjectPaths: readonly string[];
  readonly source: "configured";
  readonly notice?: string;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeProjectPath(projectPath: string, currentPlatform: NodeJS.Platform): string {
  const normalized = normalize(projectPath).replace(/[\\/]+$/, "");
  return currentPlatform === "win32" ? normalized.toLowerCase() : normalized;
}

export function parseUnityProjectPathFromCommandLine(commandLine: string): string | null {
  const match = commandLine.match(/(?:^|\s)-projectpath\s+(.+?)(?=\s+-[A-Za-z]|$)/i);
  if (!match?.[1]) {
    return null;
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function getUnityCommandLines(
  currentPlatform: NodeJS.Platform,
  spawnSyncImpl: SpawnSyncLike,
): string[] {
  const command = currentPlatform === "win32" ? "powershell.exe" : "ps";
  const args = currentPlatform === "win32"
    ? [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object {$_.Name -like 'Unity*'} | Select-Object -ExpandProperty CommandLine",
    ]
    : ["-ax", "-o", "command="];

  try {
    const result = spawnSyncImpl(command, args);
    if (result.error || result.status !== 0) {
      return [];
    }
    return result.stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export function detectActiveUnityProjectPaths(
  deps: RuntimeUnityProjectDeps = {},
): string[] {
  const currentPlatform = deps.platform ?? getPlatform();
  const spawnSyncImpl = deps.spawnSync ?? ((command, args) =>
    spawnSync(command, args, { encoding: "utf8", stdio: "pipe" }) as unknown as SpawnSyncResultLike);
  const pathExists = deps.existsSync ?? existsSync;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const commandLines = getUnityCommandLines(currentPlatform, spawnSyncImpl);
  const seen = new Set<string>();
  const detected: string[] = [];

  for (const commandLine of commandLines) {
    const projectPath = parseUnityProjectPathFromCommandLine(commandLine);
    if (!projectPath || !pathExists(projectPath) || !isDirectory(projectPath)) {
      continue;
    }

    const normalized = normalizeProjectPath(projectPath, currentPlatform);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    detected.push(projectPath);
  }

  return detected;
}

export function resolveRuntimeUnityProjectPath(
  configuredProjectPath: string,
  deps: RuntimeUnityProjectDeps = {},
): RuntimeUnityProjectResolution {
  const currentPlatform = deps.platform ?? getPlatform();
  const detectedProjectPaths = detectActiveUnityProjectPaths({
    ...deps,
    platform: currentPlatform,
  });
  const configuredNormalized = normalizeProjectPath(configuredProjectPath, currentPlatform);
  const configuredMatchesActive = detectedProjectPaths.some((projectPath) =>
    normalizeProjectPath(projectPath, currentPlatform) === configuredNormalized
  );

  if (configuredMatchesActive || detectedProjectPaths.length === 0) {
    return {
      configuredProjectPath,
      effectiveProjectPath: configuredProjectPath,
      detectedProjectPaths,
      source: "configured",
    };
  }

  if (detectedProjectPaths.length === 1) {
    const activeProjectPath = detectedProjectPaths[0];
    if (!activeProjectPath) {
      return {
        configuredProjectPath,
        effectiveProjectPath: configuredProjectPath,
        detectedProjectPaths,
        source: "configured",
      };
    }
    return {
      configuredProjectPath,
      effectiveProjectPath: configuredProjectPath,
      detectedProjectPaths,
      source: "configured",
      notice:
        `Configured UNITY_PROJECT_PATH points to ${configuredProjectPath}, ` +
        `but the only active Unity editor project is ${activeProjectPath}. ` +
        "Strada will stay scoped to the configured project; update setup if you intended to switch projects.",
    };
  }

  return {
    configuredProjectPath,
    effectiveProjectPath: configuredProjectPath,
    detectedProjectPaths,
    source: "configured",
    notice:
      `Configured UNITY_PROJECT_PATH points to ${configuredProjectPath}, ` +
      `but active Unity editors were detected for ${detectedProjectPaths.join(", ")}. ` +
      "Strada kept the configured project because the active editor selection is ambiguous.",
  };
}
