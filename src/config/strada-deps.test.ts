import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessStradaMcpLoadTrust,
  checkStradaDeps,
  compareUnityVersions,
  detectStradaMcp,
  evaluateProjectSupport,
  formatProjectMatrix,
  installStradaDep,
  installStradaMcpSubmodule,
  parseUnityVersion,
  readUnityProjectVersion,
  SUPPORTED_UNITY_VERSIONS,
  type ProjectMatrixRow,
  type ProjectSupportVerdict,
  type StradaDepsStatus,
} from "./strada-deps.js";

const TEST_STRADA_CONFIG = {
  coreRepoUrl: "https://example.com/Strada.Core.git",
  modulesRepoUrl: "https://example.com/Strada.Modules.git",
  mcpRepoUrl: "https://example.com/Strada.MCP.git",
};

describe("checkStradaDeps", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `strada-deps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns coreInstalled: false when Packages/ does not exist", () => {
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(false);
    expect(result.modulesInstalled).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Packages/");
  });

  it("returns coreInstalled: false when Packages/ exists but no strada packages", () => {
    mkdirSync(join(testDir, "Packages"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(false);
    expect(result.corePath).toBeNull();
    expect(result.modulesInstalled).toBe(false);
    expect(result.modulesPath).toBeNull();
  });

  it("detects strada.core directory", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    writeFileSync(
      join(testDir, "Packages", "strada.core", "package.json"),
      JSON.stringify({ name: "com.strada.core", version: "3.4.5" }),
    );
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).toBe(join(testDir, "Packages", "strada.core"));
    expect(result.coreVersion).toBe("3.4.5");
    expect(result.coreSource).toBe("package-directory");
  });

  it("detects com.strada.core directory", () => {
    mkdirSync(join(testDir, "Packages", "com.strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).toBe(join(testDir, "Packages", "com.strada.core"));
  });

  it("detects Strada.Core directory (PascalCase)", () => {
    // On case-insensitive filesystems (macOS), the first matching name
    // in CORE_NAMES search order wins, so we only check coreInstalled
    mkdirSync(join(testDir, "Packages", "Strada.Core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).not.toBeNull();
  });

  it("detects strada.modules directory", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    mkdirSync(join(testDir, "Packages", "strada.modules"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.modulesInstalled).toBe(true);
    expect(result.modulesPath).toBe(join(testDir, "Packages", "strada.modules"));
  });

  it("detects core via manifest.json fallback", () => {
    mkdirSync(join(testDir, "Packages"), { recursive: true });
    writeFileSync(
      join(testDir, "Packages", "manifest.json"),
      JSON.stringify({
        dependencies: {
          "com.strada.core": "https://github.com/okandemirel/Strada.Core.git",
        },
      }),
    );
    const result = checkStradaDeps(testDir);
    expect(result.coreInstalled).toBe(true);
    expect(result.corePath).toBeNull(); // manifest-only detection has no path
    expect(result.coreVersion).toBeNull();
    expect(result.coreSource).toBe("manifest");
  });

  it("produces no core warning when core is installed", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.warnings.some((w) => w.includes("Strada.Core not found"))).toBe(false);
  });

  it("produces modules warning when modules is not installed", () => {
    mkdirSync(join(testDir, "Packages", "strada.core"), { recursive: true });
    const result = checkStradaDeps(testDir);
    expect(result.warnings.some((w) => w.includes("Strada.Modules"))).toBe(true);
  });

  it("detects Strada.MCP from configured path", () => {
    const mcpDir = join(testDir, "custom-mcp");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      join(mcpDir, "package.json"),
      JSON.stringify({ name: "strada-mcp", version: "1.2.3" }),
    );

    const result = checkStradaDeps(testDir, {
      ...TEST_STRADA_CONFIG,
      mcpPath: mcpDir,
    });

    expect(result.mcpInstalled).toBe(true);
    expect(result.mcpPath).toBe(mcpDir);
    expect(result.mcpVersion).toBe("1.2.3");
    expect(result.mcpSource).toBe("configured-path");
  });

  it("detects a project-local Strada.MCP install inside Packages/Submodules", () => {
    const localMcpDir = join(testDir, "Packages", "Submodules", "Strada.MCP");
    mkdirSync(localMcpDir, { recursive: true });
    writeFileSync(
      join(localMcpDir, "package.json"),
      JSON.stringify({ name: "strada-mcp", version: "2.0.0" }),
    );

    const result = checkStradaDeps(testDir, TEST_STRADA_CONFIG);

    expect(result.mcpInstalled).toBe(true);
    expect(result.mcpPath).toBe(localMcpDir);
    expect(result.mcpVersion).toBe("2.0.0");
    expect(result.mcpSource).toBe("project-local");
  });

  it("warns when configured STRADA_MCP_PATH is invalid", () => {
    const invalidMcpDir = join(testDir, "invalid-mcp");
    mkdirSync(invalidMcpDir, { recursive: true });
    writeFileSync(
      join(invalidMcpDir, "package.json"),
      JSON.stringify({ name: "not-strada-mcp", version: "1.0.0" }),
    );

    const result = checkStradaDeps(testDir, {
      ...TEST_STRADA_CONFIG,
      mcpPath: invalidMcpDir,
    });

    expect(result.warnings).toContain(
      "Configured STRADA_MCP_PATH is not a valid Strada.MCP package root",
    );
  });
});

describe("installStradaDep", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `strada-deps-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns err when project is not a git repo", async () => {
    const result = await installStradaDep(testDir, "core");
    expect(result.kind).toBe("err");
    expect(result.kind === "err" && result.error).toContain("not a git repository");
  });

  it("returns err when installing Strada.MCP into a project that is not a git repo", async () => {
    const result = await installStradaMcpSubmodule(testDir, "packages", TEST_STRADA_CONFIG);
    expect(result.kind).toBe("err");
    expect(result.kind === "err" && result.error).toContain("not a git repository");
  });
});

/**
 * Supported project matrix (plan 6.10).
 *
 * The measure of this item is that the demo moves to a second machine, which
 * only works if "what a project must have" is checkable data. Every row below
 * asserts the honest-reporting half as much as the detection half: an
 * undetermined row must not read as ok, and a row nothing looked at must read as
 * not-measured rather than missing.
 */
describe("evaluateProjectSupport", () => {
  let projectDir: string;

  const noDeps: StradaDepsStatus = {
    coreInstalled: false,
    corePath: null,
    coreVersion: null,
    coreSource: null,
    modulesInstalled: false,
    modulesPath: null,
    modulesVersion: null,
    modulesSource: null,
    mcpInstalled: false,
    mcpPath: null,
    mcpVersion: null,
    mcpSource: null,
    warnings: [],
  };

  function writeUnityProject(version: string | null): void {
    mkdirSync(join(projectDir, "Assets"), { recursive: true });
    mkdirSync(join(projectDir, "ProjectSettings"), { recursive: true });
    mkdirSync(join(projectDir, "Packages"), { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeFileSync(join(projectDir, "Packages", "manifest.json"), JSON.stringify({ dependencies: {} }));
    if (version !== null) {
      writeFileSync(
        join(projectDir, "ProjectSettings", "ProjectVersion.txt"),
        `m_EditorVersion: ${version}\nm_EditorVersionWithRevision: ${version} (abcdef123456)\n`,
      );
    }
  }

  const row = (verdict: ProjectSupportVerdict, id: string): ProjectMatrixRow => {
    const found = verdict.rows.find((candidate) => candidate.id === id);
    expect(found, `matrix row ${id}`).toBeDefined();
    return found as ProjectMatrixRow;
  };

  beforeEach(() => {
    projectDir = join(
      tmpdir(),
      `strada-matrix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("calls a Unity 2022 project unsupported and names the version and the range", () => {
    writeUnityProject("2022.3.1f1");
    const verdict = evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps });
    const version = row(verdict, "unity-editor-version");

    expect(version.status).toBe("unsupported");
    expect(version.detail).toContain("2022.3.1f1");
    expect(version.detail).toContain(SUPPORTED_UNITY_VERSIONS.minInclusive);
    expect(verdict.unsupported).toContain(version.label);
    expect(verdict.supported).toBe(false);
  });

  it("accepts a Unity 6 project and says when the version is in range but untested", () => {
    writeUnityProject("6000.9.1f1");
    const version = row(
      evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps }),
      "unity-editor-version",
    );

    expect(version.status).toBe("ok");
    expect(version.detail).toContain("NOT in the tested set");
  });

  it("accepts the tested version without the untested caveat", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const version = row(
      evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps }),
      "unity-editor-version",
    );

    expect(version.status).toBe("ok");
    expect(version.detail).toContain("in the tested set");
    expect(version.detail).not.toContain("NOT in the tested set");
  });

  it("reports an unreadable ProjectVersion.txt as unknown, never ok", () => {
    writeUnityProject(null);
    const verdict = evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps });
    const version = row(verdict, "unity-editor-version");

    expect(version.status).toBe("unknown");
    expect(version.status).not.toBe("ok");
    expect(version.detail).toContain("NOT checked");
    expect(verdict.unknown).toContain(version.label);
    // An undetermined required row cannot leave the project "supported".
    expect(verdict.supported).toBe(false);
  });

  it("names exactly which layout paths are absent", () => {
    mkdirSync(join(projectDir, "Assets"), { recursive: true });
    const layout = row(
      evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps }),
      "unity-project-layout",
    );

    expect(layout.status).toBe("missing");
    expect(layout.detail).toContain("ProjectSettings/ProjectVersion.txt");
    expect(layout.detail).toContain("Packages/manifest.json");
    expect(layout.detail).not.toContain("missing Assets,");
  });

  it("fails the required git row for a copied (non-repository) project", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    rmSync(join(projectDir, ".git"), { recursive: true, force: true });
    const verdict = evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps });

    expect(row(verdict, "project-git").status).toBe("missing");
    expect(row(verdict, "project-git").detail).toContain("worktree");
    expect(verdict.supported).toBe(false);
  });

  it("is supported when every required row is ok, even with no Strada packages", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const verdict = evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps });

    expect(verdict.supported).toBe(true);
    // …and the recommended gaps are still named, with what they cost.
    expect(verdict.missing).toContain("Strada.Core");
    expect(verdict.missing).toContain("Strada.MCP");
    expect(row(verdict, "strada-mcp").detail).toContain("playthrough verdict");
  });

  it("reports a present-but-inert Strada.MCP (no node_modules) as missing, not ok", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const mcpDir = join(projectDir, "Packages", "Submodules", "Strada.MCP");
    mkdirSync(join(mcpDir, "src"), { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), JSON.stringify({ name: "strada-mcp", version: "9.9.9" }));

    const verdict = evaluateProjectSupport({
      unityProjectPath: projectDir,
      config: TEST_STRADA_CONFIG,
    });

    expect(row(verdict, "strada-mcp").status).toBe("ok");
    expect(row(verdict, "strada-mcp").detail).toContain("9.9.9");
    const runnable = row(verdict, "strada-mcp-runnable");
    expect(runnable.status).toBe("missing");
    expect(runnable.detail).toContain("node_modules");
    expect(runnable.detail).toContain("zero Unity tools");
  });

  it("calls the Strada.MCP dependency row not-measured when Strada.MCP itself is absent", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const verdict = evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps });
    const runnable = row(verdict, "strada-mcp-runnable");

    // missing and not-measured are different answers: nothing looked here.
    expect(runnable.status).toBe("not-measured");
    expect(verdict.missing).not.toContain(runnable.label);
    expect(verdict.notMeasured).toContain(runnable.label);
  });

  it("marks an installed Strada.MCP with node_modules and src as ok", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const mcpDir = join(projectDir, "mcp");
    mkdirSync(join(mcpDir, "node_modules"), { recursive: true });
    mkdirSync(join(mcpDir, "src"), { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), JSON.stringify({ name: "strada-mcp", version: "1.0.0" }));

    const verdict = evaluateProjectSupport({
      unityProjectPath: projectDir,
      config: { ...TEST_STRADA_CONFIG, mcpPath: mcpDir },
    });

    expect(row(verdict, "strada-mcp-runnable").status).toBe("ok");
  });

  it("reports an unconfigured Unity editor as unknown and a wrong path as missing", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const unset = row(
      evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps }),
      "unity-editor-binary",
    );
    expect(unset.status).toBe("unknown");
    expect(unset.detail).toContain("not determined");

    const wrong = row(
      evaluateProjectSupport({
        unityProjectPath: projectDir,
        deps: noDeps,
        unityEditorPath: join(projectDir, "no-such-editor"),
      }),
      "unity-editor-binary",
    );
    expect(wrong.status).toBe("missing");

    const editor = join(projectDir, "Unity");
    writeFileSync(editor, "#!/bin/sh\n");
    const present = row(
      evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps, unityEditorPath: editor }),
      "unity-editor-binary",
    );
    expect(present.status).toBe("ok");
    // Presence is not a version check, and the row says so rather than implying it.
    expect(present.detail).toContain("NOT launched or compared");
  });

  it("always reports the second machine as not measured — the measure of this item", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const editor = join(projectDir, "Unity");
    writeFileSync(editor, "#!/bin/sh\n");
    const verdict = evaluateProjectSupport({
      unityProjectPath: projectDir,
      deps: noDeps,
      unityEditorPath: editor,
    });
    const second = row(verdict, "second-machine");

    expect(second.status).toBe("not-measured");
    expect(second.detail).toContain("this host only");
    expect(verdict.notMeasured).toContain(second.label);
    expect(formatProjectMatrix(verdict).join("\n")).toContain("[NOT MEASURED] Another machine");
  });

  it("reports a project-local Strada.MCP as untrusted until the operator opts in", () => {
    writeUnityProject(SUPPORTED_UNITY_VERSIONS.tested[0]!);
    const mcpDir = join(projectDir, "Packages", "Submodules", "Strada.MCP");
    mkdirSync(join(mcpDir, "node_modules"), { recursive: true });
    mkdirSync(join(mcpDir, "src"), { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), JSON.stringify({ name: "strada-mcp", version: "1.0.0" }));

    const refused = row(
      evaluateProjectSupport({ unityProjectPath: projectDir, config: TEST_STRADA_CONFIG }),
      "strada-mcp-trusted",
    );
    expect(refused.status).toBe("missing");
    expect(refused.detail).toContain(mcpDir);
    expect(refused.fix).toContain("STRADA_MCP_ALLOW_PROJECT_LOCAL=true");

    const optedIn = row(
      evaluateProjectSupport({
        unityProjectPath: projectDir,
        config: { ...TEST_STRADA_CONFIG, mcpAllowProjectLocal: true },
      }),
      "strada-mcp-trusted",
    );
    expect(optedIn.status).toBe("ok");
  });

  it("summarizes with the counts and every non-ok row", () => {
    writeUnityProject("2022.3.1f1");
    const verdict = evaluateProjectSupport({ unityProjectPath: projectDir, deps: noDeps });

    expect(verdict.summary).toContain("rows ok");
    expect(verdict.summary).toContain("unsupported: Unity Editor version (project)");
    expect(verdict.summary).toContain("missing: Strada.Core");
    expect(verdict.summary).toContain("not measured:");
  });
});

describe("assessStradaMcpLoadTrust", () => {
  let root: string;
  let projectDir: string;

  beforeEach(() => {
    root = join(tmpdir(), `strada-mcp-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectDir = join(root, "Game");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses every copy inside the project tree, however it was found", () => {
    for (const relative of ["Packages/Submodules/Strada.MCP", "Assets/Strada.MCP", "Packages/Strada.MCP", "mcp"]) {
      const installPath = join(projectDir, ...relative.split("/"));
      mkdirSync(installPath, { recursive: true });
      const trust = assessStradaMcpLoadTrust(installPath, projectDir, { mcpPath: installPath });
      expect(trust.trusted, relative).toBe(false);
      expect(trust.reason).toContain("STRADA_MCP_ALLOW_PROJECT_LOCAL=true");
    }
  });

  it("loads a project-local copy once the operator opts in", () => {
    const installPath = join(projectDir, "Packages", "Submodules", "Strada.MCP");
    mkdirSync(installPath, { recursive: true });
    expect(assessStradaMcpLoadTrust(installPath, projectDir, { mcpAllowProjectLocal: true }).trusted).toBe(true);
  });

  it("trusts a copy outside the project, including one whose name merely starts like it", () => {
    const sibling = join(root, "Strada.MCP");
    const lookalike = join(root, "Game-tools", "Strada.MCP");
    mkdirSync(sibling, { recursive: true });
    mkdirSync(lookalike, { recursive: true });
    expect(assessStradaMcpLoadTrust(sibling, projectDir).trusted).toBe(true);
    expect(assessStradaMcpLoadTrust(lookalike, projectDir).trusted).toBe(true);
  });

  it("detects the project-local copy the loader would pick and refuses it by default", () => {
    const installPath = join(projectDir, "Packages", "Submodules", "Strada.MCP");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(join(installPath, "package.json"), JSON.stringify({ name: "strada-mcp", version: "1.0.0" }));
    const install = detectStradaMcp(TEST_STRADA_CONFIG, projectDir);
    expect(install.path).toBe(installPath);
    expect(assessStradaMcpLoadTrust(install.path!, projectDir, TEST_STRADA_CONFIG).trusted).toBe(false);
  });
});

describe("Unity version comparison", () => {
  it("orders 6000.3.22 above 6000.3.9 (a lexicographic sort did not)", () => {
    const older = parseUnityVersion("6000.3.9f1")!;
    const newer = parseUnityVersion("6000.3.22f1")!;
    expect(compareUnityVersions(older, newer)).toBe(-1);
    expect(compareUnityVersions(newer, older)).toBe(1);
    expect(compareUnityVersions(newer, newer)).toBe(0);
  });

  it("returns null for a string that is not a Unity version", () => {
    expect(parseUnityVersion("not-a-version")).toBeNull();
  });

  it("reads m_EditorVersion out of ProjectVersion.txt and says why when it cannot", () => {
    const dir = join(tmpdir(), `strada-version-${Date.now()}`);
    mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
    const absent = readUnityProjectVersion(dir);
    expect(absent.version).toBeNull();
    expect(absent.problem).toContain("missing");

    writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.22f1\n");
    expect(readUnityProjectVersion(dir).version).toBe("6000.3.22f1");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the matrix on an install with no project configured", () => {
  it("says no project is configured instead of throwing the doctor's report away", () => {
    // `unityProjectPath` is optional in a loaded config, and every project row
    // joins onto it: an unset one threw `The "path" argument must be of type
    // string` out of evaluateProjectSupport and took collectDoctorReport with it.
    const verdict = evaluateProjectSupport({ unityProjectPath: undefined as unknown as string });
    expect(verdict.supported).toBe(false);
    expect(verdict.missing).toContain("Unity project layout");
    const layout = verdict.rows.find((row) => row.id === "unity-project-layout");
    expect(layout?.detail).toContain("UNITY_PROJECT_PATH is unset");
    // Nothing about a project is claimed: no version, git, or second-machine row.
    expect(verdict.rows.map((row) => row.id)).not.toContain("project-unity-version");
    expect(verdict.rows.map((row) => row.id)).not.toContain("project-git");
    // NOT ONE PACKAGE IS REPORTED ABSENT (Codex round 12 #27): nothing was
    // looked at, so "missing" would state the result of an inspection that
    // never happened.
    for (const id of ["strada-core", "strada-modules", "strada-mcp"]) {
      const row = verdict.rows.find((r) => r.id === id);
      expect(row?.status).toBe("not-measured");
      expect(row?.detail).toContain("never looked for");
    }
    expect(verdict.missing).toEqual(["Unity project layout"]);
    expect(verdict.notMeasured.length).toBeGreaterThanOrEqual(3);
    expect(verdict.summary).toContain("not measured");
  });
});
