import { access, cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseTestRun } from "./nunit-results.js";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { runProcess } from "../../utils/process-runner.js";
import { ModuleCreateTool } from "../../agents/tools/strada/module-create.js";
import { ComponentCreateTool } from "../../agents/tools/strada/component-create.js";
import { SystemCreateTool } from "../../agents/tools/strada/system-create.js";
import { MediatorCreateTool } from "../../agents/tools/strada/mediator-create.js";
import { CORE_INSTALL_PATH } from "../../agents/tools/strada/module-folders.js";
import { AnalyzeProjectTool } from "../../agents/tools/strada/analyze-project.js";
import { StradaAnalyzer } from "../../intelligence/strada-analyzer.js";
import type { ToolContext } from "../../agents/tools/tool.interface.js";

const runLocalUnityFixtureTests = !!process.env["LOCAL_UNITY_FIXTURE_TESTS"];
const UNITY_TIMEOUT_MS = 20 * 60 * 1000;

type UnityInstall = {
  executable: string;
  version: string;
};

// The editors Unity Hub installs. Pinned versions here named editors no machine
// had, so the fixture could not run anywhere it was asked to (cso-071).
const HUB_EDITORS = "/Applications/Unity/Hub/Editor";

beforeAll(() => {
  createLogger("error", "/tmp/strada-unity-fixture-test.log");
});

describe.skipIf(!runLocalUnityFixtureTests)(
  "Strada Unity fixture integration",
  { timeout: UNITY_TIMEOUT_MS + 60_000 },
  () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(
        tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
      );
    });

    it("generates a Strada module, analyzes it, and compiles in Unity", async () => {
      const unity = await resolveUnityInstall();
      const stradaCorePath = await resolveStradaCorePath();
      const projectPath = await mkdtemp(join(tmpdir(), "strada-unity-fixture-"));
      tempDirs.push(projectPath);

      await createMinimalUnityProject(projectPath, stradaCorePath, unity);

      const context: ToolContext = {
        projectPath,
        workingDirectory: projectPath,
        readOnly: false,
        userId: "test-user",
        chatId: "test-chat",
        sessionId: "strada-unity-fixture",
      };

      const moduleTool = new ModuleCreateTool();
      const componentTool = new ComponentCreateTool();
      const systemTool = new SystemCreateTool();
      const analyzeTool = new AnalyzeProjectTool();

      const moduleResult = await moduleTool.execute(
        {
          name: "Combat",
          path: "Assets/Modules/CombatModule",
          namespace: "Game.Modules.Combat",
          include_system: true,
          include_service: true,
          include_controller: true,
          include_data: true,
          include_view: true,
        },
        context,
      );
      expect(moduleResult.isError, String(moduleResult.content)).toBeUndefined();
      // The module is written from the vendored Core's own templates, not
      // Brain's fallback: that is what this compile is meant to prove.
      expect(moduleResult.metadata?.["templates"]).toBe("core");

      const positionResult = await componentTool.execute(
        {
          name: "Position",
          path: "Assets/Modules/CombatModule/Scripts/Components/PositionComponent.cs",
          namespace: "Game.Modules.Combat",
          fields: [{ name: "Value", type: "float3" }],
        },
        context,
      );
      expect(positionResult.isError).toBeUndefined();

      const velocityResult = await componentTool.execute(
        {
          name: "Velocity",
          path: "Assets/Modules/CombatModule/Scripts/Components/VelocityComponent.cs",
          namespace: "Game.Modules.Combat",
          fields: [{ name: "Value", type: "float3" }],
        },
        context,
      );
      expect(velocityResult.isError).toBeUndefined();

      const systemResult = await systemTool.execute(
        {
          name: "Movement",
          path: "Assets/Modules/CombatModule/Scripts/Systems/MovementSystem.cs",
          namespace: "Game.Modules.Combat",
          query_components: ["PositionComponent", "VelocityComponent"],
        },
        context,
      );
      expect(systemResult.isError).toBeUndefined();

      const jobSystemResult = await systemTool.execute(
        {
          name: "MovementJob",
          path: "Assets/Modules/CombatModule/Scripts/Systems/MovementJobSystem.cs",
          namespace: "Game.Modules.Combat",
          base_class: "JobSystemBase",
          query_components: ["PositionComponent", "VelocityComponent"],
        },
        context,
      );
      expect(jobSystemResult.isError).toBeUndefined();

      const burstSystemResult = await systemTool.execute(
        {
          name: "MovementBurst",
          path: "Assets/Modules/CombatModule/Scripts/Systems/MovementBurstSystem.cs",
          namespace: "Game.Modules.Combat",
          burst_component_count: 2,
          query_components: ["PositionComponent", "VelocityComponent"],
        },
        context,
      );
      expect(burstSystemResult.isError).toBeUndefined();

      const mediatorResult = await new MediatorCreateTool().execute(
        {
          name: "Combat",
          view_type: "CombatView",
          path: "Assets/Modules/CombatModule/Scripts/Views/CombatMediator.cs",
          namespace: "Game.Modules.Combat",
        },
        context,
      );
      expect(mediatorResult.isError, String(mediatorResult.content)).toBeUndefined();

      await writeFile(
        join(projectPath, "Assets", "Tests", "EditMode", "Strada.Brain.UnityFixture.EditModeTests.asmdef"),
        buildFixtureTestAsmdef(),
        "utf-8",
      );
      await writeFile(
        join(projectPath, "Assets", "Tests", "EditMode", "StradaFixtureGeneratedCodeTests.cs"),
        buildFixtureEditModeTestScript(),
        "utf-8",
      );

      const analysis = await new StradaAnalyzer(projectPath).analyze();
      expect(analysis.modules.map((module) => module.className)).toContain("CombatModuleConfig");
      expect(analysis.systems.map((system) => system.name)).toEqual(
        expect.arrayContaining([
          "CombatSystem",
          "MovementSystem",
          "MovementJobSystem",
          "MovementBurstSystem",
        ]),
      );
      expect(analysis.components.map((component) => component.name)).toEqual(
        expect.arrayContaining(["PositionComponent", "VelocityComponent"]),
      );
      expect(analysis.asmdefs.map((asmdef) => asmdef.name)).toContain("Game.Modules.Combat");

      const formattedAnalysis = await analyzeTool.execute({}, context);
      expect(formattedAnalysis.isError).toBeUndefined();
      expect(formattedAnalysis.content).toContain("Strada Project Analysis");
      expect(formattedAnalysis.content).toContain("CombatModuleConfig");
      expect(formattedAnalysis.content).toContain("MovementBurstSystem");

      const unityRun = await runUnityFixture(projectPath, unity.executable);
      expect(unityRun.exitCode).toBe(0);

      // Read the counts, not the substring. A run where two of three tests fail
      // still contains "Passed" — every passing case carries it — so the old
      // assertion held for a red run. And a run that executed nothing at all is
      // not a pass: total must be above zero for the rest to mean anything.
      const outcome = parseTestRun(unityRun.results);
      expect(outcome, `no <test-run> in results XML:\n${unityRun.results.slice(0, 400)}`)
        .not.toBeNull();
      expect(outcome!.total).toBeGreaterThan(0);
      expect(outcome!.failed, `failing tests:\n${unityRun.log.slice(-2000)}`).toBe(0);
      expect(outcome!.result).toBe("Passed");
    });
  },
);

/** UNITY_PATH, or the newest Unity 6000 editor Unity Hub installed. */
async function resolveUnityInstall(): Promise<UnityInstall> {
  const explicit = process.env["UNITY_PATH"];
  if (explicit) {
    await access(explicit);
    const version = process.env["UNITY_VERSION"] ?? /Editor\/([^/]+)\//.exec(explicit)?.[1];
    if (!version) throw new Error(`Set UNITY_VERSION: no editor version in UNITY_PATH ${explicit}`);
    return { executable: explicit, version };
  }
  const installed = (await readdir(HUB_EDITORS).catch(() => [] as string[]))
    .filter((v) => /^6000\./.test(v))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  for (const version of installed) {
    const executable = join(HUB_EDITORS, version, "Unity.app", "Contents", "MacOS", "Unity");
    try {
      await access(executable);
      return { executable, version };
    } catch {
      continue;
    }
  }

  throw new Error(
    `No Unity 6000 editor under ${HUB_EDITORS}. Set UNITY_PATH to a Unity 6000 editor binary before running this test.`,
  );
}

/** The checkout beside this repo — the main checkout's sibling when run from a worktree. */
function siblingCoreCheckouts(): string[] {
  const out = [join(process.cwd(), "..", "Strada.Core")];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: process.cwd(),
    }).toString().trim();
    out.push(join(dirname(common), "..", "Strada.Core"));
  } catch {
    // Not a git checkout: the cwd sibling is all there is.
  }
  return out;
}

async function resolveStradaCorePath(): Promise<string> {
  const candidates = [
    process.env["STRADA_CORE_PATH"],
    ...siblingCoreCheckouts(),
    "/tmp/Strada.Core-audit",
    "/tmp/Strada.Core-ci",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "package.json"));
      await access(join(candidate, "manifest.json"));
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Strada.Core reference repo not found. Set STRADA_CORE_PATH before running this test.",
  );
}

async function createMinimalUnityProject(
  projectPath: string,
  stradaCorePath: string,
  unity: UnityInstall,
): Promise<void> {
  await mkdir(join(projectPath, "Assets", "Editor"), { recursive: true });
  await mkdir(join(projectPath, "Assets", "Modules"), { recursive: true });
  await mkdir(join(projectPath, "Assets", "Tests", "EditMode"), { recursive: true });
  await mkdir(join(projectPath, "Packages"), { recursive: true });
  await mkdir(join(projectPath, "ProjectSettings"), { recursive: true });

  // Vendored where a Strada project carries it, which is where the generators
  // read its layout and templates from; referenced in place, strada_create_module
  // found no framework and refused. A copy, so the editor's import never writes
  // into the checkout.
  await cp(stradaCorePath, join(projectPath, ...CORE_INSTALL_PATH.split("/")), {
    recursive: true,
    filter: (source) => ![".git", "bin", "obj"].includes(basename(source)),
  });

  const manifest = JSON.parse(
    await readFile(join(stradaCorePath, "manifest.json"), "utf-8"),
  ) as {
    dependencies?: Record<string, string>;
  };

  const moduleDependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([name]) =>
      name.startsWith("com.unity.modules."),
    ),
  );

  await writeFile(
    join(projectPath, "Packages", "manifest.json"),
    JSON.stringify(
      {
        dependencies: {
          ...moduleDependencies,
          "com.strada.core": `file:${CORE_INSTALL_PATH.replace(/^Packages\//, "")}`,
          "com.unity.test-framework": await bundledTestFrameworkVersion(unity.executable),
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  await writeFile(
    join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
    `m_EditorVersion: ${unity.version}\n`,
    "utf-8",
  );
}

/** The Test Framework version the editor ships with, so nothing has to be downloaded. */
async function bundledTestFrameworkVersion(unityExecutable: string): Promise<string> {
  const manifest = join(
    dirname(dirname(unityExecutable)),
    "Resources", "PackageManager", "BuiltInPackages", "com.unity.test-framework", "package.json",
  );
  try {
    return (JSON.parse(await readFile(manifest, "utf-8")) as { version: string }).version;
  } catch {
    return "1.6.0";
  }
}

async function runUnityFixture(projectPath: string, unityExecutable: string): Promise<{
  exitCode: number;
  log: string;
  results: string;
  stderr: string;
}> {
  const logPath = join(projectPath, "unity-fixture.log");
  const resultsPath = join(projectPath, "unity-fixture-results.xml");

  const result = await runProcess({
    command: unityExecutable,
    args: [
      "-batchmode",
      "-nographics",
      // No -quit. The test runner owns the exit: it calls EditorApplication.Exit
      // with a code that reflects the results. -quit makes the Editor quit on its
      // own schedule instead, which returns 0 whatever the tests did and can cut
      // the run off before the results XML is written.
      "-projectPath",
      projectPath,
      "-runTests",
      "-testPlatform",
      "EditMode",
      "-testResults",
      resultsPath,
      "-logFile",
      logPath,
    ],
    cwd: dirname(projectPath),
    timeoutMs: UNITY_TIMEOUT_MS,
    maxOutput: 32_768,
    env: {
      ...process.env,
      UNITY_NOPROXY: "1",
    },
  });

  const log = await readLogFile(logPath);
  const results = await readLogFile(resultsPath);
  if (result.exitCode !== 0) {
    const logTail = tail(log, 200);
    throw new Error(
      [
        `Unity fixture compile failed with exit code ${result.exitCode}.`,
        result.stderr ? `stderr:\n${result.stderr}` : "",
        logTail ? `log tail:\n${logTail}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return {
    exitCode: result.exitCode,
    log,
    results,
    stderr: result.stderr,
  };
}

async function readLogFile(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf-8");
  } catch {
    return "";
  }
}

function tail(content: string, lineCount: number): string {
  return content.split("\n").slice(-lineCount).join("\n");
}

function buildFixtureTestAsmdef(): string {
  // The test-assembly form the module's own Tests/Editor assembly uses;
  // optionalUnityReferences is the pre-2019 spelling.
  return JSON.stringify(
    {
      name: "Strada.Brain.UnityFixture.EditModeTests",
      references: ["Game.Modules.Combat", "Strada.Core", "UnityEngine.TestRunner", "UnityEditor.TestRunner"],
      includePlatforms: ["Editor"],
      overrideReferences: true,
      precompiledReferences: ["nunit.framework.dll"],
      autoReferenced: false,
      defineConstraints: ["UNITY_INCLUDE_TESTS"],
    },
    null,
    2,
  );
}

function buildFixtureEditModeTestScript(): string {
  return `using NUnit.Framework;
using Game.Modules.Combat;

namespace StradaFixture.Tests
{
    public class StradaFixtureGeneratedCodeTests
    {
        [Test]
        public void GeneratedTypes_AreLoadable()
        {
            var validatedTypes = new[]
            {
                typeof(CombatModuleConfig),
                typeof(ICombatService),
                typeof(CombatService),
                typeof(CombatController),
                typeof(CD_Combat),
                typeof(CombatConfig),
                typeof(CombatView),
                typeof(CombatMediator),
                typeof(CombatSystem),
                typeof(MovementSystem),
                typeof(MovementJobSystem),
                typeof(MovementBurstSystem),
                typeof(PositionComponent),
                typeof(VelocityComponent),
            };

            Assert.That(validatedTypes, Has.Length.EqualTo(14));
        }
    }
}
`;
}
