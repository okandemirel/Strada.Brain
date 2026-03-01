import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";

export class ModuleCreateTool implements ITool {
  readonly name = "strata_create_module";
  readonly description =
    "Create a new Strada.Core module with all necessary files following Strada conventions. " +
    "Generates: ModuleConfig, asmdef, folder structure (Systems/, Services/, Components/, Mediators/).";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Module name (e.g., 'Inventory', 'Combat', 'UI')",
      },
      path: {
        type: "string",
        description:
          "Relative path for the module folder. Default: 'Assets/Modules/<name>'",
      },
      namespace: {
        type: "string",
        description:
          "C# namespace. Default: 'Game.Modules.<name>'",
      },
      include_system: {
        type: "boolean",
        description: "Include a starter system. Default: true",
      },
      include_service: {
        type: "boolean",
        description: "Include a starter service interface + implementation. Default: true",
      },
    },
    required: ["name"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: module creation is disabled in read-only mode",
        isError: true,
      };
    }

    const name = String(input["name"] ?? "");
    const modulePath = String(input["path"] ?? `Assets/Modules/${name}`);
    const namespace = String(input["namespace"] ?? `Game.Modules.${name}`);
    const includeSystem = input["include_system"] !== false;
    const includeService = input["include_service"] !== false;

    if (!name || !isValidCSharpIdentifier(name) || name[0] !== name[0]!.toUpperCase()) {
      return {
        content: "Error: module name must be a valid C# identifier starting with uppercase (e.g., 'Inventory', 'Combat')",
        isError: true,
      };
    }

    // Validate namespace to prevent code injection
    if (!isValidCSharpIdentifier(namespace, true)) {
      return { content: "Error: invalid namespace", isError: true };
    }

    // Validate path with symlink resolution and sensitive file blocking
    const pathCheck = await validatePath(context.projectPath, modulePath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    const fullBase = pathCheck.fullPath;

    const createdFiles: string[] = [];

    try {
      // Create directory structure
      const dirs = [
        fullBase,
        join(fullBase, "Systems"),
        join(fullBase, "Services"),
        join(fullBase, "Components"),
        join(fullBase, "Mediators"),
      ];
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }

      // 1. Assembly Definition
      const asmdefPath = join(fullBase, `${name}.asmdef`);
      await writeFile(
        asmdefPath,
        JSON.stringify(
          {
            name: `Game.Modules.${name}`,
            rootNamespace: namespace,
            references: [
              "com.strada.core",
              "Unity.Entities",
              "Unity.Mathematics",
              "Unity.Collections",
              "Unity.Burst",
            ],
            includePlatforms: [],
            excludePlatforms: [],
            allowUnsafeCode: true,
            overrideReferences: false,
          },
          null,
          2
        ),
        "utf-8"
      );
      createdFiles.push(`${modulePath}/${name}.asmdef`);

      // 2. ModuleConfig
      const moduleConfigPath = join(fullBase, `${name}ModuleConfig.cs`);
      await writeFile(moduleConfigPath, generateModuleConfig(name, namespace, includeService), "utf-8");
      createdFiles.push(`${modulePath}/${name}ModuleConfig.cs`);

      // 3. Optional System
      if (includeSystem) {
        const systemPath = join(fullBase, "Systems", `${name}System.cs`);
        await writeFile(systemPath, generateSystem(name, namespace), "utf-8");
        createdFiles.push(`${modulePath}/Systems/${name}System.cs`);
      }

      // 4. Optional Service
      if (includeService) {
        const interfacePath = join(fullBase, "Services", `I${name}Service.cs`);
        const implPath = join(fullBase, "Services", `${name}Service.cs`);

        await writeFile(interfacePath, generateServiceInterface(name, namespace), "utf-8");
        await writeFile(implPath, generateServiceImpl(name, namespace), "utf-8");

        createdFiles.push(`${modulePath}/Services/I${name}Service.cs`);
        createdFiles.push(`${modulePath}/Services/${name}Service.cs`);
      }

      const result = [
        `Module '${name}' created successfully!`,
        "",
        "Created files:",
        ...createdFiles.map((f) => `  ${f}`),
        "",
        "Folder structure:",
        `  ${modulePath}/`,
        `  ├── ${name}.asmdef`,
        `  ├── ${name}ModuleConfig.cs`,
        `  ├── Systems/`,
        includeSystem ? `  │   └── ${name}System.cs` : `  │   └── (empty)`,
        `  ├── Services/`,
        includeService
          ? `  │   ├── I${name}Service.cs\n  │   └── ${name}Service.cs`
          : `  │   └── (empty)`,
        `  ├── Components/`,
        `  │   └── (empty)`,
        `  └── Mediators/`,
        `      └── (empty)`,
        "",
        `Next steps:`,
        `  1. Create a ${name}ModuleConfig ScriptableObject asset in Unity`,
        `  2. Add it to GameBootstrapper's module list`,
        `  3. Add components in Components/ folder`,
        `  4. Implement system logic in ${name}System.cs`,
      ].join("\n");

      return { content: result, metadata: { createdFiles } };
    } catch {
      return { content: "Error: could not create module", isError: true };
    }
  }
}

function generateModuleConfig(
  name: string,
  namespace: string,
  includeService: boolean
): string {
  const configLines = [];
  if (includeService) {
    configLines.push(
      `        builder.Register<I${name}Service, ${name}Service>(Strada.Core.DI.Lifetime.Singleton);`
    );
  }

  return `using Strada.Core.Modules;
using UnityEngine;

namespace ${namespace}
{
    [CreateAssetMenu(fileName = "${name}ModuleConfig", menuName = "Strata/Modules/${name}")]
    public class ${name}ModuleConfig : ModuleConfig
    {
        protected override void Configure(IModuleBuilder builder)
        {
${configLines.join("\n")}
        }

        public override void Initialize(IServiceLocator services)
        {
            // Called after DI container is built
        }

        public override void Shutdown()
        {
            // Called on application shutdown
        }
    }
}
`;
}

function generateSystem(name: string, namespace: string): string {
  return `using Strada.Core.ECS;
using Strada.Core.ECS.Core;

namespace ${namespace}
{
    public class ${name}System : SystemBase
    {
        public override void OnUpdate(float deltaTime)
        {
            // TODO: Implement system logic
            // Example:
            // var query = World.Query<Health, Position>();
            // foreach (var entity in query)
            // {
            //     ref var health = ref World.GetComponentRef<Health>(entity);
            //     // Process entity...
            // }
        }
    }
}
`;
}

function generateServiceInterface(name: string, namespace: string): string {
  return `namespace ${namespace}
{
    public interface I${name}Service
    {
        // TODO: Define service contract
    }
}
`;
}

function generateServiceImpl(name: string, namespace: string): string {
  return `namespace ${namespace}
{
    public class ${name}Service : I${name}Service
    {
        // TODO: Implement service
    }
}
`;
}
