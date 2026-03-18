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
