import { describe, expect, it } from "vitest";
import {
  detectActiveUnityProjectPaths,
  parseUnityProjectPathFromCommandLine,
  resolveRuntimeUnityProjectPath,
} from "./runtime-unity-project.js";

describe("runtime-unity-project", () => {
  it("parses Unity project paths with spaces from process command lines", () => {
    const commandLine =
      "/Applications/Unity.app/Contents/MacOS/Unity -projectpath /Users/test/My Game -acceptSoftwareTerms";

    expect(parseUnityProjectPathFromCommandLine(commandLine)).toBe("/Users/test/My Game");
  });

  it("deduplicates active Unity project paths from editor and worker processes", () => {
    const detected = detectActiveUnityProjectPaths({
      platform: "darwin",
      spawnSync: () => ({
        stdout: [
          "/Applications/Unity.app/Contents/MacOS/Unity -projectpath /Users/test/My Game -flag",
          "/Applications/Unity.app/Contents/MacOS/Unity -projectPath /Users/test/My Game -batchMode",
        ].join("\n"),
        stderr: "",
        status: 0,
        output: [],
        pid: 1,
        signal: null,
      }),
      existsSync: () => true,
      isDirectory: () => true,
    });

    expect(detected).toEqual(["/Users/test/My Game"]);
  });

  it("keeps the configured project when it matches an active Unity editor", () => {
    const resolution = resolveRuntimeUnityProjectPath("/Users/test/My Game", {
      platform: "darwin",
      spawnSync: () => ({
        stdout: "/Applications/Unity.app/Contents/MacOS/Unity -projectpath /Users/test/My Game -flag",
        stderr: "",
        status: 0,
        output: [],
        pid: 1,
        signal: null,
      }),
      existsSync: () => true,
      isDirectory: () => true,
    });

    expect(resolution.source).toBe("configured");
    expect(resolution.effectiveProjectPath).toBe("/Users/test/My Game");
    expect(resolution.notice).toBeUndefined();
  });

  it("keeps the configured project and emits a notice when another Unity project is active", () => {
    const resolution = resolveRuntimeUnityProjectPath("/Users/test/Old Project", {
      platform: "darwin",
      spawnSync: () => ({
        stdout: "/Applications/Unity.app/Contents/MacOS/Unity -projectpath /Users/test/New Project -flag",
        stderr: "",
        status: 0,
        output: [],
        pid: 1,
        signal: null,
      }),
      existsSync: () => true,
      isDirectory: () => true,
    });

    expect(resolution.source).toBe("configured");
    expect(resolution.effectiveProjectPath).toBe("/Users/test/Old Project");
    expect(resolution.notice).toContain("/Users/test/New Project");
  });

  it("keeps the configured project when multiple active Unity projects are detected", () => {
    const resolution = resolveRuntimeUnityProjectPath("/Users/test/Configured", {
      platform: "darwin",
      spawnSync: () => ({
        stdout: [
          "/Applications/Unity.app/Contents/MacOS/Unity -projectpath /Users/test/One -flag",
          "/Applications/Unity.app/Contents/MacOS/Unity -projectpath /Users/test/Two -flag",
        ].join("\n"),
        stderr: "",
        status: 0,
        output: [],
        pid: 1,
        signal: null,
      }),
      existsSync: () => true,
      isDirectory: () => true,
    });

    expect(resolution.source).toBe("configured");
    expect(resolution.effectiveProjectPath).toBe("/Users/test/Configured");
    expect(resolution.notice).toContain("/Users/test/One");
    expect(resolution.notice).toContain("/Users/test/Two");
  });
});
