import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";

const VERSION_CHECK_TIMEOUT = 30_000;
const UPDATE_TIMEOUT = 5 * 60 * 1000;
const STALE_LOCK_MAX_AGE = 30 * 60 * 1000;

export type InstallMethod = "npm-global" | "npm-local" | "git";

export interface AutoUpdateConfig {
  enabled: boolean;
  intervalHours: number;
  idleTimeoutMin: number;
  channel: "stable" | "latest";
  notify: boolean;
  autoRestart: boolean;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
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
}

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
  private installMethod: InstallMethod | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pendingVersion: string | null = null;
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private notifyFn: ((msg: string) => void) | null = null;

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
      .filter((entry) => /(?:src[\\/]+index\.ts|dist[\\/]+index\.js)\s+start(?:\s|$)/.test(entry.command));
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

  private spawnWithTimeout(
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
      let stdoutData = "";
      let stderrData = "";

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
      }, timeoutMs);

      proc.stdout.on("data", (data: Buffer) => {
        stdoutData += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderrData += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdoutData);
        else reject(new Error(`${cmd} exited with code ${code}: ${stderrData}`));
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
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
    return this.spawnWithTimeout(cmd, args, timeoutMs, cwd);
  }

  private async runPostUpdateHealthCheck(): Promise<void> {
    if (this.healthChecker) {
      await this.healthChecker();
      return;
    }
    const distIndex = path.join(this.installRoot, "dist", "index.js");
    if (!fs.existsSync(distIndex)) {
      return;
    }
    await this.runCommand(
      process.execPath,
      [distIndex, "--version"],
      30_000,
      this.installRoot,
    );
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

    if (process.platform === "win32") {
      return [];
    }

    try {
      const output = await this.runCommand("ps", ["-Ao", "pid=,command="], 5_000);
      const candidates = AutoUpdater.parsePsRuntimeProcesses(output)
        .filter((entry) => entry.pid !== process.pid);
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

  async checkForUpdate(): Promise<UpdateCheckResult> {
    const currentVersion = this.getCurrentVersion();
    const method = this.detectInstallMethod();

    try {
      if (method === "git") {
        await this.runCommand(
          "git",
          ["fetch", "origin", "main"],
          VERSION_CHECK_TIMEOUT,
          this.installRoot,
        );
        // Ensure local ref is resolved (side-effect: validates git state)
        await this.runCommand("git", ["rev-parse", "HEAD"], VERSION_CHECK_TIMEOUT, this.installRoot);
        const remoteRev = (
          await this.runCommand(
            "git",
            ["rev-parse", "origin/main"],
            VERSION_CHECK_TIMEOUT,
            this.installRoot,
          )
        ).trim();
        // Check if origin/main has commits we don't have (remote is ahead)
        const behindCount = (
          await this.runCommand(
            "git",
            ["rev-list", "--count", `HEAD..origin/main`],
            VERSION_CHECK_TIMEOUT,
            this.installRoot,
          )
        ).trim();
        return {
          available: parseInt(behindCount, 10) > 0,
          currentVersion,
          latestVersion: remoteRev.substring(0, 8),
        };
      } else {
        const distTag = this.config.channel === "latest" ? "latest" : "stable";
        const output = await this.runCommand(
          "npm",
          ["view", `strada-brain@${distTag}`, "version"],
          VERSION_CHECK_TIMEOUT,
        );
        const remoteVersion = AutoUpdater.parseVersionFromOutput(output);
        if (!remoteVersion) {
          return { available: false, currentVersion, latestVersion: null };
        }
        return {
          available: AutoUpdater.isNewerVersion(currentVersion, remoteVersion),
          currentVersion,
          latestVersion: remoteVersion,
        };
      }
    } catch {
      return { available: false, currentVersion, latestVersion: null };
    }
  }

  async performUpdate(): Promise<boolean> {
    if (!this.acquireLock()) return false;

    try {
      const method = this.detectInstallMethod();

      if (method === "git") {
        const prePullSha = (
          await this.runCommand(
            "git",
            ["rev-parse", "HEAD"],
            VERSION_CHECK_TIMEOUT,
            this.installRoot,
          )
        ).trim();
        try {
          await this.runCommand(
            "git",
            ["pull", "origin", "main"],
            UPDATE_TIMEOUT,
            this.installRoot,
          );
          await this.runCommand("npm", ["install"], UPDATE_TIMEOUT, this.installRoot);
          const portalPkgPath = path.join(this.installRoot, "web-portal", "package.json");
          if (fs.existsSync(portalPkgPath)) {
            await this.runCommand(
              "npm",
              ["install"],
              UPDATE_TIMEOUT,
              path.join(this.installRoot, "web-portal"),
            );
          }
          await this.runCommand("npm", ["run", "build"], UPDATE_TIMEOUT, this.installRoot);
        } catch (buildErr) {
          try {
            await this.runCommand(
              "git",
              ["reset", "--hard", prePullSha],
              VERSION_CHECK_TIMEOUT,
              this.installRoot,
            );
            // Restore old dependencies after source rollback
            await this.runCommand("npm", ["install"], UPDATE_TIMEOUT, this.installRoot);
          } catch {
            // Rollback failed — nothing we can do
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
          if (this.notifyFn) {
            this.notifyFn(
              `Update build succeeded but health check failed: ${(healthErr as Error).message}. Rolling back...`,
            );
          }
          try {
            await this.runCommand(
              "git",
              ["reset", "--hard", prePullSha],
              VERSION_CHECK_TIMEOUT,
              this.installRoot,
            );
            await this.runCommand("npm", ["install"], UPDATE_TIMEOUT, this.installRoot);
            await this.runCommand("npm", ["run", "build"], UPDATE_TIMEOUT, this.installRoot);
          } catch {
            // Rollback failed
          }
          throw healthErr;
        }
      } else {
        const args = method === "npm-global"
          ? ["install", "-g", `strada-brain@${this.config.channel}`]
          : ["install", `strada-brain@${this.config.channel}`];
        await this.runCommand("npm", args, UPDATE_TIMEOUT, method === "npm-local" ? this.installRoot : undefined);
      }

      return true;
    } finally {
      this.releaseLock();
    }
  }

  private getLockPath(): string {
    return path.join(this.installRoot, ".strada-update.lock");
  }

  acquireLock(): boolean {
    const lockPath = this.getLockPath();

    if (fs.existsSync(lockPath)) {
      try {
        const content: LockContent = JSON.parse(
          fs.readFileSync(lockPath, "utf-8"),
        ) as LockContent;

        if (Date.now() - content.timestamp > STALE_LOCK_MAX_AGE) {
          fs.unlinkSync(lockPath);
        } else {
          try {
            process.kill(content.pid, 0);
            return false;
          } catch {
            fs.unlinkSync(lockPath);
          }
        }
      } catch {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lock file unreadable and undeletable
        }
      }
    }

    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
        { encoding: "utf-8", flag: "wx" },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      return false;
    }
  }

  releaseLock(): void {
    try {
      const lockPath = this.getLockPath();
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // Best-effort cleanup
    }
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;
    this.detectInstallMethod();
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
    if (result.available && result.latestVersion) {
      this.pendingVersion = result.latestVersion;
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
    if (!result.available || !result.latestVersion) return;

    this.pendingVersion = result.latestVersion;

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

      try {
        const success = await this.performUpdate();
        if (success && this.config.notify && this.notifyFn) {
          if (this.config.autoRestart && this.isDaemonProcess()) {
            this.notifyFn(
              `Updated to ${this.pendingVersion}. Restarting...`,
            );
            setTimeout(() => process.exit(0), 2000);
          } else {
            this.notifyFn(
              `Updated to ${this.pendingVersion}. Please restart with \`strada start\`${!this.isDaemonProcess() ? " (auto-restart requires `strada daemon`)" : ""}.`,
            );
          }
        }
        this.pendingVersion = null;
      } catch (err) {
        if (this.notifyFn) {
          this.notifyFn(
            `Update failed: ${(err as Error).message}. Will retry next check.`,
          );
        }
        // Don't clear pendingVersion — let next periodic check re-trigger
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
  }
}
