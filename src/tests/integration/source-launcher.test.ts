import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

async function loadSourceLauncherModule() {
  return import(pathToFileURL(path.join(process.cwd(), "scripts", "source-launcher.mjs")).href);
}

describe("source launcher isServedPortalStale", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "strada-portal-stale-"));
    tempDirs.push(root);
    const portalSrcDir = path.join(root, "web-portal", "src");
    const servedDir = path.join(root, "dist", "channels", "web", "static");
    mkdirSync(portalSrcDir, { recursive: true });
    mkdirSync(servedDir, { recursive: true });
    return { portalSrcDir, servedMarker: path.join(servedDir, "index.html") };
  }

  // Force a deterministic mtime so the test does not depend on filesystem
  // timestamp granularity.
  const stamp = (file: string, offsetMs: number) => {
    const when = new Date(Date.now() + offsetMs);
    utimesSync(file, when, when);
  };

  it("is stale when portal source is newer than the served bundle", async () => {
    const { portalSrcDir, servedMarker } = makeFixture();
    const { isServedPortalStale } = await loadSourceLauncherModule();
    writeFileSync(servedMarker, "<html></html>");
    stamp(servedMarker, -10_000);
    const srcFile = path.join(portalSrcDir, "App.tsx");
    writeFileSync(srcFile, "export const App = 1;");
    stamp(srcFile, 10_000);
    expect(isServedPortalStale({ portalSrcDir, servedMarker, env: {} })).toBe(true);
  });

  it("is fresh when the served bundle is newer than all portal source", async () => {
    const { portalSrcDir, servedMarker } = makeFixture();
    const { isServedPortalStale } = await loadSourceLauncherModule();
    const srcFile = path.join(portalSrcDir, "App.tsx");
    writeFileSync(srcFile, "export const App = 1;");
    stamp(srcFile, -10_000);
    writeFileSync(servedMarker, "<html></html>");
    stamp(servedMarker, 10_000);
    expect(isServedPortalStale({ portalSrcDir, servedMarker, env: {} })).toBe(false);
  });

  it("treats a missing served bundle as stale", async () => {
    const { portalSrcDir, servedMarker } = makeFixture();
    const { isServedPortalStale } = await loadSourceLauncherModule();
    writeFileSync(path.join(portalSrcDir, "App.tsx"), "x");
    rmSync(servedMarker, { force: true });
    expect(isServedPortalStale({ portalSrcDir, servedMarker, env: {} })).toBe(true);
  });

  it("is never stale for a packaged install with no portal source dir", async () => {
    const { servedMarker } = makeFixture();
    const { isServedPortalStale } = await loadSourceLauncherModule();
    writeFileSync(servedMarker, "<html></html>");
    const missingSrc = path.join(os.tmpdir(), "strada-no-portal-src-does-not-exist-xyz");
    expect(isServedPortalStale({ portalSrcDir: missingSrc, servedMarker, env: {} })).toBe(false);
  });

  it("respects the STRADA_SKIP_STALE_REBUILD opt-out even when stale", async () => {
    const { portalSrcDir, servedMarker } = makeFixture();
    const { isServedPortalStale } = await loadSourceLauncherModule();
    writeFileSync(servedMarker, "<html></html>");
    stamp(servedMarker, -10_000);
    const srcFile = path.join(portalSrcDir, "App.tsx");
    writeFileSync(srcFile, "x");
    stamp(srcFile, 10_000);
    expect(
      isServedPortalStale({ portalSrcDir, servedMarker, env: { STRADA_SKIP_STALE_REBUILD: "1" } }),
    ).toBe(false);
  });
});

describe("source launcher install-command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      // Retries: Windows can hold a just-exited node.exe copy open for a moment.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
    tempDirs.length = 0;
  });

  it("installs user-local wrappers and updates the detected zsh profile idempotently", () => {
    if (process.platform === "win32") return;
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada launcher home "));
    const tempBin = path.join(tempHome, ".local", "bin");
    const outsideCwd = path.join(tempHome, "outside");
    const env = {
      ...process.env,
      HOME: tempHome,
      XDG_BIN_HOME: tempBin,
      SHELL: "/bin/zsh",
    };

    tempDirs.push(tempHome);

    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, "strada");
    rmSync(outsideCwd, { recursive: true, force: true });
    mkdirSync(outsideCwd, { recursive: true });

    const firstRun = execFileSync(scriptPath, ["install-command"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });

    expect(firstRun).toContain("Installed user-local Strada commands:");
    expect(firstRun).toContain("Updated shell profile:");
    expect(firstRun).toContain("without changing directories");
    expect(firstRun).toContain(`${scriptPath} setup`);
    expect(firstRun).toContain(`${scriptPath} doctor`);
    expect(existsSync(path.join(tempBin, "strada"))).toBe(true);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(true);

    const zshrcPath = path.join(tempHome, ".zshrc");
    expect(existsSync(zshrcPath)).toBe(true);

    const firstProfile = readFileSync(zshrcPath, "utf8");
    expect(firstProfile).toContain("# >>> Strada command >>>");
    expect(firstProfile).toContain(`export PATH="${tempBin}:$PATH"`);

    const secondRun = execFileSync(scriptPath, ["install-command"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });
    expect(secondRun).toContain("Shell profile already contains the Strada PATH entry:");

    const secondProfile = readFileSync(zshrcPath, "utf8");
    expect(secondProfile.match(/# >>> Strada command >>>/g)?.length ?? 0).toBe(1);

    const helpOutput = execFileSync(path.join(tempBin, "strada"), ["--help"], {
      cwd: outsideCwd,
      env: {
        ...env,
        PATH: `${tempBin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    expect(helpOutput).toContain("Usage: strada");
    expect(helpOutput).toContain("--web");
    expect(helpOutput).toContain("--terminal");
  });

  it("generates Windows launchers in %LOCALAPPDATA%\\\\Strada\\\\bin and keeps PATH updates idempotent", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada windows launcher "));
    const localAppData = path.join(tempHome, "AppData", "Local");
    const installDir = path.join(localAppData, "Strada", "bin");
    tempDirs.push(tempHome);

    const { installCommand, mergeWindowsUserPath } = await loadSourceLauncherModule();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pathSync = vi.fn()
      .mockReturnValueOnce({ updated: true, path: installDir })
      .mockReturnValueOnce({ updated: false, path: installDir });

    try {
      installCommand({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: "" },
        homeDir: tempHome,
        launcherPath: "C:\\Repo\\Strada.Brain\\strada.ps1",
        windowsPathSync: pathSync,
      });
      installCommand({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: installDir },
        homeDir: tempHome,
        launcherPath: "C:\\Repo\\Strada.Brain\\strada.ps1",
        windowsPathSync: pathSync,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(existsSync(path.join(installDir, "strada.cmd"))).toBe(true);
    expect(existsSync(path.join(installDir, "strada.ps1"))).toBe(true);
    expect(readFileSync(path.join(installDir, "strada.cmd"), "utf8")).toContain(path.join("scripts", "source-launcher.mjs"));
    expect(readFileSync(path.join(installDir, "strada.ps1"), "utf8")).toContain(path.join("scripts", "source-launcher.mjs"));
    expect(pathSync).toHaveBeenCalledTimes(2);
    expect(mergeWindowsUserPath("", installDir)).toEqual({
      updated: true,
      path: installDir,
    });
    expect(mergeWindowsUserPath(`${installDir};C:\\Tools`, installDir)).toEqual({
      updated: false,
      path: `${installDir};C:\\Tools`,
    });
  });

  // OPS-13. The wrappers used to be executed inside the test above behind a bare
  // `catch {}`, and `execFileSync` of a `.cmd` without a shell always throws
  // EINVAL on Node 22+ (CVE-2024-27980), so the Windows job never ran a launcher
  // and OPS-2 shipped. Both wrappers now run for real, and any failure fails the
  // test, with STRADA_NODE_PATH in a directory containing a space (the shape of
  // the default C:\Program Files\nodejs install).
  it.runIf(process.platform === "win32")("runs the generated Windows wrappers with a Node path containing a space", async () => {
    expect(existsSync(path.join(process.cwd(), "node_modules")), "run `npm ci` before this test").toBe(true);
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada windows run "));
    tempDirs.push(tempHome);
    const localAppData = path.join(tempHome, "AppData", "Local");
    const installDir = path.join(localAppData, "Strada", "bin");

    const { installCommand } = await loadSourceLauncherModule();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      installCommand({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: "" },
        homeDir: tempHome,
        launcherPath: path.join(process.cwd(), "strada.ps1"),
        windowsPathSync: vi.fn().mockReturnValue({ updated: false, path: installDir }),
      });
    } finally {
      consoleSpy.mockRestore();
    }

    // A Node install laid out like the official one (node.exe, npm.cmd and
    // node_modules/npm side by side), under a directory with a space.
    const realNodeDir = path.dirname(process.execPath);
    const realNpm = path.join(realNodeDir, "node_modules", "npm");
    expect(existsSync(realNpm), `no npm next to ${process.execPath}`).toBe(true);
    const spacedNodeDir = path.join(tempHome, "Program Files", "nodejs");
    mkdirSync(spacedNodeDir, { recursive: true });
    copyFileSync(process.execPath, path.join(spacedNodeDir, "node.exe"));
    copyFileSync(path.join(realNodeDir, "npm.cmd"), path.join(spacedNodeDir, "npm.cmd"));
    cpSync(realNpm, path.join(spacedNodeDir, "node_modules", "npm"), { recursive: true });

    const run = {
      cwd: process.cwd(),
      env: { ...process.env, LOCALAPPDATA: localAppData, STRADA_NODE_PATH: path.join(spacedNodeDir, "node.exe") },
      encoding: "utf8" as const,
      timeout: 120_000,
    };
    // A .cmd needs cmd.exe, and this path has spaces, so it is quoted for cmd.
    const cmdHelp = execFileSync(`"${path.join(installDir, "strada.cmd")}"`, ["--help"], { ...run, shell: true });
    expect(cmdHelp).toContain("Usage: strada");
    const psHelp = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(installDir, "strada.ps1"), "--help"],
      run,
    );
    expect(psHelp).toContain("Usage: strada");
  }, 300_000);

  it("refreshes existing POSIX user-local wrappers without reinstalling shell profile state", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada launcher refresh "));
    const tempBin = path.join(tempHome, ".local", "bin");
    tempDirs.push(tempHome);

    mkdirSync(tempBin, { recursive: true });
    writeFileSync(path.join(tempBin, "strada"), "#!/bin/sh\necho stale\n", "utf8");
    writeFileSync(path.join(tempBin, "strada-brain"), "#!/bin/sh\necho stale\n", "utf8");

    const { refreshInstalledCommandBindings } = await loadSourceLauncherModule();
    const refreshed = refreshInstalledCommandBindings({
      platform: "linux",
      env: {
        HOME: tempHome,
        XDG_BIN_HOME: tempBin,
      },
      homeDir: tempHome,
      installDir: tempBin,
      launcherPath: path.join(tempBin, "strada"),
    });

    expect(refreshed).toBe(true);
    expect(readFileSync(path.join(tempBin, "strada"), "utf8")).toContain(path.join("scripts", "source-launcher.mjs"));
    expect(readFileSync(path.join(tempBin, "strada-brain"), "utf8")).toContain(path.join("scripts", "source-launcher.mjs"));
    expect(existsSync(path.join(tempHome, ".zshrc"))).toBe(false);
  });

  it("skips wrapper refresh when the current launcher is repo-local", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada launcher no-refresh "));
    const tempBin = path.join(tempHome, ".local", "bin");
    tempDirs.push(tempHome);

    const { refreshInstalledCommandBindings } = await loadSourceLauncherModule();
    const refreshed = refreshInstalledCommandBindings({
      env: {
        ...process.env,
        HOME: tempHome,
        XDG_BIN_HOME: tempBin,
      },
      homeDir: tempHome,
      launcherPath: path.join(process.cwd(), "strada"),
    });

    expect(refreshed).toBe(false);
    expect(existsSync(path.join(tempBin, "strada"))).toBe(false);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(false);
  });

  it("refreshes existing Windows user-local wrappers without rerunning PATH setup", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada windows refresh "));
    const localAppData = path.join(tempHome, "AppData", "Local");
    const installDir = path.join(localAppData, "Strada", "bin");
    tempDirs.push(tempHome);

    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, "strada.cmd"), "@echo off\r\necho stale\r\n", "utf8");
    writeFileSync(path.join(installDir, "strada.ps1"), "Write-Host 'stale'\n", "utf8");

    const { refreshInstalledCommandBindings } = await loadSourceLauncherModule();
    const refreshed = refreshInstalledCommandBindings({
      platform: "win32",
      env: {
        LOCALAPPDATA: localAppData,
        PATH: "",
      },
      homeDir: tempHome,
      launcherPath: path.join(installDir, "strada.ps1"),
    });

    expect(refreshed).toBe(true);
    expect(readFileSync(path.join(installDir, "strada.cmd"), "utf8")).toContain(path.join("scripts", "source-launcher.mjs"));
    expect(readFileSync(path.join(installDir, "strada.ps1"), "utf8")).toContain(path.join("scripts", "source-launcher.mjs"));
  });

  it("runs repo CLI commands from source and only prepares web launches", async () => {
    const { requiresPreparedSourceCheckout, shouldRunFromSource } = await loadSourceLauncherModule();

    expect(shouldRunFromSource(["cli"])).toBe(true);
    expect(shouldRunFromSource(["start", "--channel", "cli"])).toBe(true);
    expect(shouldRunFromSource(["doctor"])).toBe(true);
    expect(shouldRunFromSource(["update"])).toBe(true);
    expect(shouldRunFromSource(["version-info"])).toBe(true);
    expect(shouldRunFromSource(["kill"])).toBe(true);
    expect(shouldRunFromSource(["stop"])).toBe(true);
    expect(shouldRunFromSource(["restart"])).toBe(true);
    expect(shouldRunFromSource(["status"])).toBe(true);

    expect(requiresPreparedSourceCheckout([])).toBe(true);
    expect(requiresPreparedSourceCheckout(["setup", "--web"])).toBe(true);
    expect(requiresPreparedSourceCheckout(["--web"])).toBe(true);
    expect(requiresPreparedSourceCheckout(["start"])).toBe(true);
    expect(requiresPreparedSourceCheckout(["start", "--channel", "web"])).toBe(true);

    expect(requiresPreparedSourceCheckout(["setup", "--terminal"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["doctor"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["update"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["version-info"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["kill"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["stop"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["restart"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["status"])).toBe(false);
    expect(requiresPreparedSourceCheckout(["start", "--channel", "cli"])).toBe(false);
  });

  it("uninstalls POSIX wrappers, removes managed profile files, and resets a source checkout with --purge-config", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada launcher uninstall "));
    const tempBin = path.join(tempHome, ".local", "bin");
    const tempRepo = mkdtempSync(path.join(os.tmpdir(), "strada repo uninstall "));
    const externalLog = path.join(tempHome, "external-strada.log");
    tempDirs.push(tempHome, tempRepo);

    const env = {
      ...process.env,
      HOME: tempHome,
      XDG_BIN_HOME: tempBin,
      SHELL: "/bin/zsh",
    };

    const { installCommand, uninstallCommand } = await loadSourceLauncherModule();
    installCommand({
      env,
      homeDir: tempHome,
      launcherPath: path.join(process.cwd(), "strada"),
    });

    mkdirSync(path.join(tempRepo, ".strada-memory"), { recursive: true });
    mkdirSync(path.join(tempRepo, ".whatsapp-session"), { recursive: true });
    mkdirSync(path.join(tempRepo, "data"), { recursive: true });
    mkdirSync(path.join(tempRepo, "node_modules"), { recursive: true });
    mkdirSync(path.join(tempRepo, "dist"), { recursive: true });
    mkdirSync(path.join(tempRepo, "web-portal", "node_modules"), { recursive: true });
    mkdirSync(path.join(tempRepo, "web-portal", "dist"), { recursive: true });
    writeFileSync(path.join(tempRepo, ".env"), [
      "MEMORY_DB_PATH=.strada-memory",
      "WHATSAPP_SESSION_PATH=.whatsapp-session",
      `LOG_FILE=${externalLog}`,
      "DAEMON_HEARTBEAT_FILE=./HEARTBEAT.md",
    ].join("\n"));
    writeFileSync(path.join(tempRepo, "strada-brain-error.log"), "error\n", "utf8");
    writeFileSync(path.join(tempRepo, "strada-brain-sync.log"), "sync\n", "utf8");
    writeFileSync(path.join(tempRepo, "HEARTBEAT.md"), "# test\n", "utf8");
    writeFileSync(path.join(tempRepo, "data", "tasks.db"), "sqlite\n", "utf8");
    writeFileSync(path.join(tempRepo, "data", "learning.db"), "sqlite\n", "utf8");
    writeFileSync(path.join(tempRepo, "dist", "index.js"), "built\n", "utf8");
    writeFileSync(path.join(tempRepo, "web-portal", "dist", "index.html"), "<html></html>\n", "utf8");
    writeFileSync(externalLog, "external\n", "utf8");
    tempDirs.push(externalLog);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      uninstallCommand({
        env,
        homeDir: tempHome,
        rootDir: tempRepo,
        sourceCheckout: true,
        purgeConfig: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(existsSync(path.join(tempBin, "strada"))).toBe(false);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(false);
    expect(existsSync(path.join(tempHome, ".zshrc"))).toBe(false);
    expect(existsSync(path.join(tempRepo, ".env"))).toBe(false);
    expect(existsSync(path.join(tempRepo, ".strada-memory"))).toBe(false);
    expect(existsSync(path.join(tempRepo, ".whatsapp-session"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "HEARTBEAT.md"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "strada-brain-error.log"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "strada-brain-sync.log"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "data", "tasks.db"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "data", "learning.db"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "data"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "node_modules"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "dist"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "web-portal", "node_modules"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "web-portal", "dist"))).toBe(false);
    expect(existsSync(externalLog)).toBe(true);
  });

  it("purges packaged runtime state from STRADA_HOME instead of assuming the install root", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada packaged uninstall "));
    const tempBin = path.join(tempHome, ".local", "bin");
    const tempInstallRoot = mkdtempSync(path.join(os.tmpdir(), "strada packaged install "));
    const tempRuntimeRoot = path.join(tempHome, ".portable-strada");
    tempDirs.push(tempHome, tempInstallRoot);

    const env = {
      ...process.env,
      HOME: tempHome,
      XDG_BIN_HOME: tempBin,
      SHELL: "/bin/zsh",
      STRADA_HOME: tempRuntimeRoot,
    };

    const { installCommand, uninstallCommand } = await loadSourceLauncherModule();
    installCommand({
      env,
      homeDir: tempHome,
      launcherPath: path.join(process.cwd(), "strada"),
    });

    mkdirSync(path.join(tempRuntimeRoot, ".strada-memory"), { recursive: true });
    writeFileSync(path.join(tempRuntimeRoot, ".env"), "MEMORY_DB_PATH=.strada-memory\n", "utf8");
    writeFileSync(path.join(tempRuntimeRoot, "strada-brain-sync.log"), "sync\n", "utf8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      uninstallCommand({
        env,
        homeDir: tempHome,
        rootDir: tempInstallRoot,
        sourceCheckout: false,
        purgeConfig: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(existsSync(path.join(tempBin, "strada"))).toBe(false);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(false);
    expect(existsSync(path.join(tempHome, ".zshrc"))).toBe(false);
    expect(existsSync(tempRuntimeRoot)).toBe(false);
  });

  it("resolves relative STRADA_HOME against the original launch cwd during uninstall", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada relative home uninstall "));
    const tempBin = path.join(tempHome, ".local", "bin");
    const tempInstallRoot = mkdtempSync(path.join(os.tmpdir(), "strada relative home install "));
    const tempLaunchCwd = mkdtempSync(path.join(os.tmpdir(), "strada relative home launch "));
    const relativeRuntimeRoot = "portable-strada-home";
    const tempRuntimeRoot = path.join(tempLaunchCwd, relativeRuntimeRoot);
    tempDirs.push(tempHome, tempInstallRoot, tempLaunchCwd);

    const env = {
      ...process.env,
      HOME: tempHome,
      XDG_BIN_HOME: tempBin,
      SHELL: "/bin/zsh",
      STRADA_HOME: relativeRuntimeRoot,
      STRADA_LAUNCH_CWD: tempLaunchCwd,
    };

    const { installCommand, uninstallCommand } = await loadSourceLauncherModule();
    installCommand({
      env,
      homeDir: tempHome,
      launcherPath: path.join(process.cwd(), "strada"),
    });

    mkdirSync(tempRuntimeRoot, { recursive: true });
    mkdirSync(path.join(tempRuntimeRoot, ".strada-memory"), { recursive: true });
    writeFileSync(path.join(tempRuntimeRoot, ".env"), "MEMORY_DB_PATH=.strada-memory\n", "utf8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      uninstallCommand({
        env,
        homeDir: tempHome,
        rootDir: tempInstallRoot,
        sourceCheckout: false,
        purgeConfig: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(existsSync(path.join(tempBin, "strada"))).toBe(false);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(false);
    expect(existsSync(tempRuntimeRoot)).toBe(false);
    expect(existsSync(path.join(tempHome, relativeRuntimeRoot))).toBe(false);
  });

  it("uninstalls Windows wrappers and removes the install dir from the user PATH", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada windows uninstall "));
    const localAppData = path.join(tempHome, "AppData", "Local");
    const installDir = path.join(localAppData, "Strada", "bin");
    tempDirs.push(tempHome);

    const { installCommand, uninstallCommand, removeWindowsUserPath } = await loadSourceLauncherModule();
    const pathSync = vi.fn().mockReturnValue({ updated: true, path: installDir });
    installCommand({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, PATH: "" },
      homeDir: tempHome,
      launcherPath: "C:\\Repo\\Strada.Brain\\strada.ps1",
      windowsPathSync: pathSync,
    });

    const pathRemoveSync = vi.fn().mockReturnValue({ updated: true, path: "" });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      uninstallCommand({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: installDir },
        homeDir: tempHome,
        windowsPathRemoveSync: pathRemoveSync,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(existsSync(path.join(installDir, "strada.cmd"))).toBe(false);
    expect(existsSync(path.join(installDir, "strada.ps1"))).toBe(false);
    expect(pathRemoveSync).toHaveBeenCalledWith(installDir);
    expect(removeWindowsUserPath(`${installDir};C:\\Tools`, installDir)).toEqual({
      updated: true,
      path: "C:\\Tools",
    });
  });

  it("schedules deletion of the active Windows launcher when uninstall runs through the bare command", async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada windows active uninstall "));
    const localAppData = path.join(tempHome, "AppData", "Local");
    const installDir = path.join(localAppData, "Strada", "bin");
    tempDirs.push(tempHome);

    const { installCommand, uninstallCommand } = await loadSourceLauncherModule();
    installCommand({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, PATH: "" },
      homeDir: tempHome,
      launcherPath: "C:\\Repo\\Strada.Brain\\strada.ps1",
      windowsPathSync: vi.fn().mockReturnValue({ updated: true, path: installDir }),
    });

    const deferredDelete = vi.fn((targets: string[], directory: string) => {
      for (const target of targets) {
        rmSync(target, { force: true });
      }
      rmSync(directory, { recursive: true, force: true });
      return true;
    });
    const pathRemoveSync = vi.fn().mockReturnValue({ updated: true, path: "" });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      uninstallCommand({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: installDir },
        homeDir: tempHome,
        launcherPath: path.join(installDir, "strada.cmd"),
        windowsPathRemoveSync: pathRemoveSync,
        windowsDeferredDelete: deferredDelete,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(deferredDelete).toHaveBeenCalledWith([path.join(installDir, "strada.cmd")], installDir);
    expect(pathRemoveSync).toHaveBeenCalledWith(installDir);
    expect(existsSync(path.join(installDir, "strada.cmd"))).toBe(false);
    expect(existsSync(path.join(installDir, "strada.ps1"))).toBe(false);
    expect(existsSync(installDir)).toBe(false);
  });
});

/**
 * Codex round 13 #35. `STRADA_SOURCE_CHECKOUT` was two-state in one direction
 * here too: "true" forced a source checkout and anything else probed for `.git`,
 * so an explicit `false` did nothing — and the source branch then handed the
 * child `"true"` regardless. An operator who had said "runtime state lives in
 * the app home" could point `uninstall --purge-config` at their checkout.
 */
describe("the launcher reads STRADA_SOURCE_CHECKOUT in three states (round 13 #35)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  it("false moves the config root to the app home even inside a checkout", async () => {
    const { resolveRuntimeRoots } = await loadSourceLauncherModule();
    // The app home is per platform, so the platform is pinned (unpinned, this
    // read the host's and failed on the Windows CI runner).
    const inCheckout = { rootDir: process.cwd(), homeDir: "/Users/tester", cwd: "/Users/tester/.strada", platform: "darwin" };
    const off = resolveRuntimeRoots({ ...inCheckout, env: { STRADA_SOURCE_CHECKOUT: "false" } });
    expect(off.sourceCheckout).toBe(false);
    expect(off.configRoot).toBe(path.join("/Users/tester", ".strada"));
    // On Windows the app home is %LOCALAPPDATA%\Strada, as the README and runtime-paths.ts say.
    const offOnWindows = resolveRuntimeRoots({
      ...inCheckout,
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: { STRADA_SOURCE_CHECKOUT: "false", LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    });
    expect(offOnWindows.sourceCheckout).toBe(false);
    expect(offOnWindows.configRoot).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "Strada"));
    // true still forces it, and the other spellings are read as well.
    for (const yes of ["true", "1", "YES"]) {
      expect(resolveRuntimeRoots({ ...inCheckout, env: { STRADA_SOURCE_CHECKOUT: yes } }).sourceCheckout, yes).toBe(true);
    }
    for (const no of ["0", " No "]) {
      expect(resolveRuntimeRoots({ ...inCheckout, env: { STRADA_SOURCE_CHECKOUT: no } }).sourceCheckout, no).toBe(false);
    }
    // Saying nothing (unset, empty, unreadable) still probes for .git.
    for (const quiet of [undefined, "", "maybe"]) {
      const env = quiet === undefined ? {} : { STRADA_SOURCE_CHECKOUT: quiet };
      expect(resolveRuntimeRoots({ ...inCheckout, env }).sourceCheckout, String(quiet)).toBe(true);
    }
  });

  // Both platforms on every host: the app home is `~/.strada` on macOS/Linux
  // and `%LOCALAPPDATA%\Strada` on Windows. Unpinned, this used the HOST's and
  // looked for the app home in the wrong place on the Windows CI runner.
  for (const platform of ["darwin", "win32"] as const) {
    it(`purge-config with an explicit false leaves the checkout alone and clears the app home (${platform})`, async () => {
      const { uninstallCommand: uninstall } = await loadSourceLauncherModule();
      const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-launcher-home-"));
      const tempRepo = mkdtempSync(path.join(os.tmpdir(), "strada-launcher-repo-"));
      tempDirs.push(tempHome, tempRepo);
      const localAppData = path.join(tempHome, "AppData", "Local");
      const appHome = platform === "win32" ? path.join(localAppData, "Strada") : path.join(tempHome, ".strada");
      mkdirSync(appHome, { recursive: true });
      mkdirSync(path.join(tempRepo, ".git"), { recursive: true });
      // The operator's real configuration, and a checkout that must not be touched.
      writeFileSync(path.join(appHome, ".env"), "KIMI_API_KEY=k\n", "utf8");
      writeFileSync(path.join(tempRepo, ".env"), "DEVELOPER=me\n", "utf8");

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        uninstall({
          platform,
          env: { STRADA_SOURCE_CHECKOUT: "false", HOME: tempHome, LOCALAPPDATA: localAppData },
          homeDir: tempHome,
          rootDir: tempRepo,
          purgeConfig: true,
          // Never the real user PATH or a real deferred delete from a test.
          windowsPathRemoveSync: vi.fn().mockReturnValue({ updated: false, path: "" }),
          windowsDeferredDelete: vi.fn().mockReturnValue(true),
        });
      } finally {
        consoleSpy.mockRestore();
      }

      expect(existsSync(path.join(appHome, ".env"))).toBe(false);
      // The developer's own checkout configuration is none of its business.
      expect(existsSync(path.join(tempRepo, ".env"))).toBe(true);
    });
  }
});

describe("the flag the source child inherits (round 13 #35)", () => {
  it("keeps an explicit false instead of forcing true", async () => {
    const { sourceCheckoutFlagForChild } = await loadSourceLauncherModule();
    expect(sourceCheckoutFlagForChild({ STRADA_SOURCE_CHECKOUT: "false" })).toBe("false");
    expect(sourceCheckoutFlagForChild({ STRADA_SOURCE_CHECKOUT: "0" })).toBe("false");
    // Running from source is still the default answer for everyone else.
    expect(sourceCheckoutFlagForChild({})).toBe("true");
    expect(sourceCheckoutFlagForChild({ STRADA_SOURCE_CHECKOUT: "true" })).toBe("true");
    expect(sourceCheckoutFlagForChild({ STRADA_SOURCE_CHECKOUT: "maybe" })).toBe("true");
  });
});

/**
 * OPS-25. The launcher ran the app through spawnSync and handled no signals, so
 * `kill <launcher pid>` ended the launcher alone and orphaned the daemon. These
 * run the real launcher from a throwaway root whose src/index.ts is a stand-in
 * app that reports every signal it gets.
 *
 * POSIX only: Windows has no catchable SIGTERM (process.kill() there is
 * TerminateProcess), and its console sends Ctrl+C/Ctrl+Break to the whole
 * process group, so there is nothing for the launcher to forward.
 */
describe.skipIf(process.platform === "win32")("source launcher signal handling (OPS-25)", () => {
  let fixtureRoot = "";
  const running: Array<{ launcher: ChildProcess; childPid: number | null }> = [];

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "strada-launcher-signals-"));
    mkdirSync(path.join(fixtureRoot, "scripts"));
    mkdirSync(path.join(fixtureRoot, "src"));
    copyFileSync(
      path.join(process.cwd(), "scripts", "source-launcher.mjs"),
      path.join(fixtureRoot, "scripts", "source-launcher.mjs"),
    );
    writeFileSync(path.join(fixtureRoot, "package.json"), '{"name":"launcher-signal-fixture","private":true}\n');
    // `--import tsx` resolves from the launcher's root.
    symlinkSync(path.join(process.cwd(), "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
    writeFileSync(path.join(fixtureRoot, "src", "index.ts"), [
      "const say = (line: string): void => { process.stdout.write(`${line}\\n`); };",
      "for (const signal of [\"SIGINT\", \"SIGHUP\"] as const) process.on(signal, () => say(`child got ${signal}`));",
      "process.on(\"SIGTERM\", () => { say(\"child got SIGTERM\"); process.exit(7); });",
      "setInterval(() => undefined, 60_000);",
      "say(`child ready ${process.pid}`);",
      "",
    ].join("\n"));
  });

  afterEach(() => {
    for (const { launcher, childPid } of running.splice(0)) {
      // Whatever a failing run left behind, including an orphaned child.
      for (const pid of [childPid, launcher.pid]) {
        if (pid === null || pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function startLauncher() {
    const launcher = spawn(process.execPath, [path.join(fixtureRoot, "scripts", "source-launcher.mjs"), "cli"], {
      cwd: fixtureRoot,
      env: { ...process.env, STRADA_SKIP_STALE_REBUILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const run = { launcher, childPid: null as number | null };
    running.push(run);
    let output = "";
    launcher.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    launcher.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      launcher.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 45_000;
    while (!/child ready (\d+)/.test(output)) {
      if (launcher.exitCode !== null || launcher.signalCode !== null || Date.now() > deadline) {
        throw new Error(`the stand-in app never started:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    run.childPid = Number(/child ready (\d+)/.exec(output)?.[1]);
    return { launcher, childPid: run.childPid, exited, output: () => output };
  }

  it("forwards SIGTERM to the app and exits with the app's code", async () => {
    const { launcher, childPid, exited, output } = await startLauncher();
    launcher.kill("SIGTERM");
    // Was: the launcher died of the signal (code null) and the app kept running.
    expect(await exited).toEqual({ code: 7, signal: null });
    expect(output()).toContain("child got SIGTERM");
    expect(isAlive(childPid)).toBe(false);
  }, 60_000);

  for (const signal of ["SIGINT", "SIGHUP"] as const) {
    it(`does not forward ${signal} (the terminal already sent it to the app) and waits for the app to exit`, async () => {
      const { launcher, childPid, exited, output } = await startLauncher();
      launcher.kill(signal);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      // Was: the launcher exited at once, while the app was still shutting down.
      expect(launcher.exitCode).toBeNull();
      expect(launcher.signalCode).toBeNull();
      expect(output()).not.toContain(`child got ${signal}`);
      // The app finishing its shutdown is what ends the launcher.
      process.kill(childPid, "SIGTERM");
      expect(await exited).toEqual({ code: 7, signal: null });
    }, 60_000);
  }

  it("dies of the same signal as the app", async () => {
    const { childPid, exited } = await startLauncher();
    process.kill(childPid, "SIGKILL");
    // Was: exit code 1, which hid that the app had been killed.
    expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
  }, 60_000);
});

describe("Windows .cmd launchers (OPS-17)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function generatedCmdWrapper(): Promise<string> {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-cmd-wrapper-"));
    tempDirs.push(tempHome);
    const localAppData = path.join(tempHome, "AppData", "Local");
    const { installCommand } = await loadSourceLauncherModule();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      installCommand({
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: "" },
        homeDir: tempHome,
        launcherPath: "C:\\Repo\\Strada.Brain\\strada.ps1",
        windowsPathSync: vi.fn().mockReturnValue({ updated: false, path: "" }),
      });
    } finally {
      consoleSpy.mockRestore();
    }
    return readFileSync(path.join(localAppData, "Strada", "bin", "strada.cmd"), "utf8");
  }

  const sources = async () => [
    ["strada.cmd", readFileSync(path.join(process.cwd(), "strada.cmd"), "utf8")],
    ["generated strada.cmd", await generatedCmdWrapper()],
  ] as const;

  it("do not enable delayed expansion (it strips every ! from arguments and paths)", async () => {
    for (const [name, source] of await sources()) {
      const code = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("::")).join("\n");
      expect(code, name).not.toMatch(/EnableDelayedExpansion/i);
      // Nothing may rely on it either.
      expect(code, name).not.toMatch(/![A-Za-z_]\w*!/);
    }
  });

  it("never put the launch directory on PATH for a bare `node` found on PATH", async () => {
    for (const [name, source] of await sources()) {
      const lines = source.split(/\r?\n/);
      const skip = lines.findIndex((line) => /^if \/i "%NODE_EXE%"=="node" goto :\S+$/.test(line));
      const prepend = lines.findIndex((line) => /set "PATH=%N(?:ODE_)?DIR%;%PATH%"/.test(line));
      expect(skip, `${name}: no bare-node guard`).toBeGreaterThan(-1);
      expect(prepend, `${name}: no PATH prepend`).toBeGreaterThan(skip);
    }
  });
});

/**
 * OPS-17 (download path). The launchers fetched a portable Node and extracted it
 * unchecked, and the .cmd ones built PowerShell source out of %TEMP%: a quote
 * in it (user O'Brien) ended a single-quoted string. Everything below except
 * the win32-only tests runs anywhere; those two are the only real run of the
 * download code, and it happens on the windows-verify CI job.
 */
describe("Windows portable Node download (OPS-17)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  async function generatedWrappers(): Promise<{ cmd: string; ps1: string; ps1Path: string }> {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), "strada-download-wrapper-"));
    tempDirs.push(tempHome);
    const installDir = path.join(tempHome, "AppData", "Local", "Strada", "bin");
    const { installCommand } = await loadSourceLauncherModule();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      installCommand({
        platform: "win32",
        env: { LOCALAPPDATA: path.join(tempHome, "AppData", "Local"), PATH: "" },
        homeDir: tempHome,
        launcherPath: "C:\\Repo\\Strada.Brain\\strada.ps1",
        windowsPathSync: vi.fn().mockReturnValue({ updated: false, path: "" }),
      });
    } finally {
      consoleSpy.mockRestore();
    }
    return {
      cmd: readFileSync(path.join(installDir, "strada.cmd"), "utf8"),
      ps1: readFileSync(path.join(installDir, "strada.ps1"), "utf8"),
      ps1Path: path.join(installDir, "strada.ps1"),
    };
  }

  const readRepoFile = (name: string) => readFileSync(path.join(process.cwd(), name), "utf8");

  /**
   * Just enough of cmd.exe to follow the download branch: cmd expands %VAR%
   * (undefined: empty) when it READS a line, then runs its `&`-joined commands.
   * `set "N=V"` and `if "a"=="b" set ...` change the environment; the expanded
   * powershell.exe line is what PowerShell is handed.
   */
  function simulateCmdDownload(source: string, env: Record<string, string>) {
    const vars = new Map(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]));
    const lines = source.replace(/\^\r?\n/g, "").split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith('set "ARCH=x64"'));
    expect(start, "no download branch").toBeGreaterThan(-1);
    for (const raw of lines.slice(start)) {
      if (raw.trimStart().startsWith("::")) continue;
      const line = raw.replace(/%([A-Za-z_]\w*)%/g, (_match, name: string) => vars.get(name.toUpperCase()) ?? "");
      if (/^\s*powershell\.exe\s/i.test(line)) {
        return { vars, command: /-Command\s+"(.*)"\s*$/.exec(line)?.[1] ?? null };
      }
      for (const statement of line.split(" & ")) {
        const condition = /^\s*if "([^"]*)"=="([^"]*)" (.*)$/.exec(statement);
        const body = condition ? (condition[1] === condition[2] ? condition[3] ?? "" : "") : statement;
        const assignment = /^\s*set "([^=]+)=(.*)"\s*$/.exec(body);
        if (assignment?.[1] !== undefined) vars.set(assignment[1].toUpperCase(), assignment[2] ?? "");
      }
    }
    return { vars, command: null };
  }

  it("the .cmd launchers hand PowerShell a %TEMP% with a quote through its environment", async () => {
    const { CMD_NODE_DOWNLOAD_POWERSHELL } = await loadSourceLauncherModule();
    // Nothing in the PowerShell source is left for cmd to expand, and cmd has
    // no quote in it to unbalance.
    expect(CMD_NODE_DOWNLOAD_POWERSHELL).not.toMatch(/[%"]/);
    const env = {
      TEMP: "C:\\Users\\O'Brien\\AppData\\Local\\Temp",
      LOCALAPPDATA: "C:\\Users\\O'Brien\\AppData\\Local",
      PROCESSOR_ARCHITECTURE: "AMD64",
    };
    for (const [name, source] of [["strada.cmd", readRepoFile("strada.cmd")], ["generated strada.cmd", (await generatedWrappers()).cmd]]) {
      const { vars, command } = simulateCmdDownload(source, env);
      // Was: '%TD%\%ZN%' in the source, which became 'C:\Users\O'Brien\...'.
      expect(command, name).toBe(CMD_NODE_DOWNLOAD_POWERSHELL);
      expect(vars.get("STRADA_NODE_TMP"), name).toBe("C:\\Users\\O'Brien\\AppData\\Local\\Temp\\strada-node-install");
      // The generated wrapper set NV and used it on one line, so the zip name
      // had no version and the download could never succeed.
      expect(vars.get("STRADA_NODE_ZIP"), name).toBe("node-v22.18.0-win-x64.zip");
      expect(vars.get("STRADA_NODE_VERSION"), name).toBe("v22.18.0");
    }
  });

  it("every launcher extracts the portable Node only after checking it against the release's SHASUMS256.txt", async () => {
    const { CMD_NODE_DOWNLOAD_POWERSHELL } = await loadSourceLauncherModule();
    const generated = await generatedWrappers();
    const scripts = [
      ["strada.cmd / generated strada.cmd", CMD_NODE_DOWNLOAD_POWERSHELL],
      ["strada.ps1", readRepoFile("strada.ps1")],
      ["generated strada.ps1", generated.ps1],
    ] as const;
    for (const [name, source] of scripts) {
      const sums = source.search(/Invoke-WebRequest[^\n]*SHASUMS256\.txt/);
      const hash = source.search(/SHA256\]::Create\(\)\.ComputeHash\(/);
      const mismatch = source.search(/-ne \$expected\w*\)\s*\{\s*throw\b/);
      const extract = source.indexOf("Expand-Archive");
      expect(sums, `${name}: SHASUMS256.txt is never downloaded`).toBeGreaterThan(-1);
      expect(hash, `${name}: the zip is never hashed`).toBeGreaterThan(sums);
      expect(mismatch, `${name}: a mismatch does not stop the install`).toBeGreaterThan(hash);
      expect(extract, `${name}: extracted before it is checked`).toBeGreaterThan(mismatch);
      // A release with no line for this zip is refused too.
      expect(source, name).toMatch(/if\s*\(-not \$expected\w*\)\s*\{\s*throw\b/);
      // Get-FileHash is not available when Windows PowerShell 5.1 inherits a
      // PowerShell 7 PSModulePath (seen on the windows-verify runner).
      expect(source, name).not.toMatch(/Get-FileHash\s+-/);
    }
    // The checksum list is the one published with the zip's own release.
    for (const [name, source] of [["strada.ps1", readRepoFile("strada.ps1")], ["generated strada.ps1", generated.ps1]]) {
      const zipRelease = /https:\/\/nodejs\.org\/dist\/(\$\{?\w+\}?)\/\$\{?zip/i.exec(source)?.[1];
      const sumsRelease = /https:\/\/nodejs\.org\/dist\/(\$\{?\w+\}?)\/SHASUMS256\.txt/.exec(source)?.[1];
      expect(zipRelease, name).toBeDefined();
      expect(sumsRelease, name).toBe(zipRelease);
    }
    expect(CMD_NODE_DOWNLOAD_POWERSHELL).toContain("Invoke-WebRequest -Uri ($base+$zip)");
    expect(CMD_NODE_DOWNLOAD_POWERSHELL).toContain("Invoke-WebRequest -Uri ($base+'SHASUMS256.txt')");
  });

  // The real thing, with nodejs.org replaced by local fixtures and a temp
  // directory that has a quote and spaces in it.
  it.runIf(process.platform === "win32")("the .cmd download verifies the zip and refuses a mismatch (Windows)", async () => {
    const { CMD_NODE_DOWNLOAD_POWERSHELL } = await loadSourceLauncherModule();
    const root = mkdtempSync(path.join(os.tmpdir(), "strada o'brien "));
    tempDirs.push(root);
    const zipName = "node-v22.18.0-win-x64.zip";
    const dist = path.join(root, "dist");
    const payload = path.join(root, "payload", "node-v22.18.0-win-x64");
    mkdirSync(dist);
    mkdirSync(payload, { recursive: true });
    writeFileSync(path.join(payload, "node.exe"), "not really node\n");
    const powershell = (script: string, env: Record<string, string>) => execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 },
    );
    powershell(
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:STRADA_TEST_SRC -DestinationPath $env:STRADA_TEST_ZIP",
      { STRADA_TEST_SRC: payload, STRADA_TEST_ZIP: path.join(dist, zipName) },
    );
    const sha = createHash("sha256").update(readFileSync(path.join(dist, zipName))).digest("hex");
    // Serves the fixture named by the URL's last segment instead of nodejs.org.
    const offline = "function Invoke-WebRequest { param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing) Copy-Item -LiteralPath (Join-Path $env:STRADA_TEST_DIST ($Uri -split '/')[-1]) -Destination $OutFile }; ";
    const install = (sums: string) => {
      writeFileSync(path.join(dist, "SHASUMS256.txt"), sums);
      const work = mkdtempSync(path.join(root, "temp o'brien "));
      let ok = true;
      try {
        powershell(offline + CMD_NODE_DOWNLOAD_POWERSHELL, {
          STRADA_TEST_DIST: dist,
          STRADA_NODE_TMP: work,
          STRADA_NODE_ZIP: zipName,
          STRADA_NODE_VERSION: "v22.18.0",
        });
      } catch {
        ok = false;
      }
      return { ok, extracted: existsSync(path.join(work, "node-v22.18.0-win-x64", "node.exe")) };
    };
    const otherZip = `${"1".repeat(64)}  node-v22.18.0-win-arm64.zip\n`;
    expect(install(`${otherZip}${sha}  ${zipName}\n`)).toEqual({ ok: true, extracted: true });
    expect(install(`${otherZip}${"0".repeat(64)}  ${zipName}\n`)).toEqual({ ok: false, extracted: false });
    expect(install(otherZip)).toEqual({ ok: false, extracted: false });
  }, 300_000);

  it.runIf(process.platform === "win32")("strada.ps1 and the generated wrapper parse (Windows)", async () => {
    const { ps1Path } = await generatedWrappers();
    const parse = "$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:STRADA_TEST_PS1, [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }";
    for (const file of [path.join(process.cwd(), "strada.ps1"), ps1Path]) {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parse], {
        env: { ...process.env, STRADA_TEST_PS1: file },
        encoding: "utf8",
        timeout: 120_000,
      });
    }
  }, 300_000);
});

describe("source launcher npm invocation with a Node path containing a space (OPS-2)", () => {
  const PROGRAM_FILES_NODE = "C:\\Program Files\\nodejs\\node.exe";
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Node's `shell: true` joins file + args with plain spaces before handing
  // them to cmd.exe (`cmd /d /s /c "<line>"`), so this is the line cmd parses.
  const shellCommandLine = (command: string, args: string[]) => [command, ...args].join(" ");

  it("runs npm-cli.js with this Node binary and no shell when it sits next to node.exe", async () => {
    const { buildNpmSpawn } = await loadSourceLauncherModule();
    const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const [command, args, options] = buildNpmSpawn(["--version"], { stdio: "ignore" }, {
      platform: "win32",
      env: { STRADA_NODE_PATH: PROGRAM_FILES_NODE },
      execPath: PROGRAM_FILES_NODE,
      exists: (candidate: string) => candidate === npmCli,
    });
    expect(command).toBe(PROGRAM_FILES_NODE);
    expect(args).toEqual([npmCli, "--version"]);
    expect(options).toEqual({ stdio: "ignore" });
  });

  it("quotes the npm.cmd path for cmd.exe when only the .cmd stub is present", async () => {
    const { buildNpmSpawn } = await loadSourceLauncherModule();
    const npmCmd = "C:\\Program Files\\nodejs\\npm.cmd";
    const [command, args, options] = buildNpmSpawn(["run", "bootstrap"], { cwd: "C:\\Repo" }, {
      platform: "win32",
      env: { STRADA_NODE_PATH: PROGRAM_FILES_NODE },
      execPath: "C:\\hostedtoolcache\\node\\node.exe",
      exists: (candidate: string) => candidate === npmCmd,
    });
    expect(options).toEqual({ cwd: "C:\\Repo", shell: true });
    expect(shellCommandLine(command, args)).toBe(`"${npmCmd}" run bootstrap`);
  });

  it("falls back to the bare npm.cmd name (PATH lookup, nothing to split)", async () => {
    const { resolveNpmInvocation } = await loadSourceLauncherModule();
    expect(resolveNpmInvocation({
      platform: "win32",
      env: {},
      execPath: PROGRAM_FILES_NODE,
      exists: () => false,
    })).toEqual({ command: "npm.cmd", args: [], shell: true });
  });

  it("never looks for npm next to a bare `node` (that would be the launch directory)", async () => {
    const { resolveNpmInvocation } = await loadSourceLauncherModule();
    const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const invocation = resolveNpmInvocation({
      platform: "win32",
      // strada.cmd sets the bare name when node was found on PATH.
      env: { STRADA_NODE_PATH: "node" },
      execPath: PROGRAM_FILES_NODE,
      exists: (candidate: string) => candidate === npmCli || !/^[A-Za-z]:\\/.test(candidate),
    });
    expect(invocation).toEqual({ command: PROGRAM_FILES_NODE, args: [npmCli], shell: false });
  });

  it("leaves POSIX npm alone (no shell)", async () => {
    const { buildNpmSpawn } = await loadSourceLauncherModule();
    expect(buildNpmSpawn(["install"], { cwd: "/repo" }, { platform: "linux" }))
      .toEqual(["npm", ["install"], { cwd: "/repo" }]);
  });

  it("executes a .cmd stub in a directory with a space through the real shell", async () => {
    const { buildNpmSpawn } = await loadSourceLauncherModule();
    const nodeDir = mkdtempSync(path.join(os.tmpdir(), "strada node dir "));
    tempDirs.push(nodeDir);
    const stub = path.join(nodeDir, "npm.cmd");
    if (process.platform === "win32") {
      writeFileSync(stub, "@echo off\r\necho npm-stub-ok %1\r\n", "utf8");
    } else {
      writeFileSync(stub, "#!/bin/sh\necho \"npm-stub-ok $1\"\n", { encoding: "utf8", mode: 0o755 });
    }
    const [command, args, options] = buildNpmSpawn(["--version"], { encoding: "utf8" }, {
      platform: "win32",
      env: { STRADA_NODE_PATH: path.join(nodeDir, "node.exe") },
      execPath: path.join(nodeDir, "missing-node", "node.exe"),
      // The host's path module, so the stub resolves wherever the test runs.
      pathImpl: path,
    });
    expect(options.shell).toBe(true);
    const output = execFileSync(command, args, options);
    expect(String(output).trim()).toBe("npm-stub-ok --version");
  });
});
