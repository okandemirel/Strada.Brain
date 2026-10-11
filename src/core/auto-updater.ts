import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { getLoggerSafe } from "../utils/logger.js";
import {
  clearUpdateHold, describeUpdateHold, describeWhen, readUpdateHold, recordUpdateEvent, writeUpdateHold,
  type UpdateHold,
} from "./update-history.js";
import { planTreeKill } from "../utils/process-runner.js";
import { resolveRuntimePaths } from "../common/runtime-paths.js";
import { installLockPath } from "./runtime-lock.js";

const VERSION_CHECK_TIMEOUT = 30_000;
const UPDATE_TIMEOUT = 5 * 60 * 1000;
const STALE_LOCK_MAX_AGE = 30 * 60 * 1000;
/**
 * Boot smoke budget. The script itself gives the daemon BOOT_SMOKE_TIMEOUT_S
 * (120s default) to answer /health, plus shutdown; 5 minutes covers a slow
 * runner without letting a wedged boot hold the updater open forever.
 */
const BOOT_SMOKE_TIMEOUT = 5 * 60 * 1000;
/**
 * Default budget, in minutes, for each `npm install` / `npm run build` after a
 * pull (AUTO_UPDATE_BUILD_TIMEOUT_MIN). A fixed 5 minutes timed out seven
 * builds in a row on the daemon host (2026-09-18 21:55 .. 09-20 10:34), after
 * two installs that took ~5 minutes apiece; the same build measured 69 s at
 * load average 30-106 there (2026-10-11). Three times the budget they overran.
 */
const DEFAULT_BUILD_TIMEOUT_MIN = 15;
/** After N consecutive failed updates the next one waits 2^(N-1) check intervals, at most 2^this. */
const MAX_BACKOFF_DOUBLINGS = 3;
/** How much of a failed command's output its error keeps: the end, where the cause is. */
const OUTPUT_TAIL_CHARS = 1500;
/** The files whose change makes a package's node_modules stale. */
const DEPENDENCY_MANIFESTS = ["package.json", "package-lock.json"];

export type InstallMethod = "npm-global" | "npm-local" | "git";

export interface AutoUpdateConfig {
  enabled: boolean;
  intervalHours: number;
  idleTimeoutMin: number;
  channel: "stable" | "latest";
  notify: boolean;
  autoRestart: boolean;
  autoRestartDelayMs?: number;
  /** Minutes each post-pull install/build step may take. Default DEFAULT_BUILD_TIMEOUT_MIN. */
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
  token?: string;
}

/** Holder start times within this margin are the same process (clock and tick rounding). */
const START_TIME_MARGIN_MS = 5000;
/** USER_HZ: the unit of /proc/<pid>/stat starttime, fixed at 100 by the Linux user ABI. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/**
 * When `pid` started (ms since the epoch) as the OS reports it, or null when
 * that cannot be determined here. The update lock compares THE HOLDER's start
 * time with the one it recorded; comparing the checker's own start time (as
 * before) judged every live holder that started >5 s apart from the checker
 * as "PID reuse" and broke its lock mid-update (COR-3).
 */
export function readProcessStartTime(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Fields after "(comm) ": state is field 3, starttime field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTicks = Number(fields[19]);
      const btime = fs.readFileSync("/proc/stat", "utf-8").split("\n").find((line) => line.startsWith("btime "));
      const bootSeconds = Number(btime?.slice("btime ".length));
      if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds) || !btime) return null;
      return bootSeconds * 1000 + (startTicks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND;
    }
    const probe = process.platform === "win32"
      ? spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: "utf-8", timeout: 10_000, windowsHide: true })
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 });
    if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
    const parsed = Date.parse(probe.stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let ownStartTime: number | null = null;

/** This process's start time, measured the way a checker will measure it. */
function getProcessStartTime(): number {
  ownStartTime ??= readProcessStartTime(process.pid) ?? Date.now() - process.uptime() * 1000;
  return ownStartTime;
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

  /** The budget for each post-pull install and build step (AUTO_UPDATE_BUILD_TIMEOUT_MIN). */
  private stepTimeoutMs(): number {
    // `config` is absent on updaters the tests build without a constructor.
    const minutes = (this.config as AutoUpdateConfig | undefined)?.buildTimeoutMin;
    return (typeof minutes === "number" && minutes > 0 ? minutes : DEFAULT_BUILD_TIMEOUT_MIN) * 60_000;
  }

  /**
   * The packages (the root, and web-portal with its own lockfile) whose
   * dependencies `toSha` needs installed: those whose package.json or
   * package-lock.json differ from `fromSha`, and those with no completed
   * install. Both installs used to run on every update — about 5 minutes
   * apiece on the daemon host in September, two thirds of each failed update.
   * `npm install` leaves node_modules/.package-lock.json behind; a portal
   * build run without dependencies leaves only node_modules/.tmp, which is
   * not an install.
   */
  private async packagesNeedingInstall(fromSha: string, toSha: string): Promise<string[]> {
    const portal = path.join(this.installRoot, "web-portal");
    const packages = [
      { dir: this.installRoot, manifests: DEPENDENCY_MANIFESTS },
      ...(fs.existsSync(path.join(portal, "package.json"))
        ? [{ dir: portal, manifests: DEPENDENCY_MANIFESTS.map((name) => `web-portal/${name}`) }]
        : []),
    ];
    let changed: string[] | null = [];
    if (fromSha !== toSha) {
      try {
        const output = await this.runCommand(
          "git",
          ["diff", "--name-only", fromSha, toSha, "--", ...packages.flatMap((p) => p.manifests)],
          VERSION_CHECK_TIMEOUT,
          this.installRoot,
        );
        changed = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      } catch {
        changed = null; // unknown: reinstalling costs minutes, building on stale dependencies costs the update
      }
    }
    const changedManifests = changed;
    return packages
      .filter((p) => (
        !fs.existsSync(path.join(p.dir, "node_modules", ".package-lock.json"))
        || changedManifests === null
        || p.manifests.some((manifest) => changedManifests.includes(manifest))
      ))
      .map((p) => p.dir);
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

    try {
      const method = this.detectInstallMethod();
      const updated = method === "git"
        ? await this.performGitUpdate()
        : await this.performNpmUpdate(method);
      if (updated) clearUpdateHold(this.installRoot);
      return updated;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Remember a failed update (see UpdateHold): the scheduled check will not
   * attempt `target` again, and waits out a backoff that doubles with each
   * consecutive failure before attempting anything newer. Until 2026-09-20 a
   * failure only said "Will retry next check", and every check did.
   */
  private holdBack(target: string, step: string, err: unknown): void {
    const now = Date.now();
    const failures = (readUpdateHold(this.installRoot)?.failures ?? 0) + 1;
    const intervalMs = ((this.config as AutoUpdateConfig | undefined)?.intervalHours || 6) * 60 * 60 * 1000;
    const hold: UpdateHold = {
      target,
      step,
      cause: describeFailure(err, 600),
      at: now,
      failures,
      retryAfter: now + intervalMs * 2 ** Math.min(failures - 1, MAX_BACKOFF_DOUBLINGS),
    };
    writeUpdateHold(this.installRoot, hold);
    getLoggerSafe().warn("Auto-update held back", {
      target,
      step,
      failures,
      retryAfter: new Date(hold.retryAfter).toISOString(),
    });
  }

  /** The hold that keeps the scheduled updater away from `target` now, if any. */
  private activeHold(target: string | null): UpdateHold | null {
    const hold = readUpdateHold(this.installRoot);
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
      await this.runCommand(
        "git",
        ["stash", "push", "-u", "-m", "auto-updater: stash before pull", "--", ".", ":(exclude).strada-update.lock"],
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
    // Empty until the pull lands; a rollback before that has nothing to guard
    // against and never runs, because the pull is the first thing in the try.
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

    /**
     * Roll the checkout back to where the pull found it — but ONLY if nothing
     * else has committed since.
     *
     * Measured live 2026-09-04. The updater pulled at 12:21:27 (1b527dbf →
     * 235e5f9f), a commit landed on the branch at 12:23:50, and the failed
     * post-update health check ran `git reset --hard 1b527dbf` at 12:30:39 —
     * destroying both the pulled version bump and that commit. It survived
     * only in the reflog, and nothing in the run log said an update had been
     * attempted at all. A nine-minute window in which any commit to this
     * checkout is silently discarded.
     *
     * So the rollback verifies HEAD is still the SHA the pull left, and when
     * it is not it REFUSES and says so. A stale checkout the operator can fix
     * is recoverable; a discarded commit is not.
     */
    const rollbackTo = async (postPullSha: string, why: string): Promise<void> => {
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
        return;
      }
      getLoggerSafe().warn("Auto-update rolling back", { to: prePullSha, reason: why });
      await this.runCommand("git", ["reset", "--hard", prePullSha], VERSION_CHECK_TIMEOUT, this.installRoot);
      recordUpdateEvent(this.installRoot, { at: Date.now(), kind: "rolled-back", from: postPullSha, to: prePullSha, reason: why });
    };

    // The packages whose dependencies the update reinstalled; a rollback
    // reinstalls the same ones to put the old dependencies back.
    let reinstalled: string[] = [];
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
      reinstalled = await this.packagesNeedingInstall(prePullSha, postPullSha);
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
      try {
        await rollbackTo(postPullSha, `${step} failed`);
        // Restore old dependencies after source rollback
        await this.installProjectDependencies(reinstalled);
        // A failed build still writes dist/: tsc emits despite type errors,
        // and a failed portal build leaves the new server code behind. Until
        // the rolled-back source is built again, the next start (and every
        // lazy import) runs the version that was just rejected (COR-4).
        if (step === "npm run build") {
          await this.runCommand("npm", ["run", "build"], this.stepTimeoutMs(), this.installRoot);
        }
      } catch (rollbackErr) {
        // Rollback failed — nothing more we can do; say so for the operator.
        getLoggerSafe().warn("Auto-update rollback did not complete", {
          detail: describeFailure(rollbackErr),
        });
      }
      await popStash();
      // A pull that never landed (no network, divergent history) says nothing
      // about the commit, so only a landed one is held back.
      if (postPullSha !== prePullSha) this.holdBack(postPullSha, step, buildErr);
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
      try {
        await rollbackTo(postPullSha, "the post-update health check failed");
        await this.installProjectDependencies(reinstalled);
        await this.runCommand("npm", ["run", "build"], this.stepTimeoutMs(), this.installRoot);
      } catch (rollbackErr) {
        getLoggerSafe().warn("Auto-update rollback did not complete", {
          detail: describeFailure(rollbackErr),
        });
      }
      await popStash();
      if (postPullSha !== prePullSha) this.holdBack(postPullSha, "the post-update health check", healthErr);
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
          await this.runCommand("npm", ["install"], UPDATE_TIMEOUT, rollbackRoot);
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
        rollbackCommand = async (): Promise<void> => {
          try {
            await this.runCommand(
              "npm",
              ["install", "-g", `strada-brain@${currentGlobalVersion}`],
              UPDATE_TIMEOUT,
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

    try {
      await this.runCommand("npm", buildArgs(tag), UPDATE_TIMEOUT, cwd);
    } catch (installErr) {
      if (tag !== "latest") {
        try {
          await this.runCommand("npm", buildArgs("latest"), UPDATE_TIMEOUT, cwd);
        } catch {
          if (rollbackCommand) {
            await rollbackCommand();
          }
          throw installErr;
        }
      } else {
        if (rollbackCommand) {
          await rollbackCommand();
        }
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
      if (rollbackCommand) {
        try {
          await rollbackCommand();
        } catch (rollbackErr) {
          if (this.notifyFn) {
            this.notifyFn(`Rollback failed: ${(rollbackErr as Error).message}`);
          }
        }
      }
      // The package installed, so this is the version failing, not the registry.
      this.holdBack(target, "the post-update health check", healthErr);
      throw healthErr;
    }

    // Cleanup backup files after a successful update — from the OWNER's
    // directory, which is where they were written (round 10 #21). Passing
    // nothing cleaned `this.installRoot` (the installed package) instead, so an
    // npm-local update left `<owner>/.strada-update-backup-*` behind forever,
    // including a full copy of the package tree. `ownerRoot` is undefined for
    // npm-global, where the default installRoot is the right root.
    this.cleanupNpmBackups(ownerRoot);

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
    const holderStartTime = typeof content.startTime === "number" ? readProcessStartTime(content.pid) : null;
    if (holderStartTime !== null) {
      return Math.abs(holderStartTime - content.startTime!) > START_TIME_MARGIN_MS;
    }

    // The holder cannot be identified: a live PID holds the lock until it is
    // old enough that no update can still be running under it.
    return Date.now() - content.timestamp > STALE_LOCK_MAX_AGE;
  }

  /**
   * The update lock lives under the writable config root, keyed by the install
   * root (COR-21): a root-owned or read-only install root made the lock
   * uncreatable, and the failure was reported as "another update is running".
   */
  private getLockPath(): string {
    this.stateRoot ??= resolveRuntimePaths({ installRoot: this.installRoot }).configRoot;
    return installLockPath(this.stateRoot, this.installRoot, "update");
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
    const body = JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      startTime: getProcessStartTime(),
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
    if (this.pendingVersion) {
      if (this.config.notify && this.notifyFn) {
        this.notifyFn(
          `Resuming pending update to Strada Brain ${this.pendingVersion}. Will update when idle.`,
        );
      }
      this.startIdleMonitoring();
    }
    this.runUpdateCheck().catch(() => {});
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
          `Update available: Strada Brain ${result.latestVersion} (triggered by webhook). Will update when idle.`,
        );
      }
      this.startIdleMonitoring();
    }
    return result;
  }

  private async runUpdateCheck(): Promise<void> {
    const result = await this.checkForUpdate();
    if (result.error) {
      if (this.config.notify && this.notifyFn) {
        this.notifyFn(`Auto-update check failed: ${result.error}`);
      }
      return;
    }
    if (!result.available || !result.latestVersion) return;

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
        `Update available: Strada Brain ${result.latestVersion}. Will update when idle.`,
      );
    }

    this.startIdleMonitoring();
  }

  private startIdleMonitoring(): void {
    if (this.idleCheckHandle) return;

    this.idleCheckHandle = setInterval(async () => {
      const isIdle =
        this.registry.isIdle(this.config.idleTimeoutMin) &&
        !this.executor.hasRunningTasks();
      if (!isIdle) return;

      if (this.idleCheckHandle) {
        clearInterval(this.idleCheckHandle);
        this.idleCheckHandle = null;
      }

      // A pending update resumed after a restart has had no check to judge it.
      const hold = this.activeHold(this.pendingTarget);
      if (hold) {
        this.standDown(hold);
        return;
      }

      const attemptedAt = Date.now();
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
        if (this.config.notify && this.notifyFn) {
          this.notifyFn(
            restart
              ? `Updated to ${this.pendingVersion}. Restarting...`
              : `Updated to ${this.pendingVersion}. Please restart with \`strada start\`${!this.isDaemonProcess() ? " (auto-restart requires `strada daemon`)" : ""}.`,
          );
        }
        if (restart) {
          // Send SIGTERM to self so setupShutdownHandlers triggers graceful
          // shutdown (DB flush, connection close, etc.) before exit.
          // The daemon wrapper will detect the clean exit and restart.
          const restartDelay = this.config.autoRestartDelayMs ?? 2000;
          setTimeout(() => process.kill(process.pid, "SIGTERM"), restartDelay);
        }
        this.clearPendingVersion();
      } catch (err) {
        const held = readUpdateHold(this.installRoot);
        if (held && held.at >= attemptedAt) {
          // The hold decides when to try again, not the pending version.
          this.announcedHoldAt = held.at;
          this.clearPendingVersion();
          this.notifyFn?.(
            `Update to ${held.target.slice(0, 8)} failed at ${held.step} and was rolled back: ${held.cause}\n` +
            `${held.target.slice(0, 8)} will not be retried automatically; the next automatic attempt at anything newer is ` +
            `${describeWhen(held.retryAfter, Date.now())} (${held.failures} failed update${held.failures === 1 ? "" : "s"} in a row). ` +
            "Run `strada update` to retry now.",
          );
          return;
        }
        // Nothing landed (the pull itself failed): the next check tries again.
        this.notifyFn?.(`Update failed: ${describeFailure(err, 600)}. Will retry next check.`);
      }
    }, 30_000);

    if (this.idleCheckHandle.unref) this.idleCheckHandle.unref();
  }

  shutdown(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.idleCheckHandle) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
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
