import os from "node:os";
import path from "node:path";

export function getSourceLauncherCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ".\\strada.ps1" : "./strada";
}

export function getSourceInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return `${getSourceLauncherCommand(platform)} install-command`;
}

export function getSourceUninstallCommand(platform: NodeJS.Platform = process.platform): string {
  return `${getSourceLauncherCommand(platform)} uninstall`;
}

export function getSourceDoctorCommand(platform: NodeJS.Platform = process.platform): string {
  return `${getSourceLauncherCommand(platform)} doctor`;
}

export function getSourceSetupCommand(
  platform: NodeJS.Platform = process.platform,
  mode?: "web" | "terminal",
): string {
  const launcher = getSourceLauncherCommand(platform);
  if (!mode) return `${launcher} setup`;
  return `${launcher} setup --${mode}`;
}

export function getBareCommand(args: string[] = []): string {
  return ["strada", ...args].join(" ");
}

export function getWindowsInstallBinDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(env["LOCALAPPDATA"] || path.join(homeDir, "AppData", "Local"), "Strada", "bin");
}

export function getPackagedAppHomeDescription(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "%LOCALAPPDATA%\\Strada" : "~/.strada";
}

export function getPlatformInstallCommandGuidance(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string[] {
  if (platform === "win32") {
    const installDir = getWindowsInstallBinDir(env, homeDir);
    return [
      `PowerShell: $env:PATH = "${installDir};$env:PATH"`,
      `CMD:        set PATH=${installDir};%PATH%`,
    ];
  }
  return [];
}

export function formatLauncherInvocation(
  launcherPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const normalized = launcherPath.toLowerCase();
    if (normalized.endsWith(".ps1")) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath, ...args],
      };
    }
    if (normalized.endsWith(".cmd") || normalized.endsWith(".bat")) {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", launcherPath, ...args],
      };
    }
  }

  return {
    command: launcherPath,
    args,
  };
}
