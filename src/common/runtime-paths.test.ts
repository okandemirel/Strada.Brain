import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDotenvPath, resolveRuntimePaths } from "./runtime-paths.js";

describe("runtime paths", () => {
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
    });

    expect(runtimePaths.configRoot).toBe(path.join("/Users/tester", ".strada"));
    expect(resolveDotenvPath({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      cwd: "/Users/tester/projects",
      homeDir: "/Users/tester",
      env: {},
    })).toBe(path.join("/Users/tester", ".strada", ".env"));
  });

  it("honors STRADA_HOME overrides for packaged installs", () => {
    const runtimePaths = resolveRuntimePaths({
      installRoot: "/opt/strada-brain",
      sourceCheckout: false,
      cwd: "/Users/tester/projects",
      homeDir: "/Users/tester",
      env: { STRADA_HOME: "portable-strada-home" },
    });

    expect(runtimePaths.configRoot).toBe("/Users/tester/projects/portable-strada-home");
  });
});
