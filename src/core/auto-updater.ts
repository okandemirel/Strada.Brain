import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { getLoggerSafe } from "../utils/logger.js";
import {
  clearUpdateHold, describeRollback, describeSpan, describeUpdateHold, describeWhen, readUpdateHold, recordUpdateEvent,
  writeUpdateHold, type RollbackOutcome, type UpdateEventKind, type UpdateHold,
} from "./update-history.js";
import { planTreeKill } from "../utils/process-runner.js";
import { resolveRuntimePaths } from "../common/runtime-paths.js";
import { installLockPath, installRootKey, installStateDir } from "./runtime-lock.js";
import {
  getProcessBootStart,
  getProcessStartTime,
  readProcessBootStart,
  readProcessStartTime,
  START_TIME_MARGIN_MS,
} from "./process-start-time.js";

export { readProcessStartTime };

const VERSION_CHECK_TIMEOUT = 30_000;
const UPDATE_TIMEOUT = 5 * 60 * 1000;
/** The least a holder that cannot be identified keeps the lock; see maxUpdateDurationMs. */
const STALE_LOCK_MAX_AGE = 30 * 60 * 1000;
/**
 * Boot smoke budget. The script itself gives the daemon BOOT_SMOKE_TIMEOUT_S
 * (120s default) to answer /health, plus shutdown; 5 minutes covers a slow
 * runner without letting a wedged boot hold the updater open forever.
 */
const BOOT_SMOKE_TIMEOUT = 5 * 60 * 1000;
/**
 * Default budget, in minutes, for each `npm install` / `npm run build` of an
 * update (AUTO_UPDATE_BUILD_TIMEOUT_MIN). A fixed 5 minutes timed out seven
 * builds in a row on the daemon host (2026-09-18 21:55 .. 09-20 10:34), after
 * two installs that took ~5 minutes apiece; the same build measured 69 s at
 * load average 30-106 there (2026-10-11). Three times the budget they overran.
 */
const DEFAULT_BUILD_TIMEOUT_MIN = 15;
/** After N consecutive failed updates the next one waits 2^(N-1) check intervals, at most 2^this. */
const MAX_BACKOFF_DOUBLINGS = 3;
/** How much of a failed command's output its error keeps: the end, where the cause is. */
const OUTPUT_TAIL_CHARS = 1500;
/** How often a pending update, or a restart after one, looks again for idleness. */
const IDLE_POLL_MS = 30_000;
/** How often a restart that waits for idleness says so in the log. */
const RESTART_WAIT_LOG_EVERY_MS = 30 * 60_000;
/**
 * After this long a waiting restart asks the operator to restart by hand. It
 * never forces one: aborting the work that keeps it waiting is what the wait
 * is for (audit core-bootstrap#1).
 */
const RESTART_WAIT_WARN_AFTER_MS = 2 * 60 * 60_000;

type LockPackages = Record<string, { version?: string; optional?: boolean } | undefined>;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Whether `dir`'s node_modules holds what its manifests ask for, judged
 * against the hidden lockfile `npm install` leaves in node_modules. The pull's
 * own diff decided this before (review of 7fc26d9f): a manual pull that
 * changed web-portal/package-lock.json without an install was never in a later
 * diff, so every update failed at the build; and every Version Bump commit
 * touches both manifests, so the root reinstalled on every update. Optional
 * packages may be missing (another platform's binaries); anything else missing
 * or at another version, or a tree that cannot be read, is stale. A portal
 * build run without dependencies leaves only node_modules/.tmp, no hidden
 * lockfile.
 */
function dependenciesInstalled(dir: string): boolean {
  const installed = readJson<{ packages?: LockPackages }>(path.join(dir, "node_modules", ".package-lock.json"))?.packages;
  const wanted = readJson<{ packages?: LockPackages }>(path.join(dir, "package-lock.json"))?.packages;
  if (!installed || !wanted) return false;
  for (const [key, want] of Object.entries(wanted)) {
    if (!key.startsWith("node_modules/") || !want) continue;
    const have = installed[key];
    if (have ? have.version !== want.version : !want.optional) return false;
  }
  // A dependency added to package.json without its lockfile is in neither.
  const manifest = readJson<{ dependencies?: object; devDependencies?: object }>(path.join(dir, "package.json"));
  return Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })
    .every((name) => installed[`node_modules/${name}`] !== undefined);
}

export type InstallMethod = "npm-global" | "npm-local" | "git";

export interface AutoUpdateConfig {
  enabled: boolean;
  intervalHours: number;
  idleTimeoutMin: number;
  channel: "stable" | "latest";
  notify: boolean;
  autoRestart: boolean;
  autoRestartDelayMs?: number;
  /** Minutes each install or build step of an update may take. Default DEFAULT_BUILD_TIMEOUT_MIN. */
  buildTimeoutMin?: number;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  /** The remote commit a git check found; what a failed update is remembered by. */
  latestRevision?: string | null;
  /** Set when an update is available but a failed one holds it back: why, and until when. */
  heldBack?: string;
  error: string | null;
}

function tailOf(text: string, max = OUTPUT_TAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/**
 * A failure for a log line or a notice: its first line (which command) and
 * the END of the rest. Keeping the first 600 characters, as before, kept npm's
 * warnings and dropped the compiler error after them.
 */
function describeFailure(err: unknown, max = 1200): string {
  const message = (err instanceof Error ? err.message : String(err)).trim();
  if (message.length <= max) return message;
  const firstLine = message.split("\n", 1)[0]!.slice(0, 200);
  return `${firstLine} … ${message.slice(-(max - firstLine.length - 3))}`;
}

export interface RuntimeProcessInfo {
  pid: number;
  cwd: string | null;
  command: string;
}

export interface LocalRuntimeInspection {
  installRoot: string;
  runtimes: RuntimeProcessInfo[];
  matchingRuntime: RuntimeProcessInfo | null;
}

interface BackgroundExecutorLike {
  hasRunningTasks(): boolean;
}

interface LockContent {
  pid: number;
  timestamp: number;
  startTime?: number;
  /** The holder's start counted from boot (Linux), which no wall-clock step moves. */
  bootStart?: string;
  token?: string;
}

interface AutoUpdaterOptions {
  installRoot?: string;
  globalNpmRootResolver?: () => string | null;
  commandRunner?: (
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ) => Promise<string>;
  sourceLauncherRefresher?: () => Promise<void>;
  isDaemonProcess?: () => boolean;
  healthChecker?: () => Promise<void>;
  runtimeInspector?: () => Promise<RuntimeProcessInfo[]>;
  /** Writable config root the update lock lives under (COR-21). Default: this install's config root. */
  stateRoot?: string;
}

/** An install root nobody may write to: the legacy lock mirror is skipped, never forced. */
const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOENT"]);

export class AutoUpdater {
  private readonly config: AutoUpdateConfig;
  private readonly registry: ChannelActivityRegistry;
  private readonly executor: BackgroundExecutorLike;
  private readonly installRoot: string;
  private readonly globalNpmRootResolver?: () => string | null;
  private readonly commandRunner?: (
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ) => Promise<string>;
  private readonly sourceLauncherRefresher?: () => Promise<void>;
  private readonly isDaemonProcess: () => boolean;
  private readonly healthChecker?: () => Promise<void>;
  private readonly runtimeInspector?: () => Promise<RuntimeProcessInfo[]>;
  private stateRoot: string | undefined;
  private installMethod: InstallMethod | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pendingVersion: string | null = null;
  /** The commit (git) or version (npm) the last check found; null for a pending update resumed from disk. */
  private pendingTarget: string | null = null;
  /** The hold this process last announced, so a held-back check says so once, not every interval. */
  private announcedHoldAt: number | null = null;
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private notifyFn: ((msg: string) => void) | null = null;

  private getPendingUpdatePath(): string {
    return path.join(this.installRoot, ".strada", "pending-update");
  }

  private savePendingVersion(): void {
    try {
      const pendingPath = this.getPendingUpdatePath();
      const pendingDir = path.dirname(pendingPath);
      if (!fs.existsSync(pendingDir)) {
        fs.mkdirSync(pendingDir, { recursive: true });
      }
      if (this.pendingVersion) {
        fs.writeFileSync(pendingPath, this.pendingVersion, "utf-8");
      } else {
        if (fs.existsSync(pendingPath)) {
          fs.unlinkSync(pendingPath);
        }
      }
    } catch {
      // Best-effort persistence
    }
  }

  private loadPendingVersion(): void {
    try {
      const pendingPath = this.getPendingUpdatePath();
      if (fs.existsSync(pendingPath)) {
        this.pendingVersion = fs.readFileSync(pendingPath, "utf-8").trim();
        if (this.pendingVersion.length === 0) {
          this.pendingVersion = null;
        }
      }
    } catch {
      this.pendingVersion = null;
    }
  }

  private clearPendingVersion(): void {
    this.pendingVersion = null;
    this.pendingTarget = null;
    this.savePendingVersion();
  }

  constructor(
    config: { autoUpdate: AutoUpdateConfig },
    registry: ChannelActivityRegistry,
    executor: BackgroundExecutorLike,
    options: AutoUpdaterOptions = {},
  ) {
    this.config = config.autoUpdate;
    this.registry = registry;
    this.executor = executor;
    this.installRoot = options.installRoot ?? AutoUpdater.resolveInstallRoot();
    this.globalNpmRootResolver = options.globalNpmRootResolver;
    this.commandRunner = options.commandRunner;
    this.sourceLauncherRefresher = options.sourceLauncherRefresher;
    this.isDaemonProcess = options.isDaemonProcess ?? (() => process.env["STRADA_DAEMON"] === "1");
    this.healthChecker = options.healthChecker;
    this.runtimeInspector = options.runtimeInspector;
    this.stateRoot = options.stateRoot;
  }

  static resolveInstallRoot(moduleUrl: string = import.meta.url): string {
    const moduleDir = path.dirname(fileURLToPath(moduleUrl));
    return path.resolve(moduleDir, "..", "..");
  }

  getChannel(): "stable" | "latest" {
    return this.config.channel;
  }

  getInstallRoot(): string {
    return this.installRoot;
  }

  setNotifyFn(fn: (msg: string) => void): void {
    this.notifyFn = fn;
  }

  detectInstallMethod(): InstallMethod {
    if (this.installMethod) return this.installMethod;
    if (fs.existsSync(path.join(this.installRoot, ".git"))) {
      this.installMethod = "git";
    } else {
      const globalRoot = this.resolveGlobalNpmRoot();
      if (globalRoot && AutoUpdater.isWithinPath(this.installRoot, globalRoot)) {
        this.installMethod = "npm-global";
      } else {
        this.installMethod = "npm-local";
      }
    }
    return this.installMethod;
  }

  private resolveGlobalNpmRoot(): string | null {
    if (this.globalNpmRootResolver) {
      return this.globalNpmRootResolver();
    }

    try {
      const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = spawnSync(npmCommand, ["root", "-g"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status === 0 && typeof result.stdout === "string") {
        const trimmed = result.stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    } catch {
      // Best-effort detection only.
    }

    return null;
  }

  /**
   * The package that OWNS an npm-local install (14F4 / D73).
   *
   * For an npm-local install the running code is at
   * `<owner>/node_modules/strada-brain`, which is what `resolveInstallRoot()`
   * returns — so `npm install strada-brain@…` run there installs the package
   * into itself and edits the wrong package.json. The owner is the directory
   * above the NEAREST `node_modules` ancestor, and it has to carry a
   * package.json for that claim to mean anything.
   *
   * Returns the install root itself for a plain project directory (no
   * node_modules in the path), and null when nothing above it looks like a
   * package — the caller must not guess a cwd in that case.
   */
  static resolveOwningPackageRoot(installRoot: string): string | null {
    const resolved = path.resolve(installRoot);
    const segments = resolved.split(path.sep);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i] !== "node_modules") continue;
      const owner = segments.slice(0, i).join(path.sep) || path.sep;
      return fs.existsSync(path.join(owner, "package.json")) ? owner : null;
    }
    return fs.existsSync(path.join(resolved, "package.json")) ? resolved : null;
  }

  /** The strada-brain version the owner currently has installed. */
  private getInstalledVersionFor(ownerRoot: string): string {
    const candidates = [
      path.join(ownerRoot, "node_modules", "strada-brain", "package.json"),
      path.join(this.installRoot, "package.json"),
    ];
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8")) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // Try the next candidate.
      }
    }
    return "0.0.0";
  }

  /** The published version for a dist-tag, falling back to `latest`. */
  private async fetchPublishedVersion(distTag: string): Promise<string | null> {
    let output = await this.runCommand(
      "npm",
      ["view", `strada-brain@${distTag}`, "version"],
      VERSION_CHECK_TIMEOUT,
    );
    let version = AutoUpdater.parseVersionFromOutput(output);
    if (!version && distTag !== "latest") {
      output = await this.runCommand(
        "npm",
        ["view", "strada-brain@latest", "version"],
        VERSION_CHECK_TIMEOUT,
      );
      version = AutoUpdater.parseVersionFromOutput(output);
    }
    return version;
  }

  private static isWithinPath(targetPath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, targetPath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  static parseVersionFromOutput(output: string): string | null {
    const trimmed = output.trim();
    if (/^\d+\.\d+\.\d+/.test(trimmed)) {
      return trimmed.split(/\s/)[0] ?? null;
    }
    return null;
  }

  static isNewerVersion(current: string, remote: string): boolean {
    const [cMajor, cMinor, cPatch] = current.split(".").map(Number);
    const [rMajor, rMinor, rPatch] = remote.split(".").map(Number);
    if (rMajor !== cMajor) return (rMajor ?? 0) > (cMajor ?? 0);
    if (rMinor !== cMinor) return (rMinor ?? 0) > (cMinor ?? 0);
    return (rPatch ?? 0) > (cPatch ?? 0);
  }

  static parsePsRuntimeProcesses(output: string): Array<{ pid: number; command: string }> {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) {
          return null;
        }
        const pid = Number.parseInt(match[1] ?? "", 10);
        const command = match[2]?.trim() ?? "";
        if (!Number.isFinite(pid) || command.length === 0) {
          return null;
        }
        return { pid, command };
      })
      .filter((entry): entry is { pid: number; command: string } => entry !== null)
      .filter((entry) => /(?:src[\\/]+index\.ts|dist[\\/]+index\.js)\s+(?:start|cli|supervise)(?:\s|$)/.test(entry.command));
  }

  static parseWindowsRuntimeProcesses(output: string): Array<{ pid: number; command: string }> {
    try {
      const data = JSON.parse(output) as
        | Array<{ pid: number | string; command: string }>
        | { pid: number | string; command: string }
        | null;

      if (!data) return [];

      const entries = Array.isArray(data) ? data : [data];

      return entries
        .map((entry) => {
          const pid = typeof entry.pid === "string" ? Number.parseInt(entry.pid, 10) : entry.pid;
          const command = entry.command?.trim() ?? "";
          if (!Number.isFinite(pid) || command.length === 0) {
            return null;
          }
          return { pid, command };
        })
        .filter((entry): entry is { pid: number; command: string } => entry !== null)
        .filter((entry) => /(?:src[\\/]+index\.ts|dist[\\/]+index\.js)\s+(?:start|cli|supervise)(?:\s|$)/.test(entry.command));
    } catch {
      return [];
    }
  }

  static parseLsofCwd(output: string): string | null {
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith("n")) {
        const cwd = line.slice(1).trim();
        if (cwd.length > 0) {
          return cwd;
        }
      }
    }
    return null;
  }

  getCurrentVersion(): string {
    try {
      const pkgPath = path.join(this.installRoot, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        version?: string;
      };
      return pkg.version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  private runCommand(
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ): Promise<string> {
    if (this.commandRunner) {
      return this.commandRunner(cmd, args, timeoutMs, cwd);
    }
    return spawnWithTimeout(cmd, args, timeoutMs, cwd);
  }

  /**
   * Prove the thing that was just installed actually runs (14F6 / D75).
   *
   * This used to be `node dist/index.js --version`, which proves the entrypoint
   * parses and nothing else: no channel started, no port bound, no database
   * opened, no bootstrap stage run — precisely the failures an update
   * introduces. `scripts/ci/boot-smoke.mjs` boots `dist/index.js start --channel
   * web` in a throwaway home, waits for /health to answer ok, SIGTERMs it and
   * requires a clean exit, so that is what runs when it is present. `--version`
   * survives only as the fallback for an install that does not carry it.
   */
  private async runPostUpdateHealthCheck(): Promise<void> {
    if (this.healthChecker) {
      await this.healthChecker();
      return;
    }
    const distIndex = path.join(this.installRoot, "dist", "index.js");
    if (!fs.existsSync(distIndex)) {
      return;
    }
    const bootSmoke = path.join(this.installRoot, "scripts", "ci", "boot-smoke.mjs");
    if (fs.existsSync(bootSmoke)) {
      await this.runCommand(process.execPath, [bootSmoke], BOOT_SMOKE_TIMEOUT, this.installRoot);
      return;
    }
    await this.runCommand(
      process.execPath,
      [distIndex, "--version"],
      30_000,
      this.installRoot,
    );
  }

  /** The budget for each install and build step of an update (AUTO_UPDATE_BUILD_TIMEOUT_MIN). */
  private stepTimeoutMs(): number {
    // `config` is absent on updaters the tests build without a constructor.
    const minutes = (this.config as AutoUpdateConfig | undefined)?.buildTimeoutMin;
    return (typeof minutes === "number" && minutes > 0 ? minutes : DEFAULT_BUILD_TIMEOUT_MIN) * 60_000;
  }

  /**
   * The packages (the root, and web-portal with its own lockfile) whose
   * node_modules lag their manifests (see dependenciesInstalled). Both
   * installs used to run on every update — about 5 minutes apiece on the
   * daemon host in September, two thirds of each failed update.
   */
  private packagesNeedingInstall(): string[] {
    const portal = path.join(this.installRoot, "web-portal");
    const packages = [this.installRoot, ...(fs.existsSync(path.join(portal, "package.json")) ? [portal] : [])];
    return packages.filter((dir) => !dependenciesInstalled(dir));
  }

  private async installProjectDependencies(packages: string[]): Promise<void> {
    for (const dir of packages) {
      await this.runCommand("npm", ["install"], this.stepTimeoutMs(), dir);
    }
  }

  private isStradaInstallRoot(candidateRoot: string): boolean {
    try {
      const pkgPath = path.join(candidateRoot, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return false;
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string };
      return pkg.name === "strada-brain";
    } catch {
      return false;
    }
  }

  private async resolveProcessCwd(pid: number): Promise<string | null> {
    if (process.platform === "win32") {
      try {
        const output = await this.runCommand(
          "powershell",
          [
            "-Command",
            `try { (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").WorkingDirectory } catch { '' }`,
          ],
          5_000,
        );
        const cwd = output.trim();
        return cwd.length > 0 ? cwd : null;
      } catch {
        // Best-effort only.
      }
      return null;
    }

    try {
      const output = await this.runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], 5_000);
      const cwd = AutoUpdater.parseLsofCwd(output);
      if (cwd) {
        return cwd;
      }
    } catch {
      // Fall through to pwdx when available.
    }

    if (process.platform === "linux") {
      try {
        const output = await this.runCommand("pwdx", [String(pid)], 5_000);
        const match = output.match(/^\s*\d+:\s+(.*)$/m);
        const cwd = match?.[1]?.trim();
        return cwd && cwd.length > 0 ? cwd : null;
      } catch {
        // Best-effort only.
      }
    }

    return null;
  }

  private async detectRunningLocalRuntimes(): Promise<RuntimeProcessInfo[]> {
    if (this.runtimeInspector) {
      return this.runtimeInspector();
    }

    try {
      let candidates: Array<{ pid: number; command: string }> = [];

      if (process.platform === "win32") {
        const output = await this.runCommand(
          "powershell",
          [
            "-Command",
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'node' } | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='command';Expression={$_.CommandLine}} | ConvertTo-Json -Depth 1",
          ],
          10_000,
        );
        candidates = AutoUpdater.parseWindowsRuntimeProcesses(output)
          .filter((entry) => entry.pid !== process.pid);
      } else {
        const output = await this.runCommand("ps", ["-Ao", "pid=,command="], 5_000);
        candidates = AutoUpdater.parsePsRuntimeProcesses(output)
          .filter((entry) => entry.pid !== process.pid);
      }

      const runtimes: RuntimeProcessInfo[] = [];

      for (const candidate of candidates) {
        const cwd = await this.resolveProcessCwd(candidate.pid);
        if (!cwd || !this.isStradaInstallRoot(cwd)) {
          continue;
        }
        runtimes.push({ ...candidate, cwd });
      }

      return runtimes;
    } catch {
      return [];
    }
  }

  async inspectLocalRuntimes(): Promise<LocalRuntimeInspection> {
    const installRoot = path.resolve(this.installRoot);
    const runtimes = await this.detectRunningLocalRuntimes();
    const matchingRuntime = runtimes.find((runtime) => (
      runtime.cwd !== null && path.resolve(runtime.cwd) === installRoot
    )) ?? null;

    return {
      installRoot,
      runtimes,
      matchingRuntime,
    };
  }

  private static isSameRuntimeRoot(runtime: RuntimeProcessInfo, installRoot: string): boolean {
    return runtime.cwd !== null && path.resolve(runtime.cwd) === installRoot;
  }

  async getPostUpdateNotice(): Promise<string | null> {
    const inspection = await this.inspectLocalRuntimes();
    if (inspection.runtimes.length === 0) {
      return null;
    }

    const foreignRuntime = inspection.runtimes.find((runtime) => (
      !AutoUpdater.isSameRuntimeRoot(runtime, inspection.installRoot)
    )) ?? null;

    if (inspection.matchingRuntime) {
      const primaryNotice = `A Strada runtime from this checkout is still running (PID ${inspection.matchingRuntime.pid}). Restart it to load the updated code.`;
      if (!foreignRuntime) {
        return primaryNotice;
      }
      const foreignRoot = foreignRuntime.cwd ?? "an unknown working directory";
      return `${primaryNotice} Another local runtime is active from ${foreignRoot} (PID ${foreignRuntime.pid}); that checkout was not updated by this command.`;
    }

    const activeRuntime = foreignRuntime ?? inspection.runtimes[0]!;
    const runtimeRoot = activeRuntime.cwd ?? "an unknown working directory";
    return `Detected a running Strada runtime from ${runtimeRoot} (PID ${activeRuntime.pid}). This command updated ${inspection.installRoot}, not that checkout. Restart or update the active runtime separately.`;
  }

  private async refreshSourceLauncherBindings(): Promise<void> {
    if (this.sourceLauncherRefresher) {
      await this.sourceLauncherRefresher();
      return;
    }

    if (!process.env["STRADA_LAUNCHER_PATH"]) {
      return;
    }

    const sourceLauncherPath = path.join(this.installRoot, "scripts", "source-launcher.mjs");
    if (!fs.existsSync(sourceLauncherPath)) {
      return;
    }

    await this.runCommand(
      process.execPath,
      [sourceLauncherPath, "refresh-command-bindings"],
      UPDATE_TIMEOUT,
      this.installRoot,
    );
  }

  /**
   * Detect the tracking remote and branch from the current git checkout.
   * Falls back to origin/main when detection fails.
   */
  private async resolveGitUpstream(): Promise<{ remote: string; branch: string }> {
    try {
      const ref = (
        await this.runCommand(
          "git",
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          VERSION_CHECK_TIMEOUT,
          this.installRoot,
        )
      ).trim();
      const slashIdx = ref.indexOf("/");
      if (slashIdx > 0) {
        return { remote: ref.slice(0, slashIdx), branch: ref.slice(slashIdx + 1) };
      }
    } catch {
      if (this.notifyFn) {
        this.notifyFn("Could not detect git upstream; falling back to origin/main.");
      }
    }
    return { remote: "origin", branch: "main" };
  }

  async checkForUpdate(): Promise<UpdateCheckResult> {
    const currentVersion = this.getCurrentVersion();
    const method = this.detectInstallMethod();

    try {
      if (method === "git") {
        const { remote, branch } = await this.resolveGitUpstream();
        const remoteRef = `${remote}/${branch}`;
        await this.runCommand(
          "git",
          ["fetch", remote, branch],
          VERSION_CHECK_TIMEOUT,
          this.installRoot,
        );
        // Ensure local ref is resolved (side-effect: validates git state)
        await this.runCommand("git", ["rev-parse", "HEAD"], VERSION_CHECK_TIMEOUT, this.installRoot);
        const remoteRev = (
          await this.runCommand(
            "git",
            ["rev-parse", remoteRef],
            VERSION_CHECK_TIMEOUT,
            this.installRoot,
          )
        ).trim();
        // Check if remote has commits we don't have (remote is ahead)
        const behindCount = (
          await this.runCommand(
            "git",
            ["rev-list", "--count", `HEAD..${remoteRef}`],
            VERSION_CHECK_TIMEOUT,
            this.installRoot,
          )
        ).trim();
        const behind = Number.parseInt(behindCount, 10);
        if (!Number.isFinite(behind)) {
          return {
            available: false,
            currentVersion,
            latestVersion: remoteRev.length > 0 ? remoteRev.substring(0, 8) : null,
            error: `Could not determine whether ${remoteRef} is ahead of this checkout.`,
          };
        }

        // Read remote package.json version for consistent semver display
        let remoteVersion: string | null = null;
        try {
          const remotePkgJson = (
            await this.runCommand(
              "git",
              ["show", `${remoteRef}:package.json`],
              VERSION_CHECK_TIMEOUT,
              this.installRoot,
            )
          ).trim();
          const remotePkg = JSON.parse(remotePkgJson) as { version?: string };
          remoteVersion = remotePkg.version ?? null;
        } catch {
          // Fall back to abbreviated SHA if remote package.json is unreadable
          remoteVersion = remoteRev.length > 0 ? remoteRev.substring(0, 8) : null;
        }

        return {
          available: behind > 0,
          currentVersion,
          latestVersion: remoteVersion,
          latestRevision: remoteRev.length > 0 ? remoteRev : null,
          error: null,
        };
      } else {
        const distTag = this.config.channel === "latest" ? "latest" : "stable";
        let output = await this.runCommand(
          "npm",
          ["view", `strada-brain@${distTag}`, "version"],
          VERSION_CHECK_TIMEOUT,
        );
        let remoteVersion = AutoUpdater.parseVersionFromOutput(output);
        // Fallback: if configured dist-tag doesn't exist, try "latest"
        if (!remoteVersion && distTag !== "latest") {
          output = await this.runCommand(
            "npm",
            ["view", "strada-brain@latest", "version"],
            VERSION_CHECK_TIMEOUT,
          );
          remoteVersion = AutoUpdater.parseVersionFromOutput(output);
        }
        if (!remoteVersion) {
          return {
            available: false,
            currentVersion,
            latestVersion: null,
            error: "Could not parse the latest published Strada version.",
          };
        }
        return {
          available: AutoUpdater.isNewerVersion(currentVersion, remoteVersion),
          currentVersion,
          latestVersion: remoteVersion,
          error: null,
        };
      }
    } catch (err) {
      return {
        available: false,
        currentVersion,
        latestVersion: null,
        error: (err as Error).message,
      };
    }
  }

  async performUpdate(): Promise<boolean> {
    if (!this.acquireLock()) return false;

    this.updateInFlight = true;
    try {
      const method = this.detectInstallMethod();
      const updated = method === "git"
        ? await this.performGitUpdate()
        : await this.performNpmUpdate(method);
      if (updated) clearUpdateHold(this.getUpdateRecordsRoot());
      return updated;
    } finally {
      this.updateInFlight = false;
      this.releaseLock();
    }
  }

  private resolveStateRoot(): string {
    this.stateRoot ??= resolveRuntimePaths({ installRoot: this.installRoot }).configRoot;
    return this.stateRoot;
  }

  /**
   * Where the update history and hold live: a checkout's own .strada, and for
   * a package install the writable config root. `npm install` replaces a
   * package install's directory, and a root-owned global prefix refused the
   * hold while the log reported it written (review of 7fc26d9f). Under the
   * config root they are keyed by install root, as the update lock is
   * (COR-21): every package install of a user shared one hold, so a failure
   * in one project held back and backed off the others, and `strada status`
   * in one showed another's last update (review of 1dbe763e).
   */
  getUpdateRecordsRoot(): string {
    if (this.detectInstallMethod() === "git") return this.installRoot;
    return path.join(installStateDir(this.resolveStateRoot()), installRootKey(this.installRoot));
  }

  /**
   * Remember a failed update (see UpdateHold): the scheduled check will not
   * attempt `target` again, and waits out a backoff that doubles with each
   * consecutive failure before attempting anything newer. Until 2026-09-20 a
   * failure only said "Will retry next check", and every check did.
   */
  private holdBack(target: string, step: string, err: unknown, rollback: RollbackOutcome): void {
    const now = Date.now();
    const root = this.getUpdateRecordsRoot();
    const failures = (readUpdateHold(root)?.failures ?? 0) + 1;
    const intervalMs = ((this.config as AutoUpdateConfig | undefined)?.intervalHours || 6) * 60 * 60 * 1000;
    const hold: UpdateHold = {
      target,
      step,
      cause: describeFailure(err, 600),
      at: now,
      failures,
      retryAfter: now + intervalMs * 2 ** Math.min(failures - 1, MAX_BACKOFF_DOUBLINGS),
      rollback,
    };
    if (!writeUpdateHold(root, hold)) {
      getLoggerSafe().error("Auto-update hold could not be written — the next check will try this update again", {
        target,
        step,
        path: path.join(root, ".strada"),
      });
      return;
    }
    getLoggerSafe().warn("Auto-update held back", {
      target,
      step,
      failures,
      rollback,
      retryAfter: new Date(hold.retryAfter).toISOString(),
    });
  }

  /** The hold that keeps the scheduled updater away from `target` now, if any. */
  private activeHold(target: string | null): UpdateHold | null {
    const hold = readUpdateHold(this.getUpdateRecordsRoot());
    if (!hold) return null;
    return (target !== null && target === hold.target) || Date.now() < hold.retryAfter ? hold : null;
  }

  /** Drop the pending update a hold forbids, and say so once per hold. */
  private standDown(hold: UpdateHold): void {
    if (this.idleCheckHandle) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
    this.clearPendingVersion();
    if (this.announcedHoldAt === hold.at) return;
    this.announcedHoldAt = hold.at;
    getLoggerSafe().warn("Auto-update skipped — the last update failed and is held back", {
      target: hold.target,
      step: hold.step,
      failures: hold.failures,
      retryAfter: new Date(hold.retryAfter).toISOString(),
    });
    if (this.config.notify && this.notifyFn) this.notifyFn(describeUpdateHold(hold, Date.now()));
  }

  /**
   * A check found nothing to update: forget a pending update (applied by hand,
   * or saved before a restart onto it), and a hold the install has caught up
   * with some other way. A stale hold kept `strada status` reporting it and
   * made the next newer commit wait out its backoff (review of 7fc26d9f).
   */
  private settleUpToDate(check: UpdateCheckResult): void {
    if (this.idleCheckHandle) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
    if (this.pendingVersion) {
      getLoggerSafe().info("Auto-update dropped a pending update — this install is already up to date", {
        pending: this.pendingVersion,
        current: this.getCurrentVersion(),
      });
      this.clearPendingVersion();
    }
    const root = this.getUpdateRecordsRoot();
    const hold = readUpdateHold(root);
    // A rollback that was refused, broke off or had nothing to go back to
    // left the failed target installed, so finding nothing newer than it is
    // the failure itself, not a catch-up. Clearing it there dropped "NOT
    // rolled back" from `strada status` on the very next check (review of
    // 1dbe763e). It goes once the install has moved past the target, or with
    // a successful update.
    const failedTargetInPlace = hold?.rollback !== undefined && hold.rollback !== "rolled-back"
      && (check.latestRevision ?? check.latestVersion) === hold.target;
    if (hold && !failedTargetInPlace) {
      clearUpdateHold(root);
      this.announcedHoldAt = null;
      getLoggerSafe().info("Auto-update hold cleared — this install already has what it held back", {
        target: hold.target,
        failures: hold.failures,
      });
    }
  }

  /**
   * The remote commit the pull merged, which is what a failure holds back:
   * checks compare holds with the remote tip, and a pull over unpushed local
   * commits lands a merge commit that never equals it (review of 7fc26d9f).
   */
  private async pulledRevision(remote: string, branch: string, fallback: string): Promise<string> {
    try {
      const sha = (await this.runCommand("git", ["rev-parse", `${remote}/${branch}`], VERSION_CHECK_TIMEOUT, this.installRoot)).trim();
      return sha || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Tracked files with uncommitted changes, except the lockfiles of the
   * packages in `reinstalled`: their `npm install` may rewrite them.
   */
  private async uncommittedEdits(reinstalled: string[]): Promise<string[]> {
    const output = await this.runCommand(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      VERSION_CHECK_TIMEOUT,
      this.installRoot,
    );
    const ownWrites = new Set(reinstalled.map((dir) => (
      path.relative(this.installRoot, path.join(dir, "package-lock.json")).split(path.sep).join("/")
    )));
    return output
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim() !== "")
      // "XY path", or "XY old -> new" for a rename.
      .map((line) => line.slice(3).split(" -> ").pop()!.replace(/^"(.*)"$/, "$1"))
      .filter((file) => !ownWrites.has(file));
  }

  /**
   * Undo a merge a failed pull left half-done. `merge --abort` keeps edits
   * the merge did not touch, and refuses rather than overwrite one it did.
   */
  private async abortUnfinishedMerge(): Promise<void> {
    try {
      const merging = await this.runCommand(
        "git",
        ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
        VERSION_CHECK_TIMEOUT,
        this.installRoot,
      );
      if (merging.trim() === "") return;
    } catch {
      return; // exits 1 when no merge is in progress
    }
    try {
      await this.runCommand("git", ["merge", "--abort"], VERSION_CHECK_TIMEOUT, this.installRoot);
    } catch (abortErr) {
      getLoggerSafe().warn("Auto-update could not undo the merge its failed pull left", {
        detail: describeFailure(abortErr, 400),
        recovery: "git merge --abort, or resolve the conflicts and commit",
      });
    }
  }

  /** Told once per dirty stretch; cleared when the tree is clean again. */
  private deferredForLocalChanges = false;

  private async performGitUpdate(): Promise<boolean> {
    const { remote, branch } = await this.resolveGitUpstream();

    // Stash uncommitted changes before pulling, restore after
    const statusOutput = (
      await this.runCommand(
        "git",
        ["status", "--porcelain"],
        VERSION_CHECK_TIMEOUT,
        this.installRoot,
      )
    ).trim();
    // The updater's own lock file is untracked in this checkout; counting it
    // stashed the tree on every cycle and put the lock itself into the stash.
    const hadLocalChanges = statusOutput
      .split("\n")
      .some((line) => line.trim() !== "" && !line.endsWith(".strada-update.lock"));
    if (hadLocalChanges) {
      // UNATTENDED SAFETY (2026-09-10). Stashing a live checkout, pulling and
      // popping was the default; it rolled the operator's tree back three
      // times in three days and once left the changes in a stash nobody
      // popped. A dirty tree now DEFERS the update — the next cycle tries
      // again once the tree is clean — unless the operator opts back into
      // stashing with STRADA_AUTO_UPDATE_STASH=1.
      if (process.env["STRADA_AUTO_UPDATE_STASH"] !== "1") {
        if (!this.deferredForLocalChanges) {
          this.deferredForLocalChanges = true;
          getLoggerSafe().warn("Auto-update deferred — the checkout has local changes; commit or stash them, or set STRADA_AUTO_UPDATE_STASH=1", {
            installRoot: this.installRoot,
            changed: statusOutput.split("\n").filter((l) => l.trim() !== "").length,
          });
          this.notifyFn?.("Auto-update deferred: this checkout has uncommitted changes. Commit or stash them and the next cycle will update; set STRADA_AUTO_UPDATE_STASH=1 to let the updater stash them itself.");
          recordUpdateEvent(this.installRoot, { at: Date.now(), kind: "deferred", reason: "local changes in the checkout" });
        }
        return false;
      }
      // git refuses a pathspec, :(exclude) ones included, that names an
      // ignored path which exists ("The following paths are ignored…",
      // exit 1), and it refused AFTER saving the stash: this checkout's
      // .gitignore lists the lock, and the update holds it throughout. `-u`
      // never stashes an ignored file, so only an unignored lock needs the
      // exclude. An answer that does not name the lock (exit 1 is "not
      // ignored") keeps it.
      const lockIgnored = (
        await this.runCommand(
          "git",
          ["check-ignore", "--no-index", "--", ".strada-update.lock"],
          VERSION_CHECK_TIMEOUT,
          this.installRoot,
        ).catch(() => "")
      )
        .split("\n")
        .some((line) => line.trim() === ".strada-update.lock");
      await this.runCommand(
        "git",
        [
          "stash", "push", "-u", "-m", "auto-updater: stash before pull", "--", ".",
          ...(lockIgnored ? [] : [":(exclude).strada-update.lock"]),
        ],
        VERSION_CHECK_TIMEOUT,
        this.installRoot,
      );
    }
    this.deferredForLocalChanges = false;

    const prePullSha = (
      await this.runCommand(
        "git",
        ["rev-parse", "HEAD"],
        VERSION_CHECK_TIMEOUT,
        this.installRoot,
      )
    ).trim();
    // prePullSha until the pull lands; a failed pull has nothing to roll back.
    let postPullSha = prePullSha;
    let step = "git pull";
    const popStash = async (): Promise<void> => {
      if (!hadLocalChanges) return;
      try {
        await this.runCommand("git", ["stash", "pop"], VERSION_CHECK_TIMEOUT, this.installRoot);
      } catch (popErr) {
        // Measured 2026-09-07 01:40: a stash holding three untracked notes
        // from 2026-08-25 sat unrestored, and nothing in the log said so —
        // the only notice went to a chat channel.
        getLoggerSafe().warn("Auto-update could not restore the stashed working tree", {
          detail: describeFailure(popErr, 400),
          recovery: "git stash list / git stash pop",
        });
        // Check if working tree has conflict markers
        try {
          const statusOutput = await this.runCommand(
            "git",
            ["status", "--porcelain"],
            VERSION_CHECK_TIMEOUT,
            this.installRoot,
          );
          const hasConflicts = statusOutput.split("\n").some((line) => line.startsWith("UU "));
          if (hasConflicts && this.notifyFn) {
            this.notifyFn(
              "Update completed but your local changes conflict with the updated code. " +
              "Conflict markers are present in the working tree. " +
              "Run `git stash pop` manually to resolve conflicts.",
            );
            return;
          }
        } catch {}
        if (this.notifyFn) {
          this.notifyFn("Update completed but your local changes could not be restored automatically. Run `git stash pop` to recover them.");
        }
      }
    };

    // The packages whose dependencies the update reinstalled; a rollback
    // reinstalls the same ones to put the old dependencies back.
    let reinstalled: string[] = [];

    /**
     * Roll the checkout back to where the pull found it — but ONLY if nothing
     * else has committed since, and nobody has edited it since.
     *
     * Measured live 2026-09-04. The updater pulled at 12:21:27 (1b527dbf →
     * 235e5f9f), a commit landed on the branch at 12:23:50, and the failed
     * post-update health check ran `git reset --hard 1b527dbf` at 12:30:39 —
     * destroying both the pulled version bump and that commit. It survived
     * only in the reflog, and nothing in the run log said an update had been
     * attempted at all. A nine-minute window in which any commit to this
     * checkout is silently discarded.
     *
     * Uncommitted edits are the same case without even the reflog (audit
     * 2026-10-11): the update starts on a clean tree, but agents and the
     * operator keep working in this checkout while it pulls, installs, builds
     * and boots, and a half-done edit is exactly what fails the build.
     *
     * So the rollback verifies HEAD is still the SHA the pull left and that
     * no tracked file has changed except the lockfiles its own installs
     * rewrite, and otherwise REFUSES and says so. A stale checkout the
     * operator can fix is recoverable; discarded work is not.
     */
    const rollbackTo = async (postPullSha: string, why: string): Promise<"rolled-back" | "refused"> => {
      const headNow = (
        await this.runCommand("git", ["rev-parse", "HEAD"], VERSION_CHECK_TIMEOUT, this.installRoot)
      ).trim();
      if (headNow !== postPullSha) {
        const message =
          `Update rollback REFUSED (${why}): the branch moved to ${headNow.slice(0, 8)} after the pull ` +
          `left it at ${postPullSha.slice(0, 8)}, so resetting to ${prePullSha.slice(0, 8)} would discard ` +
          "commits this updater did not make. The checkout is left as it is — resolve it by hand.";
        getLoggerSafe().error("Auto-update rollback refused — the branch moved after the pull", {
          prePullSha,
          postPullSha,
          headNow,
          reason: why,
        });
        if (this.notifyFn) this.notifyFn(message);
        recordUpdateEvent(this.installRoot, { at: Date.now(), kind: "rollback-refused", from: prePullSha, to: headNow, reason: why });
        return "refused";
      }
      const edited = await this.uncommittedEdits(reinstalled);
      if (edited.length > 0) {
        const shown = edited.slice(0, 5).join(", ") + (edited.length > 5 ? ` and ${edited.length - 5} more` : "");
        const message =
          `Update rollback REFUSED (${why}): ${shown} changed in the checkout during the update, and resetting to ` +
          `${prePullSha.slice(0, 8)} would discard that uncommitted work. The checkout is left at ` +
          `${postPullSha.slice(0, 8)} with the changes — commit or stash them, then reset or rebuild by hand.`;
        getLoggerSafe().error("Auto-update rollback refused — the checkout has uncommitted changes", {
          prePullSha,
          postPullSha,
          edited: edited.slice(0, 20),
          reason: why,
        });
        if (this.notifyFn) this.notifyFn(message);
        recordUpdateEvent(this.installRoot, {
          at: Date.now(), kind: "rollback-refused", from: prePullSha, to: postPullSha, reason: `${why}; uncommitted changes to ${shown}`,
        });
        return "refused";
      }
      getLoggerSafe().warn("Auto-update rolling back", { to: prePullSha, reason: why });
      await this.runCommand("git", ["reset", "--hard", prePullSha], VERSION_CHECK_TIMEOUT, this.installRoot);
      recordUpdateEvent(this.installRoot, { at: Date.now(), kind: "rolled-back", from: postPullSha, to: prePullSha, reason: why });
      return "rolled-back";
    };

    /**
     * Roll back after a failed step and put the old dependencies and build
     * back. `strada status` reads the last history event: a rollback whose
     * reinstall or rebuild failed still said "rolled-back" while dist/ held
     * the rejected version, and a reset that threw left the update before it
     * as the last word (audit core-bootstrap#5).
     */
    const rollBack = async (why: string, rebuild: boolean): Promise<RollbackOutcome> => {
      try {
        const outcome = await rollbackTo(postPullSha, why);
        if (outcome === "refused") return outcome;
        await this.installProjectDependencies(reinstalled);
        if (rebuild) await this.runCommand("npm", ["run", "build"], this.stepTimeoutMs(), this.installRoot);
        return outcome;
      } catch (rollbackErr) {
        // Rollback failed — nothing more we can do; say so for the operator.
        getLoggerSafe().warn("Auto-update rollback did not complete", {
          detail: describeFailure(rollbackErr),
        });
        recordUpdateEvent(this.installRoot, {
          at: Date.now(),
          kind: "failed",
          from: postPullSha,
          to: prePullSha,
          reason: `${why}; the rollback did not complete: ${describeFailure(rollbackErr, 300)}`,
        });
        return "incomplete";
      }
    };

    try {
      await this.runCommand(
        "git",
        ["pull", "--no-rebase", remote, branch],
        UPDATE_TIMEOUT,
        this.installRoot,
      );
      postPullSha = (
        await this.runCommand("git", ["rev-parse", "HEAD"], VERSION_CHECK_TIMEOUT, this.installRoot)
      ).trim();
      getLoggerSafe().info("Auto-update pulled", { remote, branch, from: prePullSha, to: postPullSha });
      step = "npm install";
      reinstalled = this.packagesNeedingInstall();
      await this.installProjectDependencies(reinstalled);
      step = "npm run build";
      await this.runCommand("npm", ["run", "build"], this.stepTimeoutMs(), this.installRoot);
    } catch (buildErr) {
      // Three rollbacks in three days said "the build failed" and nothing
      // else (2026-09-04 18:51, 2026-09-06 12:45 and 18:41, 2026-09-07 01:40)
      // while a manual `npm run build` passed each time. The step and the
      // command's own words are the only way to tell a compile error from a
      // timed-out `npm install`.
      getLoggerSafe().warn("Auto-update step failed", {
        step,
        detail: describeFailure(buildErr),
      });
      if (step === "git pull") {
        // Nothing landed, so there is nothing to roll back. The `reset --hard`
        // that ran here anyway discarded tracked edits, among them the very
        // ones a pull refuses to overwrite (audit 2026-10-11).
        await this.abortUnfinishedMerge();
        recordUpdateEvent(this.installRoot, {
          at: Date.now(), kind: "failed", from: prePullSha, reason: `git pull failed: ${describeFailure(buildErr, 300)}`,
        });
        await popStash();
        throw buildErr;
      }
      // A failed build still writes dist/: tsc emits despite type errors, and
      // a failed portal build leaves the new server code behind. Until the
      // rolled-back source is built again, the next start (and every lazy
      // import) runs the version that was just rejected (COR-4).
      const rollback = await rollBack(`${step} failed`, step === "npm run build");
      await popStash();
      // A pull that moved nothing brought no commit to hold back.
      if (postPullSha !== prePullSha) {
        this.holdBack(await this.pulledRevision(remote, branch, postPullSha), step, buildErr, rollback);
      }
      throw buildErr;
    }

    try {
      await this.refreshSourceLauncherBindings();
    } catch (refreshErr) {
      if (this.notifyFn) {
        this.notifyFn(
          `Update succeeded, but launcher bindings were not refreshed. Run \`./strada install-command\`. Reason: ${(refreshErr as Error).message}`,
        );
      }
    }

    try {
      await this.runPostUpdateHealthCheck();
    } catch (healthErr) {
      // 2026-09-18 15:51 logged only "rolling back … the post-update health
      // check failed"; what the check saw reached a chat notice, if anything.
      getLoggerSafe().warn("Auto-update step failed", {
        step: "the post-update health check",
        detail: describeFailure(healthErr),
      });
      if (this.notifyFn) {
        this.notifyFn(
          `Update build succeeded but health check failed: ${describeFailure(healthErr, 600)}. Rolling back...`,
        );
      }
      const rollback = await rollBack("the post-update health check failed", true);
      await popStash();
      if (postPullSha !== prePullSha) {
        this.holdBack(await this.pulledRevision(remote, branch, postPullSha), "the post-update health check", healthErr, rollback);
      }
      throw healthErr;
    }

    await popStash();
    recordUpdateEvent(this.installRoot, { at: Date.now(), kind: "pulled", from: prePullSha, to: postPullSha });
    return true;
  }

  private async performNpmUpdate(method: "npm-global" | "npm-local"): Promise<boolean> {
    const tag = this.config.channel;
    const buildArgs = (t: string) => method === "npm-global"
      ? ["install", "-g", `strada-brain@${t}`]
      : ["install", `strada-brain@${t}`];

    let rollbackCommand: (() => Promise<void>) | null = null;
    // For npm-local, every npm command and every backup belongs to the OWNING
    // package, not to the installed copy the process is running from (14F4/D73).
    let ownerRoot: string | undefined;
    // The version a failed health check holds back, as the check reported it.
    let target = this.pendingVersion ?? `strada-brain@${tag}`;
    let fromVersion = this.getCurrentVersion();

    if (method === "npm-local") {
      const resolvedOwner = AutoUpdater.resolveOwningPackageRoot(this.installRoot);
      if (!resolvedOwner) {
        if (this.notifyFn) {
          this.notifyFn(
            `Cannot update: no package.json owns ${this.installRoot}, so there is no project to install into.`,
          );
        }
        return false;
      }
      ownerRoot = resolvedOwner;

      // Compare versions BEFORE touching anything. An npm-local install used to
      // reinstall on every cycle because nothing ever asked whether the owner
      // already had the published version.
      const installedVersion = this.getInstalledVersionFor(ownerRoot);
      const publishedVersion = await this.fetchPublishedVersion(
        tag === "latest" ? "latest" : "stable",
      );
      if (publishedVersion && !AutoUpdater.isNewerVersion(installedVersion, publishedVersion)) {
        if (this.notifyFn) {
          this.notifyFn(
            `Strada ${installedVersion} in ${ownerRoot} is already at or ahead of the published ${publishedVersion} — nothing to install.`,
          );
        }
        return false;
      }
      if (publishedVersion) target = publishedVersion;
      fromVersion = installedVersion;

      const pkgBackup = path.join(ownerRoot, ".strada-update-backup-package.json");
      const lockBackup = path.join(ownerRoot, ".strada-update-backup-package-lock.json");
      const nmBackup = path.join(ownerRoot, ".strada-update-backup-node_modules");
      const pkgPath = path.join(ownerRoot, "package.json");
      const lockPath = path.join(ownerRoot, "package-lock.json");
      const nmPath = path.join(ownerRoot, "node_modules", "strada-brain");

      if (fs.existsSync(pkgPath)) {
        fs.copyFileSync(pkgPath, pkgBackup);
      }
      if (fs.existsSync(lockPath)) {
        fs.copyFileSync(lockPath, lockBackup);
      }
      if (fs.existsSync(nmPath)) {
        // COPIED, not renamed: nmPath is the directory this process is running
        // from, and moving it away mid-update breaks every dynamic import the
        // bootstrap still has ahead of it.
        fs.rmSync(nmBackup, { recursive: true, force: true });
        fs.cpSync(nmPath, nmBackup, { recursive: true });
      }

      const rollbackRoot = ownerRoot;
      rollbackCommand = async (): Promise<void> => {
        try {
          if (fs.existsSync(pkgBackup)) {
            fs.renameSync(pkgBackup, pkgPath);
          }
          if (fs.existsSync(lockBackup)) {
            fs.renameSync(lockBackup, lockPath);
          }
          if (fs.existsSync(nmBackup)) {
            if (fs.existsSync(nmPath)) {
              fs.rmSync(nmPath, { recursive: true });
            }
            fs.renameSync(nmBackup, nmPath);
          }
          await this.runCommand("npm", ["install"], this.stepTimeoutMs(), rollbackRoot);
        } catch (rollbackErr) {
          if (this.notifyFn) {
            this.notifyFn(`Rollback failed: ${(rollbackErr as Error).message}`);
          }
          throw rollbackErr;
        } finally {
          this.cleanupNpmBackups(rollbackRoot);
        }
      };
    } else {
      let currentGlobalVersion: string | null = null;
      try {
        const listOutput = await this.runCommand(
          "npm",
          ["list", "-g", "strada-brain", "--json"],
          VERSION_CHECK_TIMEOUT,
        );
        const listData = JSON.parse(listOutput) as { dependencies?: Record<string, { version?: string }> };
        currentGlobalVersion = listData.dependencies?.["strada-brain"]?.version ?? null;
      } catch {
        // Best effort only
      }

      if (currentGlobalVersion) {
        fromVersion = currentGlobalVersion;
        rollbackCommand = async (): Promise<void> => {
          try {
            await this.runCommand(
              "npm",
              ["install", "-g", `strada-brain@${currentGlobalVersion}`],
              this.stepTimeoutMs(),
            );
          } catch (rollbackErr) {
            if (this.notifyFn) {
              this.notifyFn(`Global rollback failed: ${(rollbackErr as Error).message}`);
            }
            throw rollbackErr;
          }
        };
      }
    }

    // npm-local installs into the owning project; npm-global takes no cwd.
    const cwd = ownerRoot;

    // `strada status` reads this history; an npm update wrote none, through
    // updates and rollbacks alike (audit core-bootstrap#5).
    const record = (kind: UpdateEventKind, from: string, to: string, reason?: string): void => {
      recordUpdateEvent(this.getUpdateRecordsRoot(), { at: Date.now(), kind, from, to, ...(reason ? { reason } : {}) });
    };
    /** Undo a failed install, on record either way; throws what the rollback threw. */
    const rollBack = async (why: string): Promise<RollbackOutcome> => {
      if (!rollbackCommand) {
        record("failed", fromVersion, target, `${why}; no earlier version recorded to roll back to`);
        return "none";
      }
      try {
        await rollbackCommand();
      } catch (rollbackErr) {
        record("failed", target, fromVersion, `${why}; the rollback did not complete: ${describeFailure(rollbackErr, 300)}`);
        throw rollbackErr;
      }
      record("rolled-back", target, fromVersion, why);
      return "rolled-back";
    };

    try {
      await this.runCommand("npm", buildArgs(tag), this.stepTimeoutMs(), cwd);
    } catch (installErr) {
      if (tag !== "latest") {
        try {
          await this.runCommand("npm", buildArgs("latest"), this.stepTimeoutMs(), cwd);
        } catch {
          await rollBack("npm install failed");
          throw installErr;
        }
      } else {
        await rollBack("npm install failed");
        throw new Error("npm install failed for strada-brain@latest");
      }
    }

    try {
      await this.runPostUpdateHealthCheck();
    } catch (healthErr) {
      getLoggerSafe().warn("Auto-update step failed", {
        step: "the post-update health check",
        detail: describeFailure(healthErr),
      });
      if (this.notifyFn) {
        this.notifyFn(
          `Update installed but health check failed: ${describeFailure(healthErr, 600)}. Rolling back...`,
        );
      }
      let rollback: RollbackOutcome;
      try {
        rollback = await rollBack("the post-update health check failed");
      } catch (rollbackErr) {
        rollback = "incomplete";
        if (this.notifyFn) {
          this.notifyFn(`Rollback failed: ${(rollbackErr as Error).message}`);
        }
      }
      // The package installed, so this is the version failing, not the registry.
      this.holdBack(target, "the post-update health check", healthErr, rollback);
      throw healthErr;
    }

    // Cleanup backup files after a successful update — from the OWNER's
    // directory, which is where they were written (round 10 #21). Passing
    // nothing cleaned `this.installRoot` (the installed package) instead, so an
    // npm-local update left `<owner>/.strada-update-backup-*` behind forever,
    // including a full copy of the package tree. `ownerRoot` is undefined for
    // npm-global, where the default installRoot is the right root.
    this.cleanupNpmBackups(ownerRoot);

    record("pulled", fromVersion, this.getCurrentVersion());
    return true;
  }

  /** Remove update backups from `root` (the OWNING package for npm-local). */
  private cleanupNpmBackups(root: string = this.installRoot): void {
    const backupFiles = [
      path.join(root, ".strada-update-backup-package.json"),
      path.join(root, ".strada-update-backup-package-lock.json"),
      path.join(root, ".strada-update-backup-node_modules"),
    ];
    for (const backup of backupFiles) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors — stale backups are harmless
      }
    }
  }

  private isLockStale(content: LockContent): boolean {
    // Check if PID is still alive
    try {
      process.kill(content.pid, 0);
    } catch (err) {
      // PID is dead — lock is stale (EPERM: alive, owned by another user)
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return true;
    }

    // PID exists — compare ITS start time with the one the holder recorded to
    // detect PID reuse. A match is a live update, however long it has run.
    // On Linux the start counted from boot decides: the epoch reading moves
    // with every wall-clock step, and a live update's lock would be broken.
    if (typeof content.bootStart === "string") {
      const holderBootStart = readProcessBootStart(content.pid);
      if (holderBootStart !== null) return holderBootStart !== content.bootStart;
    }
    const holderStartTime = typeof content.startTime === "number" ? readProcessStartTime(content.pid) : null;
    if (holderStartTime !== null) {
      return Math.abs(holderStartTime - content.startTime!) > START_TIME_MARGIN_MS;
    }

    // The holder cannot be identified: a live PID holds the lock until it is
    // old enough that no update can still be running under it.
    return Date.now() - content.timestamp > Math.max(STALE_LOCK_MAX_AGE, this.maxUpdateDurationMs());
  }

  /**
   * The longest a failing git update can hold the lock: the pull, two
   * installs and a build, the launcher refresh and the boot smoke, then the
   * rollback's two installs and rebuild, plus its git bookkeeping. A fixed
   * 30 minutes fell below this once each install and build step got
   * AUTO_UPDATE_BUILD_TIMEOUT_MIN (15 by default; review of 1dbe763e).
   */
  private maxUpdateDurationMs(): number {
    return 6 * this.stepTimeoutMs() + 2 * UPDATE_TIMEOUT + BOOT_SMOKE_TIMEOUT + 10 * VERSION_CHECK_TIMEOUT;
  }

  /**
   * The update lock lives under the writable config root, keyed by the install
   * root (COR-21): a root-owned or read-only install root made the lock
   * uncreatable, and the failure was reported as "another update is running".
   */
  private getLockPath(): string {
    return installLockPath(this.resolveStateRoot(), this.installRoot, "update");
  }

  /** Where updaters before COR-21 keep the lock; they look nowhere else. */
  private getLegacyLockPath(): string {
    return path.join(this.installRoot, ".strada-update.lock");
  }

  /** Exactly what this updater wrote, so release only ever removes OUR lock. */
  private heldLockBody: string | null = null;
  private heldLegacyLockBody: string | null = null;
  /** The last acquireLock() found another live update holding the lock. */
  private lockedOut = false;

  /** Whether the last update attempt stopped because another live update holds the lock. */
  wasLockedOut(): boolean {
    return this.lockedOut;
  }

  private lockOut(): false {
    this.lockedOut = true;
    return false;
  }

  /** A lock file a live updater still holds. Read-only: judging it writes nothing. */
  private isLiveLock(lockPath: string): boolean {
    try {
      return !this.isLockStale(JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockContent);
    } catch {
      return false; // absent, unreadable or corrupt: nobody holds it through this file
    }
  }

  /**
   * Claim `lockPath` for `body` (atomic "wx" write), taking over a stale or
   * corrupt lock once. "held" means a live updater owns it; any other failure
   * (EACCES, EROFS, ...) throws instead of passing for contention.
   */
  private claimLockAt(lockPath: string, body: string): "claimed" | "held" {
    const create = (): boolean => {
      try {
        fs.writeFileSync(lockPath, body, { encoding: "utf-8", flag: "wx" });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    };
    if (create()) return "claimed";
    if (this.isLiveLock(lockPath)) return "held";
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return create() ? "claimed" : "held";
  }

  acquireLock(): boolean {
    this.lockedOut = false;
    const bootStart = getProcessBootStart();
    const body = JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      startTime: getProcessStartTime(),
      ...(bootStart === null ? {} : { bootStart }),
      token: randomBytes(8).toString("hex"),
    } satisfies LockContent);

    // An updater from before COR-21 holds only the legacy lock.
    const legacyPath = this.getLegacyLockPath();
    if (this.isLiveLock(legacyPath)) return this.lockOut();

    const lockPath = this.getLockPath();
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      if (this.claimLockAt(lockPath, body) === "held") return this.lockOut();
    } catch (err) {
      throw new Error(`Cannot take the update lock at ${lockPath}: ${(err as Error).message}`, { cause: err });
    }
    this.heldLockBody = body;

    // Mirror the claim where older updaters look, when the install root is
    // writable; a read-only one skips the mirror and never blocks the update.
    try {
      if (this.claimLockAt(legacyPath, body) === "held") {
        this.releaseLock();
        return this.lockOut();
      }
      this.heldLegacyLockBody = body;
    } catch (err) {
      if (!UNWRITABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "")) {
        this.releaseLock();
        throw new Error(`Cannot take the update lock at ${legacyPath}: ${(err as Error).message}`, { cause: err });
      }
    }
    return true;
  }

  releaseLock(): void {
    const held: Array<[string, string | null]> = [
      [this.getLockPath(), this.heldLockBody],
      [this.getLegacyLockPath(), this.heldLegacyLockBody],
    ];
    this.heldLockBody = null;
    this.heldLegacyLockBody = null;
    for (const [lockPath, body] of held) {
      if (!body) continue;
      try {
        // A lock that is no longer ours (broken as stale and re-taken by
        // another updater) is theirs to release, not ours.
        if (fs.readFileSync(lockPath, "utf-8") === body) fs.unlinkSync(lockPath);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;
    this.detectInstallMethod();
    this.loadPendingVersion();
    // A version saved before the restart may have been applied by hand since:
    // "Resuming pending update to 4.2.930" on 4.2.939 ran a no-op pull, both
    // installs, a build and a restart (audit core-bootstrap#4). The check
    // decides; only when it cannot is the saved update resumed unjudged.
    this.runUpdateCheck(true).catch(() => {});
  }

  scheduleChecks(): void {
    if (!this.config.enabled) return;
    const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
    this.intervalHandle = setInterval(() => {
      this.runUpdateCheck().catch(() => {});
    }, intervalMs);
    if (this.intervalHandle.unref) this.intervalHandle.unref();
  }

  async requestImmediateCheck(): Promise<UpdateCheckResult> {
    const result = await this.checkForUpdate();
    if (!result.error && !result.available) this.settleUpToDate(result);
    if (!result.error && result.available && result.latestVersion) {
      // A push is no reason to skip the hold: in September a push landed
      // between every pair of failed attempts.
      const target = result.latestRevision ?? result.latestVersion;
      const hold = this.activeHold(target);
      if (hold) {
        this.standDown(hold);
        return { ...result, heldBack: describeUpdateHold(hold, Date.now()) };
      }
      this.pendingTarget = target;
      this.pendingVersion = result.latestVersion;
      this.savePendingVersion();
      if (this.config.notify && this.notifyFn) {
        this.notifyFn(
          `Update available: Strada Brain ${result.latestVersion} (triggered by webhook). ${this.whenItUpdates()}`,
        );
      }
      this.startIdleMonitoring();
    }
    return result;
  }

  private whenItUpdates(): string {
    return this.restartPending
      ? "Will update after the pending restart onto the last update."
      : "Will update when idle.";
  }

  private async runUpdateCheck(resuming = false): Promise<void> {
    const result = await this.checkForUpdate();
    if (result.error) {
      if (this.config.notify && this.notifyFn) {
        this.notifyFn(`Auto-update check failed: ${result.error}`);
      }
      if (resuming && this.pendingVersion) {
        if (this.config.notify && this.notifyFn) {
          this.notifyFn(
            `Resuming pending update to Strada Brain ${this.pendingVersion}. Will update when idle.`,
          );
        }
        this.startIdleMonitoring();
      }
      return;
    }
    if (!result.available || !result.latestVersion) {
      this.settleUpToDate(result);
      return;
    }

    const target = result.latestRevision ?? result.latestVersion;
    const hold = this.activeHold(target);
    if (hold) {
      this.standDown(hold);
      return;
    }
    this.pendingTarget = target;
    this.pendingVersion = result.latestVersion;
    this.savePendingVersion();

    if (this.config.notify && this.notifyFn) {
      this.notifyFn(
        `Update available: Strada Brain ${result.latestVersion}. ${this.whenItUpdates()}`,
      );
    }

    this.startIdleMonitoring();
  }

  /**
   * Whether this process must not start an update now. Not after shutdown():
   * the process is going down. Nor while a restart onto the last update is
   * pending: the restart polls for the same idleness the update waits for,
   * and SIGTERMed an update a webhook had queued during the wait in the
   * middle of its build — no health check, no rollback, no record, its npm
   * still writing dist/ while the daemon booted onto it (review of
   * 1dbe763e). The pending version stays saved, and the restarted process
   * checks it again (init).
   */
  private mustNotStartUpdate(): boolean {
    if (this.stopped) return true;
    if (!this.restartPending) return false;
    this.savePendingVersion();
    getLoggerSafe().info("Auto-update waits for the pending restart — the restarted process checks again", {
      pending: this.pendingVersion,
    });
    return true;
  }

  private startIdleMonitoring(): void {
    if (this.idleCheckHandle || this.mustNotStartUpdate()) return;

    this.idleCheckHandle = setInterval(async () => {
      if (!this.isIdleNow()) return;

      if (this.idleCheckHandle) {
        clearInterval(this.idleCheckHandle);
        this.idleCheckHandle = null;
      }

      // The check that queued this update can be hours old, and a pending
      // update resumed after a restart had none: the checkout may have been
      // updated by hand since. An update to nothing still pulled, rebuilt,
      // said "Updated to <an older version>" and restarted (audit
      // core-bootstrap#4). A check that cannot tell changes nothing.
      const recheck = await this.checkForUpdate();
      if (!recheck.error) {
        if (!recheck.available || !recheck.latestVersion) {
          this.settleUpToDate(recheck);
          return;
        }
        this.pendingTarget = recheck.latestRevision ?? recheck.latestVersion;
        this.pendingVersion = recheck.latestVersion;
      }

      const hold = this.activeHold(this.pendingTarget);
      if (hold) {
        this.standDown(hold);
        return;
      }
      // Asked again after the check: a restart may have been armed, or the
      // updater shut down, while it ran.
      if (this.mustNotStartUpdate()) return;

      const attemptedAt = Date.now();
      const attempting = this.pendingTarget;
      try {
        const success = await this.performUpdate();
        if (!success) {
          this.startIdleMonitoring();
          return;
        }
        // The restart does not depend on notices being on: with notify off it
        // never happened, and the running process kept its old modules while
        // later lazy imports loaded the new dist/ (COR-15).
        const restart = this.config.autoRestart && this.isDaemonProcess();
        // What is on disk now, not what a check said hours ago.
        const installed = this.getCurrentVersion();
        if (this.config.notify && this.notifyFn) {
          this.notifyFn(
            restart
              ? `Updated to ${installed}. Restarting once nothing is running...`
              : `Updated to ${installed}. Please restart with \`strada start\`${!this.isDaemonProcess() ? " (auto-restart requires `strada daemon`)" : ""}.`,
          );
        }
        if (restart) this.restartWhenIdle(this.config.autoRestartDelayMs ?? 2000);
        // A check during the update may have queued a newer one. Clearing it
        // here deleted it from disk before the restart, and the restarted
        // process had only its own check to find it again.
        if (this.pendingTarget === attempting) this.clearPendingVersion();
        else this.savePendingVersion();
      } catch (err) {
        const held = readUpdateHold(this.getUpdateRecordsRoot());
        if (held && held.at >= attemptedAt) {
          // The hold decides when to try again, not the pending version.
          this.announcedHoldAt = held.at;
          this.clearPendingVersion();
          this.notifyFn?.(
            `Update to ${held.target.slice(0, 8)} failed at ${held.step}${describeRollback(held.rollback)}: ${held.cause}\n` +
            `${held.target.slice(0, 8)} will not be retried automatically; the next automatic attempt at anything newer is ` +
            `${describeWhen(held.retryAfter, Date.now())} (${held.failures} failed update${held.failures === 1 ? "" : "s"} in a row). ` +
            "Run `strada update` to retry now.",
          );
          return;
        }
        // Nothing landed (the pull itself failed): the next check tries again.
        this.notifyFn?.(`Update failed: ${describeFailure(err, 600)}. Will retry next check.`);
      }
    }, IDLE_POLL_MS);

    if (this.idleCheckHandle.unref) this.idleCheckHandle.unref();
  }

  private isIdleNow(): boolean {
    return this.registry.isIdle(this.config.idleTimeoutMin) && !this.executor.hasRunningTasks();
  }

  private restartHandle: ReturnType<typeof setTimeout> | null = null;
  /** Set once a restart is armed, and kept through its SIGTERM: no update starts after it. */
  private restartPending = false;
  private updateInFlight = false;
  private stopped = false;

  /**
   * SIGTERM this process so setupShutdownHandlers shuts it down gracefully
   * (DB flush, connection close) and the daemon wrapper restarts it on the
   * clean exit — once nothing is running, this process's own update included.
   * Idleness was read only before an update that takes minutes, and work that
   * started meanwhile (a chat, the campaign's next sprint) was aborted by the
   * shutdown two seconds after the update finished (audit core-bootstrap#1).
   * Only the restart waits; the update is done.
   */
  private restartWhenIdle(delayMs: number): void {
    // One restart: a second loop outlived shutdown(), which clears only the
    // newest handle, and its SIGTERM read as a forced exit (review of 1dbe763e).
    if (this.restartHandle) clearTimeout(this.restartHandle);
    this.restartPending = true;
    const installed = this.getCurrentVersion();
    const armedAt = Date.now();
    let loggedAt: number | null = null;
    let warned = false;
    const attempt = (): void => {
      this.restartHandle = null;
      if (this.isIdleNow() && !this.updateInFlight) {
        process.kill(process.pid, "SIGTERM");
        return;
      }
      // Until the restart, the old code in memory runs beside the new code on
      // disk, and later lazy imports load the new (COR-15). The wait has no
      // bound, so it keeps saying so rather than once.
      const now = Date.now();
      if (loggedAt === null || now - loggedAt >= RESTART_WAIT_LOG_EVERY_MS) {
        loggedAt = now;
        getLoggerSafe().info("Auto-update restart waits until nothing is running", {
          installed,
          waited: describeSpan(now - armedAt),
          runningTasks: this.executor.hasRunningTasks(),
          updateRunning: this.updateInFlight,
        });
      }
      if (!warned && now - armedAt >= RESTART_WAIT_WARN_AFTER_MS) {
        warned = true;
        // Stopping this process is all the restart does: the daemon starts it
        // again on the new code.
        const message =
          `Strada updated to ${installed} ${describeSpan(now - armedAt)} ago and has not been idle since, so it has not ` +
          "restarted onto it; until it does, it runs the old code beside the new. Restart it when the work allows: " +
          `stopping PID ${process.pid} is enough, the daemon starts it again.`;
        getLoggerSafe().warn("Auto-update restart still waits — restart by hand when the work allows", {
          installed,
          waited: describeSpan(now - armedAt),
        });
        if (this.config.notify && this.notifyFn) this.notifyFn(message);
      }
      this.restartHandle = setTimeout(attempt, IDLE_POLL_MS);
    };
    this.restartHandle = setTimeout(attempt, delayMs);
  }

  shutdown(): void {
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.idleCheckHandle) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
    if (this.restartHandle) {
      clearTimeout(this.restartHandle);
      this.restartHandle = null;
    }
    this.savePendingVersion();
  }
}

export interface SpawnWithTimeoutOptions {
  /** How long a timed-out command gets after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * Run an updater command (git, npm, node) with a deadline.
 *
 * COR-20: a timeout used to reject the moment it fired, while the command was
 * still dying — so the rollback that follows (`git checkout`, `npm install`)
 * ran alongside the old `npm install` in the same tree. The promise now
 * settles only once the command has exited. On Windows the `.cmd` shims run
 * under a shell, and killing that shell leaves npm/node running, so the whole
 * tree is ended with taskkill.
 */
export function spawnWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  options: SpawnWithTimeoutOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const killGraceMs = options.killGraceMs ?? 5000;
  return new Promise((resolve, reject) => {
    const shell = platform === "win32" && (cmd === "npm" || cmd.endsWith(".cmd") || cmd.endsWith(".bat"));
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd, shell, windowsHide: true });
    let stdoutData = "";
    let stderrData = "";
    // Both streams in arrival order, bounded: what a timed-out command was
    // doing when it was killed. Seven rollbacks (2026-09-18..20) said only
    // "Command timed out: npm run build".
    let recentOutput = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abandonTimer) clearTimeout(abandonTimer);
      finish();
    };
    const timeoutError = (): Error => {
      const last = tailOf(recentOutput);
      return new Error(
        `Command timed out after ${Math.round(timeoutMs / 1000)} s: ${cmd} ${args.join(" ")}` +
        (last ? `\nlast output: ${last}` : ""),
      );
    };
    // tsc writes its diagnostics to stdout: a failed portal build's stderr
    // held only "[strada] Portal build FAILED" (2026-09-17 15:15 and 20:22).
    const exitError = (code: number | null): Error => {
      const stdoutTail = tailOf(stdoutData);
      return new Error(
        `${cmd} exited with code ${code}: ${tailOf(stderrData)}` + (stdoutTail ? `\nstdout: ${stdoutTail}` : ""),
      );
    };
    const remember = (chunk: string): void => {
      recentOutput = (recentOutput + chunk).slice(-2 * OUTPUT_TAIL_CHARS);
    };

    const killTree = (signal: NodeJS.Signals): void => {
      if (platform === "win32" && proc.pid !== undefined) {
        const plan = planTreeKill(platform, proc.pid, signal);
        if (plan.kind === "taskkill") {
          const killer = spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true });
          killer.on("error", () => {
            try { proc.kill(signal); } catch { /* already gone */ }
          });
          return;
        }
      }
      try { proc.kill(signal); } catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => {
        killTree("SIGKILL");
        // A process that survives SIGKILL (stuck in the kernel) must not hang
        // the updater forever; this is the only path that settles early.
        abandonTimer = setTimeout(() => settle(() => reject(timeoutError())), killGraceMs);
      }, killGraceMs);
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdoutData += chunk;
      remember(chunk);
    });
    proc.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrData += chunk;
      remember(chunk);
    });

    // 'exit', not 'close': a grandchild that inherited the pipes can keep them
    // open after the command itself is gone.
    proc.on("exit", () => {
      if (timedOut) settle(() => reject(timeoutError()));
    });
    proc.on("close", (code) => {
      settle(() => {
        if (timedOut) reject(timeoutError());
        else if (code === 0) resolve(stdoutData);
        else reject(exitError(code));
      });
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });
  });
}
