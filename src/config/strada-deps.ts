/**
 * Strada Framework Dependency Validation
 *
 * Checks Unity project Packages/ directory for strada.core (required)
 * and strada.modules (optional). Never throws — returns status for
 * the Orchestrator to decide how to handle.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ok, err } from "../types/index.js";
import type { Result } from "../types/index.js";
import {
  DEFAULT_STRADA_CORE_REPO_URL,
  DEFAULT_STRADA_MCP_REPO_URL,
  DEFAULT_STRADA_MODULES_REPO_URL,
  type StradaDependencyConfig,
} from "./config.js";

export interface StradaDepsStatus {
  readonly coreInstalled: boolean;
  readonly corePath: string | null;
  readonly coreVersion?: string | null;
  readonly coreSource?: StradaDepInstallSource | null;
  readonly modulesInstalled: boolean;
  readonly modulesPath: string | null;
  readonly modulesVersion?: string | null;
  readonly modulesSource?: StradaDepInstallSource | null;
  readonly mcpInstalled: boolean;
  readonly mcpPath: string | null;
  readonly mcpVersion: string | null;
  readonly mcpSource?: StradaDepInstallSource | null;
  readonly warnings: string[];
}

export type StradaDepInstallSource =
  | "package-directory"
  | "manifest"
  | "project-local"
  | "configured-path"
  | "sibling-checkout"
  | "global-install";

export interface McpRecommendation {
  readonly recommended: boolean;
  readonly reason: string;
  readonly featureList: string[];
  readonly discoveryHint?: string;
  readonly installHint?: string;
}

export type McpInstallTarget = "assets" | "packages";

export interface StradaMcpInstallPlan {
  readonly target: McpInstallTarget;
  readonly submodulePath: string;
  readonly unityPackagePath: string;
  readonly manifestPath: string;
  readonly manifestDependency: string;
  readonly npmInstallRan: boolean;
}

export interface StradaMcpInstall {
  readonly installed: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly source?: StradaDepInstallSource | null;
}

const CORE_NAMES = ["strada.core", "com.strada.core", "Strada.Core", "Submodules/Strada.Core"] as const;
const MODULES_NAMES = ["strada.modules", "com.strada.modules", "Strada.Modules", "Submodules/Strada.Modules"] as const;
const STRADA_MCP_PACKAGE_NAME = "strada-mcp";
const DEFAULT_STRADA_DEPENDENCY_CONFIG: StradaDependencyConfig = {
  coreRepoUrl: DEFAULT_STRADA_CORE_REPO_URL,
  modulesRepoUrl: DEFAULT_STRADA_MODULES_REPO_URL,
  mcpRepoUrl: DEFAULT_STRADA_MCP_REPO_URL,
  unityBridgePort: 7691,
  unityBridgeAutoConnect: true,
  unityBridgeTimeout: 5000,
  scriptExecuteEnabled: false,
  reflectionInvokeEnabled: false,
};

const TARGET_PATHS = {
  core: "Packages/Submodules/Strada.Core",
  modules: "Packages/Submodules/Strada.Modules",
} as const;
const DEP_MANIFEST_ENTRIES: Record<"core" | "modules", { name: string; reference: string }> = {
  core: { name: "com.strada.core", reference: "file:Submodules/Strada.Core" },
  modules: { name: "com.strada.modules", reference: "file:Submodules/Strada.Modules" },
};
const MCP_SUBMODULE_TARGETS: Record<McpInstallTarget, string> = {
  packages: "Packages/Submodules/Strada.MCP",
  assets: "Assets/Strada.MCP",
};
const MCP_MANIFEST_REFERENCES: Record<McpInstallTarget, string> = {
  packages: "file:Submodules/Strada.MCP/unity-package/com.strada.mcp",
  assets: "file:../Assets/Strada.MCP/unity-package/com.strada.mcp",
};
const MCP_PROJECT_LOCAL_CANDIDATES = [
  MCP_SUBMODULE_TARGETS.packages,
  MCP_SUBMODULE_TARGETS.assets,
  "Packages/Strada.MCP",
  "Assets/Strada.MCP",
] as const;
const MCP_FEATURE_LIST = [
  "Live Unity console reading and error analysis",
  "Unity editor command execution and menu actions",
  "Scene, prefab, GameObject, and component operations",
  "Project, player, quality, build settings, and editor preferences control",
  "Unity Package Manager operations across registry, git, local, and supported asset imports",
  "Multi-platform Unity builds for Android, iOS, WebGL, and standalone targets",
] as const;

function resolveStradaDependencyConfig(
  config?: Partial<StradaDependencyConfig>,
): StradaDependencyConfig {
  const mcpPath = config?.mcpPath?.trim();
  return {
    coreRepoUrl: config?.coreRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.coreRepoUrl,
    modulesRepoUrl: config?.modulesRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.modulesRepoUrl,
    unityBridgePort: config?.unityBridgePort ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.unityBridgePort,
    unityBridgeAutoConnect: config?.unityBridgeAutoConnect ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.unityBridgeAutoConnect,
    unityBridgeTimeout: config?.unityBridgeTimeout ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.unityBridgeTimeout,
    unityEditorPath: config?.unityEditorPath,
    scriptExecuteEnabled: config?.scriptExecuteEnabled ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.scriptExecuteEnabled,
    reflectionInvokeEnabled: config?.reflectionInvokeEnabled ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.reflectionInvokeEnabled,
    mcpRepoUrl: config?.mcpRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.mcpRepoUrl,
    ...(mcpPath ? { mcpPath } : {}),
  };
}

/**
 * Check if Strada dependencies are installed in the Unity project.
 * Never throws — returns a status object.
 */
export function checkStradaDeps(
  unityProjectPath: string,
  config?: Partial<StradaDependencyConfig>,
): StradaDepsStatus {
  const resolvedConfig = resolveStradaDependencyConfig(config);
  const warnings: string[] = [];
  const packagesDir = join(unityProjectPath, "Packages");
  const configuredMcpPath = resolvedConfig.mcpPath;

  let packagesExists = false;
  try { packagesExists = existsSync(packagesDir) && statSync(packagesDir).isDirectory(); } catch { /* TOCTOU safe */ }
  if (!packagesExists) {
    warnings.push("Packages/ directory not found in Unity project");
    if (configuredMcpPath && !readStradaMcpInstall(configuredMcpPath)) {
      warnings.push("Configured STRADA_MCP_PATH is not a valid Strada.MCP package root");
    }
    const mcp = detectStradaMcp(resolvedConfig, unityProjectPath);
    return {
      coreInstalled: false,
      corePath: null,
      coreVersion: null,
      coreSource: null,
      modulesInstalled: false,
      modulesPath: null,
      modulesVersion: null,
      modulesSource: null,
      mcpInstalled: mcp.installed,
      mcpPath: mcp.path,
      mcpVersion: mcp.version,
      mcpSource: mcp.source ?? null,
      warnings,
    };
  }

  const corePath = findPackage(packagesDir, CORE_NAMES);
  const modulesPath = findPackage(packagesDir, MODULES_NAMES);
  const coreVersion = corePath ? readPackageVersion(corePath) : null;
  const modulesVersion = modulesPath ? readPackageVersion(modulesPath) : null;

  // Fallback: check manifest.json
  const coreInManifest = !corePath && checkManifest(packagesDir, CORE_NAMES);
  const modulesInManifest = !modulesPath && checkManifest(packagesDir, MODULES_NAMES);

  if (!corePath && !coreInManifest) {
    warnings.push(
      `Strada.Core not found. Searched: ${CORE_NAMES.join(", ")} in Packages/ and manifest.json`,
    );
  }

  if (!modulesPath && !modulesInManifest) {
    warnings.push(
      "Strada.Modules not installed (optional). Module-specific APIs will not be available.",
    );
  }

  // Detect Strada.MCP (Node.js tool, not a Unity package)
  if (configuredMcpPath && !readStradaMcpInstall(configuredMcpPath)) {
    warnings.push("Configured STRADA_MCP_PATH is not a valid Strada.MCP package root");
  }
  const mcp = detectStradaMcp(resolvedConfig, unityProjectPath);

  return {
    coreInstalled: corePath !== null || coreInManifest,
    corePath,
    coreVersion,
    coreSource: corePath ? "package-directory" : coreInManifest ? "manifest" : null,
    modulesInstalled: modulesPath !== null || modulesInManifest,
    modulesPath,
    modulesVersion,
    modulesSource: modulesPath ? "package-directory" : modulesInManifest ? "manifest" : null,
    mcpInstalled: mcp.installed,
    mcpPath: mcp.path,
    mcpVersion: mcp.version,
    mcpSource: mcp.source ?? null,
    warnings,
  };
}

/**
 * Install a Strada package as a git submodule.
 * Requires the Unity project to be a git repository.
 */
export async function installStradaDep(
  unityProjectPath: string,
  pkg: "core" | "modules",
  config?: Partial<StradaDependencyConfig>,
): Promise<Result<string, string>> {
  if (!isGitRepo(unityProjectPath)) {
    return err("Project is not a git repository. Cannot add submodule.");
  }

  const resolvedConfig = resolveStradaDependencyConfig(config);
  const repoUrl = pkg === "core" ? resolvedConfig.coreRepoUrl : resolvedConfig.modulesRepoUrl;
  const targetPath = TARGET_PATHS[pkg];
  const fullTargetPath = join(unityProjectPath, targetPath);
  const fullManifestPath = join(unityProjectPath, "Packages", "manifest.json");

  if (existsSync(fullTargetPath)) {
    return err(`Target path already exists: ${fullTargetPath}`);
  }

  try {
    await runExecFile("git", ["submodule", "add", repoUrl, targetPath], unityProjectPath);
  } catch (error) {
    return err(`Failed to add ${pkg} submodule: ${formatExecError(error)}`);
  }

  if (existsSync(fullManifestPath)) {
    const { name, reference } = DEP_MANIFEST_ENTRIES[pkg];
    try {
      updateUnityManifestDependency(fullManifestPath, name, reference);
    } catch (error) {
      return err(`Submodule was added, but Packages/manifest.json could not be updated: ${formatExecError(error)}`);
    }
  }

  return ok(fullTargetPath);
}

export async function installStradaMcpSubmodule(
  unityProjectPath: string,
  target: McpInstallTarget,
  config?: Partial<StradaDependencyConfig>,
): Promise<Result<StradaMcpInstallPlan, string>> {
  if (!isGitRepo(unityProjectPath)) {
    return err("Project is not a git repository. Cannot add Strada.MCP as a submodule.");
  }

  const resolvedConfig = resolveStradaDependencyConfig(config);
  const submodulePath = MCP_SUBMODULE_TARGETS[target];
  const manifestDependency = MCP_MANIFEST_REFERENCES[target];
  const fullSubmodulePath = join(unityProjectPath, submodulePath);
  const fullManifestPath = join(unityProjectPath, "Packages", "manifest.json");
  const unityPackagePath = join(fullSubmodulePath, "unity-package", "com.strada.mcp");

  if (existsSync(fullSubmodulePath)) {
    return err(`Target path already exists: ${fullSubmodulePath}`);
  }
  if (!existsSync(fullManifestPath)) {
    return err("Packages/manifest.json not found in Unity project.");
  }

  try {
    await runExecFile("git", ["submodule", "add", resolvedConfig.mcpRepoUrl, submodulePath], unityProjectPath);
  } catch (error) {
    return err(`Failed to add Strada.MCP submodule: ${formatExecError(error)}`);
  }

  try {
    updateUnityManifestDependency(fullManifestPath, "com.strada.mcp", manifestDependency);
  } catch (error) {
    return err(`Strada.MCP submodule was added, but Packages/manifest.json could not be updated: ${formatExecError(error)}`);
  }

  try {
    await runExecFile("npm", ["install", "--no-fund", "--no-audit"], fullSubmodulePath);
  } catch (error) {
    return err(`Strada.MCP submodule was added and manifest updated, but npm install failed: ${formatExecError(error)}`);
  }

  return ok({
    target,
    submodulePath: fullSubmodulePath,
    unityPackagePath,
    manifestPath: fullManifestPath,
    manifestDependency,
    npmInstallRan: true,
  });
}

/**
 * Detect Strada.MCP installation.
 * Checks: 1) configured STRADA_MCP_PATH
 *         2) sibling directory ../Strada.MCP relative to project root
 *         3) global npm install via `which strada-mcp`
 */
export function detectStradaMcp(
  config?: Partial<StradaDependencyConfig>,
  unityProjectPath?: string,
): StradaMcpInstall {
  const resolvedConfig = resolveStradaDependencyConfig(config);
  if (resolvedConfig.mcpPath) {
    const configuredInstall = readStradaMcpInstall(resolvedConfig.mcpPath, "configured-path");
    if (configuredInstall) {
      return configuredInstall;
    }
  }

  if (unityProjectPath) {
    const projectInstall = readProjectLocalStradaMcpInstall(unityProjectPath);
    if (projectInstall) {
      return projectInstall;
    }
  }

  // 1. Check sibling directory relative to Strada.Brain project root
  const brainRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const siblingPath = join(brainRoot, "..", "Strada.MCP");
  const siblingInstall = readStradaMcpInstall(siblingPath, "sibling-checkout");
  if (siblingInstall) {
    return siblingInstall;
  }

  // 2. Check global npm install
  try {
    const which = execFileSync("which", ["strada-mcp"], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim().replace(/[\r\n]/g, "");
    if (which) {
      const binDir = dirname(which);
      const globalPkgPath = join(binDir, "..", "lib", "node_modules", "strada-mcp");
      const globalInstall = readStradaMcpInstall(globalPkgPath, "global-install");
      if (globalInstall) {
        return globalInstall;
      }
    }
  } catch {
    // `which` failed — strada-mcp not on PATH
  }

  return { installed: false, path: null, version: null, source: null };
}

export function buildMcpRecommendation(
  status: StradaDepsStatus,
  config?: Partial<StradaDependencyConfig>,
): McpRecommendation {
  const discoveryHint = config?.mcpPath
    ? (status.mcpInstalled
        ? `STRADA_MCP_PATH is set and resolves to ${status.mcpPath}.`
        : `STRADA_MCP_PATH is set to ${config.mcpPath}, but that location is not a valid Strada.MCP package root. Brain also auto-detects a sibling ../Strada.MCP checkout when present.`)
    : (status.mcpInstalled
        ? (status.mcpPath?.includes("/Strada.MCP")
            ? `Strada.MCP was auto-detected at ${status.mcpPath}.`
            : `Strada.MCP was detected at ${status.mcpPath}.`)
        : "Brain will auto-detect a sibling ../Strada.MCP checkout or honor STRADA_MCP_PATH when provided.");

  if (status.mcpInstalled) {
    return {
      recommended: false,
      reason: `Strada.MCP is installed${status.mcpVersion ? ` (v${status.mcpVersion})` : ""}.`,
      featureList: [...MCP_FEATURE_LIST],
      discoveryHint,
    };
  }

  return {
    recommended: true,
    reason: "Strada.MCP is not installed. Installing it unlocks the live Unity runtime surface inside Strada.Brain.",
    featureList: [...MCP_FEATURE_LIST],
    discoveryHint,
    installHint: "Install Strada.MCP as a git submodule, wire com.strada.mcp into Packages/manifest.json, and bootstrap the checkout with npm install so Brain can load the runtime.",
  };
}

function readProjectLocalStradaMcpInstall(unityProjectPath: string): StradaMcpInstall | null {
  for (const relativePath of MCP_PROJECT_LOCAL_CANDIDATES) {
    const candidate = join(unityProjectPath, relativePath);
    const install = readStradaMcpInstall(candidate, "project-local");
    if (install) {
      return install;
    }
  }

  return null;
}

function readStradaMcpInstall(
  candidatePath: string,
  source?: StradaDepInstallSource,
): StradaMcpInstall | null {
  const packageJsonPath = join(candidatePath, "package.json");
  const metadata = readPackageMetadata(packageJsonPath);
  if (!metadata || metadata.name !== STRADA_MCP_PACKAGE_NAME) {
    return null;
  }

  return {
    installed: true,
    path: candidatePath,
    version: metadata.version ?? null,
    source: source ?? null,
  };
}

function readPackageMetadata(packageJsonPath: string): { name?: string; version?: string } | null {
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    return JSON.parse(content) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

function readPackageVersion(packagePath: string): string | null {
  return readPackageMetadata(join(packagePath, "package.json"))?.version ?? null;
}

function findPackage(packagesDir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = join(packagesDir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch { /* TOCTOU: directory removed between existsSync and statSync */ }
  }
  return null;
}

function checkManifest(packagesDir: string, names: readonly string[]): boolean {
  const manifestPath = join(packagesDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;

  try {
    const content = readFileSync(manifestPath, "utf-8");
    const lowerContent = content.toLowerCase();
    return names.some((name) => lowerContent.includes(name.toLowerCase()));
  } catch {
    return false;
  }
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function updateUnityManifestDependency(
  manifestPath: string,
  dependencyName: string,
  dependencyValue: string,
): void {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  const dependencies = { ...(parsed.dependencies ?? {}) };
  dependencies[dependencyName] = dependencyValue;
  const next = {
    ...parsed,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
}

function runExecFile(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
}

function formatExecError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------------- *
 * Supported project matrix (plan 6.10)
 *
 * "Works on a Unity project" was never written down, so nothing could be
 * checked and the README claimed a surface nobody had bounded: the measure of
 * this item is that the demo moves to a SECOND MACHINE, and that only happens
 * when what a project must have is data rather than folklore.
 *
 * Everything below is data the doctor reads and the README contract test
 * compares against, so the three cannot drift: the matrix, the checker and the
 * claim are one source.
 *
 * Two honesty rules apply and are encoded in the row states:
 *   - `unknown` is what a check that could not decide returns. It is NOT `ok`.
 *   - `not-measured` is what a check that was never attempted returns — the
 *     second machine itself is the standing example: this process can only
 *     look at the project in front of it.
 * ------------------------------------------------------------------------- */

/** How much a matrix entry matters. */
export type ProjectRequirement = "required" | "recommended" | "optional";

/**
 * Per-row outcome.
 *
 * `missing` (the thing is not there) and `not-measured` (nothing looked) are
 * different answers and must never collapse — the same distinction
 * `delivery-package.ts` makes for evidence.
 */
export type MatrixRowStatus = "ok" | "missing" | "unsupported" | "unknown" | "not-measured";

/** The Unity Editor versions this system is bounded to. */
export interface SupportedUnityVersions {
  /** Inclusive floor. Anything below is `unsupported`, not `warn`. */
  readonly minInclusive: string;
  /** Exclusive ceiling, or null when none is declared. */
  readonly maxExclusive: string | null;
  /** Versions this checkout was actually exercised against. */
  readonly tested: readonly string[];
  /** Why the floor is where it is. */
  readonly reason: string;
}

/**
 * Unity 6 only.
 *
 * Not a preference: `scene-binding.ts` writes scenes and prefabs in Unity 6's
 * serialized shapes (`PrefabInstance` + stripped Transform + `SceneRoots`,
 * copied from a 6000.3 project file), and `unity-link-runner.ts` defaults to a
 * 6000.3 editor. A 2022 LTS project would be written in shapes its editor does
 * not read, and nothing in this repository has ever run against one.
 */
export const SUPPORTED_UNITY_VERSIONS: SupportedUnityVersions = {
  minInclusive: "6000.0.0f1",
  maxExclusive: null,
  tested: ["6000.3.22f1"],
  reason:
    "Scene/prefab writing and the editor launcher target Unity 6 serialized shapes (measured against 6000.3.22f1).",
};

/** Files/directories that make a directory a Unity project Brain can read. */
export const SUPPORTED_PROJECT_LAYOUT: readonly string[] = [
  "Assets",
  "ProjectSettings/ProjectVersion.txt",
  "Packages/manifest.json",
];

/** One Strada package in the matrix. */
export interface SupportedPackageSpec {
  /** Matrix row id — also the doctor's row id. */
  readonly id: string;
  /** Human label, and the string the README table must carry. */
  readonly label: string;
  readonly requirement: ProjectRequirement;
  /**
   * Version floor Brain ENFORCES, or null when it enforces none.
   *
   * Null is the honest answer for all three today: nothing in this repository
   * compares a Strada package version against a floor, so declaring one here
   * would be a claim no code makes. The detected version is still reported —
   * see `testedVersions` for what was actually exercised.
   */
  readonly minVersion: string | null;
  /** Versions this checkout has actually been exercised against, if any. */
  readonly testedVersions: readonly string[];
  /** What the system cannot do without it. Printed by the doctor as the cost. */
  readonly withoutIt: string;
}

/**
 * The Strada packages, with what each one buys.
 *
 * Strada.Core is `recommended`, not `required`, because Brain demonstrably runs
 * without it (reduced framework guidance) — that is the README's own claim and
 * `checkStradaDeps` already reports it as a warning rather than an error.
 * Strada.MCP is `recommended` for the same reason and named as required for the
 * live Unity surface: without it there is no console read, no build and no
 * playthrough verdict, so the play-through delivery gate can never be met.
 */
export const SUPPORTED_PROJECT_PACKAGES: readonly SupportedPackageSpec[] = [
  {
    id: "strada-core",
    label: "Strada.Core",
    requirement: "recommended",
    minVersion: null,
    testedVersions: [],
    withoutIt: "framework-aware guidance and Strada-shaped codegen degrade to generic C# assistance",
  },
  {
    id: "strada-modules",
    label: "Strada.Modules",
    requirement: "optional",
    minVersion: null,
    testedVersions: [],
    withoutIt: "module-specific APIs are unavailable; everything else is unaffected",
  },
  {
    id: "strada-mcp",
    label: "Strada.MCP",
    requirement: "recommended",
    minVersion: null,
    testedVersions: [],
    withoutIt:
      "the live Unity surface is gone: no console reads, no editor commands, no Unity builds and no playthrough verdict, so the play-through delivery gate cannot be met",
  },
];

/** One evaluated row of the matrix. */
export interface ProjectMatrixRow {
  readonly id: string;
  readonly label: string;
  readonly requirement: ProjectRequirement;
  readonly status: MatrixRowStatus;
  /** What was found, naming the concrete path/version. */
  readonly detail: string;
  /** How to satisfy the row. Absent when there is nothing to do. */
  readonly fix?: string;
}

/** The whole matrix, evaluated against one project on this machine. */
export interface ProjectSupportVerdict {
  /** True only when every `required` row is `ok`. Never true on `unknown`. */
  readonly supported: boolean;
  readonly rows: readonly ProjectMatrixRow[];
  /** Row labels by outcome, so a caller can name exactly what is wrong. */
  readonly missing: readonly string[];
  readonly unsupported: readonly string[];
  readonly unknown: readonly string[];
  readonly notMeasured: readonly string[];
  /** One sentence naming counts and every non-ok row. */
  readonly summary: string;
}

export interface ProjectSupportOptions {
  /** The project to judge — `config.unityProjectPath`. */
  readonly unityProjectPath: string;
  readonly config?: Partial<StradaDependencyConfig>;
  /** Reuse an existing {@link checkStradaDeps} result instead of re-scanning. */
  readonly deps?: StradaDepsStatus;
  /**
   * Editor binary to look for (`UNITY_EDITOR_PATH` / `STRADA_UNITY_BIN`, or the
   * launcher's default). Omitted means "nothing configured" — reported as
   * `unknown`, never as ok.
   */
  readonly unityEditorPath?: string | null;
}

/** A Unity version split into comparable parts. */
export interface UnityVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `f1`, `b3`, … — recorded, never compared. */
  readonly suffix: string;
}

/** Parse `6000.3.22f1`. Returns null on anything that is not a Unity version. */
export function parseUnityVersion(raw: string): UnityVersionParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)([a-z]\d+)?/iu.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    suffix: match[4] ?? "",
  };
}

/** -1 / 0 / 1 on the numeric triple. Lexicographic sort put 6000.3.9 above 6000.3.22. */
export function compareUnityVersions(a: UnityVersionParts, b: UnityVersionParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** What `ProjectSettings/ProjectVersion.txt` says, or why it does not say it. */
export interface UnityProjectVersionRead {
  readonly version: string | null;
  /** Absolute path that was read. */
  readonly path: string;
  /** Present when `version` is null: why nothing could be read. */
  readonly problem?: string;
}

export function readUnityProjectVersion(unityProjectPath: string): UnityProjectVersionRead {
  const file = join(unityProjectPath, "ProjectSettings", "ProjectVersion.txt");
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return { version: null, path: file, problem: "file is missing or unreadable" };
  }
  const match = /^m_EditorVersion:\s*(\S+)/mu.exec(content);
  if (!match?.[1]) {
    return { version: null, path: file, problem: "no m_EditorVersion line" };
  }
  return { version: match[1], path: file };
}

function unityVersionRangeText(): string {
  const { minInclusive, maxExclusive } = SUPPORTED_UNITY_VERSIONS;
  return maxExclusive ? `>= ${minInclusive} and < ${maxExclusive}` : `>= ${minInclusive}`;
}

function evaluateUnityEditorVersionRow(unityProjectPath: string): ProjectMatrixRow {
  const base = {
    id: "unity-editor-version",
    label: "Unity Editor version (project)",
    requirement: "required" as const,
  };
  const read = readUnityProjectVersion(unityProjectPath);
  const range = unityVersionRangeText();
  if (!read.version) {
    return {
      ...base,
      status: "unknown",
      detail: `Could not read the project's Unity version: ${read.path} — ${read.problem}. Supported: ${range}. NOT checked, not passed.`,
      fix: `Open the project in a supported Unity Editor once so it writes ProjectSettings/ProjectVersion.txt, or point UNITY_PROJECT_PATH at a real Unity project root.`,
    };
  }
  const parsed = parseUnityVersion(read.version);
  if (!parsed) {
    return {
      ...base,
      status: "unknown",
      detail: `${read.path} says m_EditorVersion: ${read.version}, which is not a version this checker can compare. Supported: ${range}.`,
      fix: "Report the version string — the matrix comparison needs to learn its shape.",
    };
  }
  const min = parseUnityVersion(SUPPORTED_UNITY_VERSIONS.minInclusive);
  if (min && compareUnityVersions(parsed, min) < 0) {
    return {
      ...base,
      status: "unsupported",
      detail: `Project is on Unity ${read.version}; the supported range is ${range} (tested: ${SUPPORTED_UNITY_VERSIONS.tested.join(", ")}). ${SUPPORTED_UNITY_VERSIONS.reason}`,
      fix: `Upgrade the Unity project to ${SUPPORTED_UNITY_VERSIONS.minInclusive} or newer, or use a project that is already on Unity 6.`,
    };
  }
  const max = SUPPORTED_UNITY_VERSIONS.maxExclusive
    ? parseUnityVersion(SUPPORTED_UNITY_VERSIONS.maxExclusive)
    : null;
  if (max && compareUnityVersions(parsed, max) >= 0) {
    return {
      ...base,
      status: "unsupported",
      detail: `Project is on Unity ${read.version}, at or above the declared ceiling ${SUPPORTED_UNITY_VERSIONS.maxExclusive} (tested: ${SUPPORTED_UNITY_VERSIONS.tested.join(", ")}).`,
      fix: `Use a project within ${range}.`,
    };
  }
  const tested = SUPPORTED_UNITY_VERSIONS.tested.includes(read.version);
  return {
    ...base,
    status: "ok",
    detail: tested
      ? `Project is on Unity ${read.version}, inside ${range} and in the tested set.`
      : `Project is on Unity ${read.version}, inside ${range} but NOT in the tested set (${SUPPORTED_UNITY_VERSIONS.tested.join(", ")}) — in range is not the same as measured.`,
  };
}

function evaluateLayoutRow(unityProjectPath: string): ProjectMatrixRow {
  const missing = SUPPORTED_PROJECT_LAYOUT.filter(
    (relative) => !existsSync(join(unityProjectPath, ...relative.split("/"))),
  );
  if (missing.length === 0) {
    return {
      id: "unity-project-layout",
      label: "Unity project layout",
      requirement: "required",
      status: "ok",
      detail: `${unityProjectPath} has ${SUPPORTED_PROJECT_LAYOUT.join(", ")}.`,
    };
  }
  return {
    id: "unity-project-layout",
    label: "Unity project layout",
    requirement: "required",
    status: "missing",
    detail: `${unityProjectPath} is missing ${missing.join(", ")} — a Unity project root must have ${SUPPORTED_PROJECT_LAYOUT.join(", ")}.`,
    fix: "Point UNITY_PROJECT_PATH at the directory that contains Assets/ and ProjectSettings/.",
  };
}

function evaluateGitRow(unityProjectPath: string): ProjectMatrixRow {
  const gitPath = join(unityProjectPath, ".git");
  if (existsSync(gitPath)) {
    return {
      id: "project-git",
      label: "Project is a git repository",
      requirement: "required",
      status: "ok",
      detail: `${gitPath} exists — task leases can take worktrees and the Strada packages can be added as submodules.`,
    };
  }
  return {
    id: "project-git",
    label: "Project is a git repository",
    requirement: "required",
    status: "missing",
    detail: `${unityProjectPath} is not a git checkout. Every leased task runs in its own git worktree off the project root, and installStradaDep/installStradaMcpSubmodule refuse without a repository.`,
    fix: `Run \`git init\` in ${unityProjectPath} and commit, or clone the project instead of copying it.`,
  };
}

function evaluatePackageRow(
  spec: SupportedPackageSpec,
  installed: boolean,
  path: string | null,
  version: string | null | undefined,
  source: StradaDepInstallSource | null | undefined,
): ProjectMatrixRow {
  const floor = spec.minVersion
    ? `Minimum ${spec.minVersion}.`
    : "No version floor is enforced by Brain — the version is recorded, not gated.";
  if (!installed) {
    return {
      id: spec.id,
      label: spec.label,
      requirement: spec.requirement,
      status: "missing",
      detail: `${spec.label} was not found. Without it, ${spec.withoutIt}.`,
      fix:
        spec.id === "strada-mcp"
          ? "Install Strada.MCP (submodule under Packages/Submodules or Assets/, or STRADA_MCP_PATH), wire com.strada.mcp into Packages/manifest.json and run npm install in it."
          : `Add ${spec.label} to the Unity project (git submodule under Packages/Submodules + a Packages/manifest.json dependency).`,
    };
  }
  const versionText = version
    ? `v${version}`
    : "version not declared in its package.json";
  return {
    id: spec.id,
    label: spec.label,
    requirement: spec.requirement,
    status: "ok",
    detail: `${spec.label} installed at ${path ?? "an unrecorded path"} (${versionText}${source ? `, via ${source}` : ""}). ${floor}`,
  };
}

/**
 * Whether an installed Strada.MCP can actually be loaded.
 *
 * `strada-mcp-tool-loader.ts` imports `<root>/src/**.ts` through tsx or
 * `<root>/dist/**.js`; either way the module's own imports resolve against
 * `<root>/node_modules`. A checkout without it registers zero Unity tools and
 * says nothing about why (observed on a vendored submodule), so this is the one
 * row that catches a present-but-inert install.
 */
function evaluateMcpRuntimeRow(mcpInstalled: boolean, mcpPath: string | null): ProjectMatrixRow {
  const base = {
    id: "strada-mcp-runnable",
    label: "Strada.MCP dependencies installed",
    requirement: "recommended" as const,
  };
  if (!mcpInstalled || !mcpPath) {
    return {
      ...base,
      status: "not-measured",
      detail: "Strada.MCP is not installed, so nothing looked at its dependency tree.",
    };
  }
  const hasNodeModules = existsSync(join(mcpPath, "node_modules"));
  const hasSource = existsSync(join(mcpPath, "src")) || existsSync(join(mcpPath, "dist"));
  const problems: string[] = [];
  if (!hasNodeModules) problems.push(`${join(mcpPath, "node_modules")} is absent`);
  if (!hasSource) problems.push(`neither ${join(mcpPath, "src")} nor ${join(mcpPath, "dist")} exists`);
  if (problems.length > 0) {
    return {
      ...base,
      status: "missing",
      detail: `Strada.MCP is present at ${mcpPath} but cannot be loaded: ${problems.join("; ")}. The tool loader would register zero Unity tools without saying why.`,
      fix: `Run \`npm install\` in ${mcpPath} (and \`npm run build\` if it ships dist/ only).`,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${mcpPath} has node_modules and a loadable src/ or dist/.`,
  };
}

function evaluateEditorBinaryRow(unityEditorPath: string | null | undefined): ProjectMatrixRow {
  const base = {
    id: "unity-editor-binary",
    label: "Unity Editor installed on this machine",
    requirement: "recommended" as const,
  };
  if (!unityEditorPath) {
    return {
      ...base,
      status: "unknown",
      detail:
        "No Unity Editor path is configured (UNITY_EDITOR_PATH / STRADA_UNITY_BIN), so whether a supported editor is installed here was not determined. Unity builds, scene verification and playthrough verdicts need one.",
      fix: "Set UNITY_EDITOR_PATH (or STRADA_UNITY_BIN) to the Unity 6 editor binary on this machine.",
    };
  }
  if (!existsSync(unityEditorPath)) {
    return {
      ...base,
      status: "missing",
      detail: `The configured Unity Editor binary is not at ${unityEditorPath}. Unity builds and playthrough verdicts cannot run.`,
      fix: "Install the Unity 6 editor or correct UNITY_EDITOR_PATH / STRADA_UNITY_BIN.",
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `Unity Editor binary present at ${unityEditorPath}. Its version was NOT launched or compared — presence only.`,
  };
}

/**
 * The row that exists because the measure of this item is a second machine.
 *
 * A process can only look at the machine it runs on. Claiming the matrix holds
 * elsewhere would be exactly the false green this project keeps finding, so the
 * row is permanently `not-measured` and says what to do about it.
 */
function secondMachineRow(unityProjectPath: string): ProjectMatrixRow {
  return {
    id: "second-machine",
    label: "Another machine satisfies this matrix",
    requirement: "optional",
    status: "not-measured",
    detail: `Everything above was measured against ${unityProjectPath} on this host only. Whether a second machine has the Unity Editor, initialized submodules and Strada.MCP dependencies is not measured here.`,
    fix: "Run `strada doctor` on that machine and compare the two matrices.",
  };
}

/**
 * Judge one project against {@link SUPPORTED_PROJECT_PACKAGES} and
 * {@link SUPPORTED_UNITY_VERSIONS}.
 *
 * Never throws; every row carries the concrete path or version it looked at so
 * a failure names the thing instead of "setup incomplete".
 */
/**
 * The deps shape for "nothing was scanned": no project path means no package
 * could be looked for, and each row says so instead of claiming absence.
 */
const UNSCANNED_DEPS: StradaDepsStatus = {
  coreInstalled: false,
  corePath: null,
  coreVersion: null,
  coreSource: null,
  modulesInstalled: false,
  modulesPath: null,
  modulesVersion: null,
  modulesSource: null,
  mcpInstalled: false,
  mcpPath: null,
  mcpVersion: null,
  mcpSource: null,
  warnings: ["No Unity project is configured, so no Strada package was looked for."],
};

export function evaluateProjectSupport(opts: ProjectSupportOptions): ProjectSupportVerdict {
  // NO PROJECT IS AN ANSWER, NOT A CRASH. `unityProjectPath` is optional in a
  // loaded config, and every project row joins paths onto it: judging an
  // unconfigured install threw `The "path" argument must be of type string`
  // out of the doctor, which took the whole report down with it.
  const projectPath = (opts.unityProjectPath ?? "").trim();
  const deps = opts.deps ?? (projectPath ? checkStradaDeps(projectPath, opts.config) : UNSCANNED_DEPS);
  const byId = new Map(SUPPORTED_PROJECT_PACKAGES.map((spec) => [spec.id, spec]));
  const core = byId.get("strada-core")!;
  const modules = byId.get("strada-modules")!;
  const mcp = byId.get("strada-mcp")!;

  const projectRows: ProjectMatrixRow[] = projectPath
    ? [
        evaluateLayoutRow(projectPath),
        evaluateUnityEditorVersionRow(projectPath),
        evaluateGitRow(projectPath),
      ]
    : [
        {
          id: "unity-project-layout",
          label: "Unity project layout",
          requirement: "required",
          status: "missing",
          detail: "No Unity project is configured (UNITY_PROJECT_PATH is unset), so no project row could be judged.",
          fix: "Set UNITY_PROJECT_PATH to the directory that contains Assets/ and ProjectSettings/.",
        },
      ];

  const rows: ProjectMatrixRow[] = [
    ...projectRows,
    evaluatePackageRow(core, deps.coreInstalled, deps.corePath, deps.coreVersion, deps.coreSource),
    evaluatePackageRow(modules, deps.modulesInstalled, deps.modulesPath, deps.modulesVersion, deps.modulesSource),
    evaluatePackageRow(mcp, deps.mcpInstalled, deps.mcpPath, deps.mcpVersion, deps.mcpSource),
    evaluateMcpRuntimeRow(deps.mcpInstalled, deps.mcpPath),
    evaluateEditorBinaryRow(opts.unityEditorPath),
    ...(projectPath ? [secondMachineRow(projectPath)] : []),
  ];

  const labelsWith = (status: MatrixRowStatus): string[] =>
    rows.filter((row) => row.status === status).map((row) => row.label);
  const missing = labelsWith("missing");
  const unsupported = labelsWith("unsupported");
  const unknown = labelsWith("unknown");
  const notMeasured = labelsWith("not-measured");
  const supported = rows
    .filter((row) => row.requirement === "required")
    .every((row) => row.status === "ok");

  const parts = [
    `Supported project matrix: ${rows.filter((r) => r.status === "ok").length}/${rows.length} rows ok`,
  ];
  if (unsupported.length > 0) parts.push(`unsupported: ${unsupported.join(", ")}`);
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
  if (unknown.length > 0) parts.push(`not determined: ${unknown.join(", ")}`);
  if (notMeasured.length > 0) parts.push(`not measured: ${notMeasured.join(", ")}`);

  return {
    supported,
    rows,
    missing,
    unsupported,
    unknown,
    notMeasured,
    summary: `${parts.join("; ")}.`,
  };
}

/** One `- [STATUS] label — detail` line per row, for a CLI to print. */
export function formatProjectMatrix(verdict: ProjectSupportVerdict): string[] {
  return verdict.rows.map((row) => {
    const status = row.status === "not-measured" ? "NOT MEASURED" : row.status.toUpperCase();
    const fix = row.fix && row.status !== "ok" ? ` Fix: ${row.fix}` : "";
    return `- [${status}] ${row.label} (${row.requirement}) — ${row.detail}${fix}`;
  });
}
