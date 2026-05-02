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
  autoRestartDelayMs?: number;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  error: string | null;
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
  startTime: number;
}

/**
 * Returns the approximate process start time.
 * Note: This is calculated as Date.now() - process.uptime() and may be
 * off by a few milliseconds due to event loop timing, but is sufficient
 * for PID reuse detection where we allow a 5-second margin.
 */
function getProcessStartTime(): number {
  return Date.now() - process.uptime() * 1000;
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

  private spawnWithTimeout(
    cmd: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const shell = process.platform === "win32" && (cmd === "npm" || cmd.endsWith(".cmd") || cmd.endsWith(".bat"));
      const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd, shell });
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

  private async installProjectDependencies(): Promise<void> {
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

      if (method === "git") {
        return await this.performGitUpdate();
      } else {
        return await this.performNpmUpdate(method);
      }
    } finally {
      this.releaseLock();
    }
  }

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
    const hadLocalChanges = statusOutput.length > 0;
    if (hadLocalChanges) {
      await this.runCommand(
        "git",
        ["stash", "push", "-u", "-m", "auto-updater: stash before pull"],
        VERSION_CHECK_TIMEOUT,
        this.installRoot,
      );
    }

    const prePullSha = (
      await this.runCommand(
        "git",
        ["rev-parse", "HEAD"],
        VERSION_CHECK_TIMEOUT,
        this.installRoot,
      )
    ).trim();
    const popStash = async (): Promise<void> => {
      if (!hadLocalChanges) return;
      try {
        await this.runCommand("git", ["stash", "pop"], VERSION_CHECK_TIMEOUT, this.installRoot);
      } catch {
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

    try {
      await this.runCommand(
        "git",
        ["pull", remote, branch],
        UPDATE_TIMEOUT,
        this.installRoot,
      );
      await this.installProjectDependencies();
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
        await this.installProjectDependencies();
      } catch {
        // Rollback failed — nothing we can do
      }
      await popStash();
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
        await this.installProjectDependencies();
        await this.runCommand("npm", ["run", "build"], UPDATE_TIMEOUT, this.installRoot);
      } catch {
        // Rollback failed
      }
      await popStash();
      throw healthErr;
    }

    await popStash();
    return true;
  }

  private async performNpmUpdate(method: "npm-global" | "npm-local"): Promise<boolean> {
    const tag = this.config.channel;
    const buildArgs = (t: string) => method === "npm-global"
      ? ["install", "-g", `strada-brain@${t}`]
      : ["install", `strada-brain@${t}`];
    const cwd = method === "npm-local" ? this.installRoot : undefined;

    let rollbackCommand: (() => Promise<void>) | null = null;

    if (method === "npm-local") {
      const pkgBackup = path.join(this.installRoot, ".strada-update-backup-package.json");
      const lockBackup = path.join(this.installRoot, ".strada-update-backup-package-lock.json");
      const nmBackup = path.join(this.installRoot, ".strada-update-backup-node_modules");
      const pkgPath = path.join(this.installRoot, "package.json");
      const lockPath = path.join(this.installRoot, "package-lock.json");
      const nmPath = path.join(this.installRoot, "node_modules", "strada-brain");

      if (fs.existsSync(pkgPath)) {
        fs.copyFileSync(pkgPath, pkgBackup);
      }
      if (fs.existsSync(lockPath)) {
        fs.copyFileSync(lockPath, lockBackup);
      }
      if (fs.existsSync(nmPath)) {
        fs.renameSync(nmPath, nmBackup);
      }

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
          await this.runCommand("npm", ["install"], UPDATE_TIMEOUT, this.installRoot);
        } catch (rollbackErr) {
          if (this.notifyFn) {
            this.notifyFn(`Rollback failed: ${(rollbackErr as Error).message}`);
          }
          throw rollbackErr;
        } finally {
          this.cleanupNpmBackups();
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
      if (this.notifyFn) {
        this.notifyFn(
          `Update installed but health check failed: ${(healthErr as Error).message}. Rolling back...`,
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
      throw healthErr;
    }

    // Cleanup backup files after successful update
    this.cleanupNpmBackups();

    return true;
  }

  private cleanupNpmBackups(): void {
    const backupFiles = [
      path.join(this.installRoot, ".strada-update-backup-package.json"),
      path.join(this.installRoot, ".strada-update-backup-package-lock.json"),
      path.join(this.installRoot, ".strada-update-backup-node_modules"),
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
    // Check timestamp-based staleness
    if (Date.now() - content.timestamp > STALE_LOCK_MAX_AGE) {
      return true;
    }

    // Check if PID is still alive
    try {
      process.kill(content.pid, 0);
    } catch {
      // PID is dead — lock is stale
      return true;
    }

    // PID exists — check startTime to detect PID reuse
    if (content.startTime) {
      const currentStartTime = getProcessStartTime();
      if (Math.abs(currentStartTime - content.startTime) > 5000) {
        // Different process with reused PID — lock is stale
        return true;
      }
    }

    // Lock is held by a valid process
    return false;
  }

  private getLockPath(): string {
    return path.join(this.installRoot, ".strada-update.lock");
  }

  acquireLock(): boolean {
    const lockPath = this.getLockPath();

    // Atomic write attempt first — eliminates TOCTOU race
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now(), startTime: getProcessStartTime() }),
        { encoding: "utf-8", flag: "wx" },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return false;
      }
    }

    // Lock exists — check if it's stale
    try {
      const content: LockContent = JSON.parse(
        fs.readFileSync(lockPath, "utf-8"),
      ) as LockContent;

      if (this.isLockStale(content)) {
        fs.unlinkSync(lockPath);
      } else {
        return false;
      }
    } catch {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Lock file unreadable and undeletable
        return false;
      }
    }

    // Retry after removing stale lock
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, timestamp: Date.now(), startTime: getProcessStartTime() }),
        { encoding: "utf-8", flag: "wx" },
      );
      return true;
    } catch {
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

      try {
        const success = await this.performUpdate();
        if (!success) {
          this.startIdleMonitoring();
          return;
        }
        if (success && this.config.notify && this.notifyFn) {
          if (this.config.autoRestart && this.isDaemonProcess()) {
            this.notifyFn(
              `Updated to ${this.pendingVersion}. Restarting...`,
            );
            // Send SIGTERM to self so setupShutdownHandlers triggers graceful
            // shutdown (DB flush, connection close, etc.) before exit.
            // The daemon wrapper will detect the clean exit and restart.
            const restartDelay = this.config.autoRestartDelayMs ?? 2000;
            setTimeout(() => process.kill(process.pid, "SIGTERM"), restartDelay);
          } else {
            this.notifyFn(
              `Updated to ${this.pendingVersion}. Please restart with \`strada start\`${!this.isDaemonProcess() ? " (auto-restart requires `strada daemon`)" : ""}.`,
            );
          }
        }
        this.clearPendingVersion();
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
    this.savePendingVersion();
  }
}
