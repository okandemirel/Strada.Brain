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

  it("resolves relative STRADA_HOME against the launch cwd even when cwd fallback is needed elsewhere", ({ skip }) => {
    // On Windows, path.resolve internally calls process.cwd() for drive letter
    // resolution, so mocking cwd to throw also breaks path.resolve itself.
    if (process.platform === "win32") skip();
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

/**
 * Plan 6.8 (the first-15-minutes rehearsal). Found by running `strada doctor`
 * with HOME redirected to a throwaway directory: it still reported "Loaded .env
 * successfully" from the developer's own checkout, because a process inside this
 * repository ALWAYS took the repository as its config root — `.git` is there, and
 * STRADA_SOURCE_CHECKOUT could only ever force the answer to `true`.
 *
 * The dangerous direction is not the rehearsal: it is that a test with a fake
 * HOME could still read and WRITE the developer's real `.env`.
 */
describe("STRADA_SOURCE_CHECKOUT is three-state (plan 6.8)", () => {
  // The app home is per platform (README: `~/.strada` on macOS/Linux,
  // `%LOCALAPPDATA%\Strada` on Windows), so the platform is pinned: unpinned,
  // this read the HOST's app home and failed on the Windows CI runner.
  const inRepo = { installRoot: process.cwd(), cwd: "/Users/tester/.strada", homeDir: "/Users/tester", platform: "darwin" as const };

  it("false moves the config root into the app home, even inside a checkout", () => {
    const paths = resolveRuntimePaths({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: "false" } });
    expect(paths.sourceCheckout).toBe(false);
    expect(paths.configRoot).toBe(path.join("/Users/tester", ".strada"));
    expect(resolveDotenvPath({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: "false" } }))
      .toBe(path.join("/Users/tester", ".strada", ".env"));
  });

  it("false on Windows moves the config root into %LOCALAPPDATA%\\Strada, the Windows app home", () => {
    const onWindows = {
      ...inRepo,
      homeDir: "C:\\Users\\tester",
      platform: "win32" as const,
      env: { STRADA_SOURCE_CHECKOUT: "false", LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    };
    const paths = resolveRuntimePaths(onWindows);
    expect(paths.sourceCheckout).toBe(false);
    expect(paths.configRoot).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "Strada"));
    expect(resolveDotenvPath(onWindows)).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "Strada", ".env"));
  });

  it("true still forces a source checkout, and 0/1/yes/no are read too", () => {
    expect(resolveRuntimePaths({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: "true" } }).sourceCheckout).toBe(true);
    expect(resolveRuntimePaths({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: "1" } }).sourceCheckout).toBe(true);
    expect(resolveRuntimePaths({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: "YES" } }).sourceCheckout).toBe(true);
    expect(resolveRuntimePaths({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: "0" } }).sourceCheckout).toBe(false);
    expect(resolveRuntimePaths({ ...inRepo, env: { STRADA_SOURCE_CHECKOUT: " No " } }).sourceCheckout).toBe(false);
  });

  it("says nothing when it says nothing: unset, empty or unreadable still probes for .git", () => {
    // This repository has a .git, so the probe answers true — the behaviour
    // every existing caller relies on.
    for (const value of [undefined, "", "   ", "maybe"]) {
      const env = value === undefined ? {} : { STRADA_SOURCE_CHECKOUT: value };
      expect(resolveRuntimePaths({ ...inRepo, env }).sourceCheckout, String(value)).toBe(true);
    }
  });
});
