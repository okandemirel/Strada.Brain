import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRuntimeEnvironment, resolveDotenvPath, resolveRuntimePaths } from "./runtime-paths.js";

describe("runtime paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps source checkouts rooted at the current working directory", () => {
    const runtimePaths = resolveRuntimePaths({
      installRoot: "/tmp/Strada.Brain",
      sourceCheckout: true,
      cwd: "/tmp/Strada.Brain",
      homeDir: "/Users/tester",
      env: {},
    });

    expect(runtimePaths.configRoot).toBe("/tmp/Strada.Brain");
    expect(runtimePaths.installRoot).toBe("/tmp/Strada.Brain");
    expect(runtimePaths.sourceCheckout).toBe(true);
  });

  it("honors launcher-provided source checkout env overrides", () => {
    const runtimePaths = resolveRuntimePaths({
      cwd: "/Users/tester/.strada",
      homeDir: "/Users/tester",
      env: {
        STRADA_INSTALL_ROOT: "/Users/tester/Strada.Brain",
        STRADA_SOURCE_CHECKOUT: "true",
      },
    });

    expect(runtimePaths.installRoot).toBe("/Users/tester/Strada.Brain");
    expect(runtimePaths.sourceCheckout).toBe(true);
    expect(runtimePaths.configRoot).toBe("/Users/tester/Strada.Brain");
  });

  it("moves packaged installs into the user app home by default", () => {
    const runtimePaths = resolveRuntimePaths({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      cwd: "/Users/tester/projects",
      homeDir: "/Users/tester",
      env: {},
      platform: "darwin",
    });

    expect(runtimePaths.configRoot).toBe(path.join("/Users/tester", ".strada"));
    expect(resolveDotenvPath({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      cwd: "/Users/tester/projects",
      homeDir: "/Users/tester",
      env: {},
      platform: "darwin",
    })).toBe(path.join("/Users/tester", ".strada", ".env"));
  });

  it("uses %LOCALAPPDATA%\\\\Strada for packaged installs on Windows", () => {
    const runtimePaths = resolveRuntimePaths({
      installRoot: "C:\\Strada\\app",
      sourceCheckout: false,
      cwd: "C:\\Users\\tester\\projects",
      homeDir: "C:\\Users\\tester",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      platform: "win32",
    });

    expect(runtimePaths.configRoot).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "Strada"));
    expect(resolveDotenvPath({
      installRoot: "C:\\Strada\\app",
      sourceCheckout: false,
      cwd: "C:\\Users\\tester\\projects",
      homeDir: "C:\\Users\\tester",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      platform: "win32",
    })).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "Strada", ".env"));
  });

  it("honors STRADA_HOME overrides for packaged installs", () => {
    const runtimePaths = resolveRuntimePaths({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      cwd: "/Users/tester/projects",
      homeDir: "/Users/tester",
      env: { STRADA_HOME: "portable-strada-home" },
    });

    expect(runtimePaths.configRoot).toBe(path.resolve("/Users/tester/projects", "portable-strada-home"));
  });

  it("prefers the launcher-provided launch cwd for relative STRADA_HOME overrides", () => {
    const runtimePaths = resolveRuntimePaths({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      homeDir: "/Users/tester",
      env: {
        STRADA_HOME: "portable-strada-home",
        STRADA_LAUNCH_CWD: "/Users/tester/original-launch-dir",
      },
    });

    expect(runtimePaths.configRoot).toBe(path.resolve("/Users/tester/original-launch-dir", "portable-strada-home"));
  });

  it("resolves relative STRADA_HOME against the launch cwd even when cwd fallback is needed elsewhere", () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });

    const runtimePaths = resolveRuntimePaths({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      homeDir: "/Users/tester",
      env: { STRADA_HOME: "portable-strada-home" },
    });

    expect(runtimePaths.configRoot).toBe(path.resolve("/Users/tester", "portable-strada-home"));
  });

  it("normalizes source checkout cwd back to the install root", () => {
    const originalCwd = process.cwd();
    const tempRoot = path.join(originalCwd, ".tmp-runtime-paths");
    const tempRepo = path.join(tempRoot, "repo");
    const tempElsewhere = path.join(tempRoot, "elsewhere");

    try {
      fs.mkdirSync(tempRepo, { recursive: true });
      fs.mkdirSync(tempElsewhere, { recursive: true });
      process.chdir(tempElsewhere);

      initializeRuntimeEnvironment({
        installRoot: tempRepo,
        sourceCheckout: true,
      });

      expect(process.cwd()).toBe(tempRepo);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
