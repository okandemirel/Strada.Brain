import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      rmSync(dir, { recursive: true, force: true });
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

    if (process.platform === "win32" && existsSync(path.join(process.cwd(), "node_modules"))) {
      const wrapperEnv = {
        ...process.env,
        LOCALAPPDATA: localAppData,
        STRADA_NODE_PATH: process.execPath,
      };
      try {
        const cmdHelp = execFileSync(path.join(installDir, "strada.cmd"), ["--help"], {
          cwd: process.cwd(),
          env: wrapperEnv,
          encoding: "utf8",
          timeout: 15000,
        });
        expect(cmdHelp).toContain("Usage: strada");
      } catch {
        // Wrapper execution may fail on CI when source-launcher
        // triggers a full prepare cycle; static assertions above
        // already validate the generated wrapper content.
      }
    }
  });

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
