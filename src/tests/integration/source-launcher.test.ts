import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSourceLauncherModule() {
  return import(pathToFileURL(path.join(process.cwd(), "scripts", "source-launcher.mjs")).href);
}

describe("source launcher install-command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("installs user-local wrappers and updates the detected zsh profile idempotently", () => {
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
    expect(readFileSync(path.join(installDir, "strada.cmd"), "utf8")).toContain("scripts/source-launcher.mjs");
    expect(readFileSync(path.join(installDir, "strada.ps1"), "utf8")).toContain("scripts/source-launcher.mjs");
    expect(pathSync).toHaveBeenCalledTimes(2);
    expect(mergeWindowsUserPath("", installDir)).toEqual({
      updated: true,
      path: installDir,
    });
    expect(mergeWindowsUserPath(`${installDir};C:\\Tools`, installDir)).toEqual({
      updated: false,
      path: `${installDir};C:\\Tools`,
    });

    if (process.platform === "win32") {
      const wrapperEnv = {
        ...process.env,
        LOCALAPPDATA: localAppData,
        STRADA_NODE_PATH: process.execPath,
      };
      const cmdHelp = execFileSync(path.join(installDir, "strada.cmd"), ["--help"], {
        cwd: process.cwd(),
        env: wrapperEnv,
        encoding: "utf8",
      });
      expect(cmdHelp).toContain("Usage: strada");

      const psHelp = execFileSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(installDir, "strada.ps1"),
        "--help",
      ], {
        cwd: process.cwd(),
        env: wrapperEnv,
        encoding: "utf8",
      });
      expect(psHelp).toContain("Usage: strada");
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
      env: {
        ...process.env,
        HOME: tempHome,
        XDG_BIN_HOME: tempBin,
      },
      homeDir: tempHome,
      launcherPath: path.join(tempBin, "strada"),
    });

    expect(refreshed).toBe(true);
    expect(readFileSync(path.join(tempBin, "strada"), "utf8")).toContain("scripts/source-launcher.mjs");
    expect(readFileSync(path.join(tempBin, "strada-brain"), "utf8")).toContain("scripts/source-launcher.mjs");
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
    expect(readFileSync(path.join(installDir, "strada.cmd"), "utf8")).toContain("scripts/source-launcher.mjs");
    expect(readFileSync(path.join(installDir, "strada.ps1"), "utf8")).toContain("scripts/source-launcher.mjs");
  });

  it("uninstalls POSIX wrappers, removes the managed profile block, and can purge repo-local runtime files", async () => {
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
    writeFileSync(path.join(tempRepo, ".env"), [
      "MEMORY_DB_PATH=.strada-memory",
      "WHATSAPP_SESSION_PATH=.whatsapp-session",
      `LOG_FILE=${externalLog}`,
      "DAEMON_HEARTBEAT_FILE=./HEARTBEAT.md",
    ].join("\n"));
    writeFileSync(path.join(tempRepo, "strada-brain-error.log"), "error\n", "utf8");
    writeFileSync(path.join(tempRepo, "HEARTBEAT.md"), "# test\n", "utf8");
    writeFileSync(path.join(tempRepo, "data", "tasks.db"), "sqlite\n", "utf8");
    writeFileSync(externalLog, "external\n", "utf8");
    tempDirs.push(externalLog);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      uninstallCommand({
        env,
        homeDir: tempHome,
        rootDir: tempRepo,
        purgeConfig: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(existsSync(path.join(tempBin, "strada"))).toBe(false);
    expect(existsSync(path.join(tempBin, "strada-brain"))).toBe(false);
    expect(readFileSync(path.join(tempHome, ".zshrc"), "utf8")).not.toContain("# >>> Strada command >>>");
    expect(existsSync(path.join(tempRepo, ".env"))).toBe(false);
    expect(existsSync(path.join(tempRepo, ".strada-memory"))).toBe(false);
    expect(existsSync(path.join(tempRepo, ".whatsapp-session"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "HEARTBEAT.md"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "strada-brain-error.log"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "data", "tasks.db"))).toBe(false);
    expect(existsSync(path.join(tempRepo, "data"))).toBe(false);
    expect(existsSync(externalLog)).toBe(true);
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
