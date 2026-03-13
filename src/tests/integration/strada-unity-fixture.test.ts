import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { runProcess } from "../../utils/process-runner.js";
import { ModuleCreateTool } from "../../agents/tools/strada/module-create.js";
import { ComponentCreateTool } from "../../agents/tools/strada/component-create.js";
import { SystemCreateTool } from "../../agents/tools/strada/system-create.js";
import { AnalyzeProjectTool } from "../../agents/tools/strada/analyze-project.js";
import { StradaAnalyzer } from "../../intelligence/strada-analyzer.js";
import type { ToolContext } from "../../agents/tools/tool.interface.js";

const runLocalUnityFixtureTests = !!process.env["LOCAL_UNITY_FIXTURE_TESTS"];
const UNITY_TIMEOUT_MS = 20 * 60 * 1000;

type UnityInstall = {
  executable: string;
  version: string;
};

const unityCandidates: UnityInstall[] = [
  {
    executable:
      process.env["UNITY_PATH"] ??
      "/Applications/Unity/Hub/Editor/6000.0.67f1/Unity.app/Contents/MacOS/Unity",
    version: process.env["UNITY_VERSION"] ?? "6000.0.67f1",
  },
  {
    executable: "/Applications/Unity/Hub/Editor/6000.0.58f2/Unity.app/Contents/MacOS/Unity",
    version: "6000.0.58f2",
  },
];

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

      await createMinimalUnityProject(projectPath, stradaCorePath, unity.version);

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
        },
        context,
      );
      expect(moduleResult.isError).toBeUndefined();

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
      expect(unityRun.results).toContain("result=");
      expect(unityRun.results).toContain("Passed");
    });
  },
);

async function resolveUnityInstall(): Promise<UnityInstall> {
  for (const candidate of unityCandidates) {
    try {
      await access(candidate.executable);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Unity executable not found. Set UNITY_PATH to a Unity 6000 editor binary before running this test.",
  );
}

async function resolveStradaCorePath(): Promise<string> {
  const candidates = [
    process.env["STRADA_CORE_PATH"],
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
  unityVersion: string,
): Promise<void> {
  await mkdir(join(projectPath, "Assets", "Editor"), { recursive: true });
  await mkdir(join(projectPath, "Assets", "Modules"), { recursive: true });
  await mkdir(join(projectPath, "Assets", "Tests", "EditMode"), { recursive: true });
  await mkdir(join(projectPath, "Packages"), { recursive: true });
  await mkdir(join(projectPath, "ProjectSettings"), { recursive: true });

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
          "com.strada.core": `file:${stradaCorePath}`,
          "com.unity.test-framework": "1.1.33",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  await writeFile(
    join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
    `m_EditorVersion: ${unityVersion}\n`,
    "utf-8",
  );
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
      "-quit",
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
  return JSON.stringify(
    {
      name: "Strada.Brain.UnityFixture.EditModeTests",
      references: ["Game.Modules.Combat"],
      includePlatforms: ["Editor"],
      optionalUnityReferences: ["TestAssemblies"],
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
                typeof(CombatSystem),
                typeof(MovementSystem),
                typeof(MovementJobSystem),
                typeof(MovementBurstSystem),
                typeof(PositionComponent),
                typeof(VelocityComponent),
                typeof(CombatService),
            };

            Assert.That(validatedTypes, Has.Length.EqualTo(8));
        }
    }
}
`;
}
