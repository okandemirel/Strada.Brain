import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";
import {
  readDeclaredModuleFolders,
  foldersForModule,
  optionalFolderPaths,
  CORE_INSTALL_PATH,
} from "./module-folders.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { STRADA_API } from "../../context/strada-api-reference.js";

export class ModuleCreateTool implements ITool {
  readonly name = "strada_create_module";
  readonly description =
    "Create a new Strada.Core module with all necessary files following Strada conventions. " +
    "Generates: ModuleConfig, asmdef, and the module folder structure the framework declares — Scripts/{Interfaces,Services,Systems,Components} plus Tests/Runtime and Tests/Editor, Folders come from Strada.Core\u0027s DirectoryStructureConfig, so they always match what the Unity generator produces.";

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
          "Relative path for the module folder. Default: 'Assets/Modules/<name>Module'",
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
      include_controller: {
        type: "boolean",
        description: "Include a starter controller. Default: false",
      },
      include_events: {
        type: "boolean",
        description: "Include an Events/ folder. Default: false",
      },
      include_signals: {
        type: "boolean",
        description: "Include a Signals/ folder. Default: false",
      },
      include_model: {
        type: "boolean",
        description: "Include a Models/ folder. Default: false",
      },
      include_view: {
        type: "boolean",
        description: "Include a Views/ folder. Default: false",
      },
      include_data: {
        type: "boolean",
        description: "Include a Data/ folder. Default: false",
      },
      include_commands: {
        type: "boolean",
        description: "Include a Scripts/Commands/ folder. Default: false",
      },
      include_editor: {
        type: "boolean",
        description: "Include the module\u0027s edit-mode code folder, where the framework declares it. Default: false",
      },
      include_tests: {
        type: "boolean",
        description:
          "Include Tests/Runtime and Tests/Editor, each with its own assembly. Default: true — tests are part of a module, not an extra. Pass false only for a module with genuinely nothing to test.",
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
    const modulePath = String(input["path"] ?? `Assets/Modules/${name}Module`);
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

    // Validate path with symlink resolution and sensitive file blocking.
    //
    // allowMissingParents: this tool lays down its own directory chain below
    // (mkdir recursive, module root included), and the folder it is asked for
    // is Assets/Modules/<Name>Module — which has no parent in a project that
    // has no modules yet. Without this the guard refuses the very first module
    // of every new project; measured on a from-scratch run, that is exactly
    // what happened. Containment is unaffected: validatePath walks to the
    // deepest EXISTING ancestor and proves it sits inside the project root.
    const pathCheck = await validatePath(context.projectPath, modulePath, {
      allowMissingParents: true,
    });
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    const fullBase = pathCheck.fullPath;

    const createdFiles: string[] = [];

    try {
      // The folder list is Strada.Core's, not ours. Keeping a copy here is what
      // let this tool drift from the framework: it created Scripts/Mediators,
      // which was never declared, and created neither Scripts/Interfaces nor
      // Scripts/Editor, which were. Read the declaration instead — when the
      // framework adds a folder, modules made here get it with no change.
      const declared = readDeclaredModuleFolders(context.projectPath);
      if (!declared) {
        return {
          content:
            `Error: Strada.Core is not installed at ${CORE_INSTALL_PATH}, and it is where a module's ` +
            `folder structure is declared. Install the framework first — guessing the structure is how a ` +
            `module ends up in a shape the framework never agreed to.`,
          isError: true,
        };
      }

      const includeController = input["include_controller"] === true;
      const includeEvents = input["include_events"] === true;
      const includeSignals = input["include_signals"] === true;
      const includeModel = input["include_model"] === true;
      const includeView = input["include_view"] === true;
      const includeData = input["include_data"] === true;
      const includeCommands = input["include_commands"] === true;
      const includeEditor = input["include_editor"] === true;
      // Tests default ON, unlike everything else here: the framework declares
      // RuntimeTests and EditorTests as module component types and the agent is
      // told a module must carry its own Tests/Runtime to exist. Defaulting off
      // contradicted both — measured, a run produced three sound modules and not
      // one test folder, because the agent had no reason to pass a flag it was
      // never told it needed.
      const includeTests = input["include_tests"] !== false;

      // ComponentType names, as the framework spells them.
      const components = new Set<string>();
      if (includeService) components.add("Service").add("ServiceInterface");
      if (includeSystem) components.add("EcsSystem").add("EcsComponent");
      if (includeController) components.add("Controller");
      if (includeCommands) components.add("Commands");
      if (includeEvents) components.add("Events");
      if (includeSignals) components.add("Signals");
      if (includeModel) components.add("Model");
      if (includeView) components.add("View");
      if (includeData) components.add("ConfigData").add("ValueObject");
      if (includeEditor) components.add("EditorScripts");
      if (includeTests) components.add("RuntimeTests").add("EditorTests");

      const rawAssetFolders = input["asset_folders"];
      const assetFolders = Array.isArray(rawAssetFolders)
        ? rawAssetFolders.map((f) => String(f))
        : [];
      const declaredOptional = optionalFolderPaths(declared);
      const unknown = assetFolders.filter(
        (f) => !declaredOptional.some((d) => d === f.replace(/\/+$/, "") || d.startsWith(`${f.replace(/\/+$/, "")}/`)),
      );
      if (unknown.length > 0) {
        return {
          content:
            `Error: not declared as module folders: ${unknown.join(", ")}. ` +
            `Strada.Core declares these: ${declaredOptional.join(", ")}.`,
          isError: true,
        };
      }

      const createdDirs = foldersForModule(declared, components, assetFolders);
      const dirs = [
        fullBase,
        ...createdDirs.map((rel) => join(fullBase, ...rel.split("/"))),
      ];

      await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })));

      // 1. Assembly Definition
      const asmdefPath = join(fullBase, `${name}.asmdef`);
      await writeFile(
        asmdefPath,
        JSON.stringify(
          {
            name: `Game.Modules.${name}`,
            rootNamespace: namespace,
            references: [
              STRADA_API.assemblyReferences.core,
              STRADA_API.assemblyReferences.burst,
              STRADA_API.assemblyReferences.collections,
              STRADA_API.assemblyReferences.mathematics,
              STRADA_API.assemblyReferences.entities,
            ],
            includePlatforms: [],
            excludePlatforms: [],
            allowUnsafeCode: false,
            overrideReferences: false,
          },
          null,
          2
        ),
        "utf-8"
      );
      createdFiles.push(`${modulePath}/${name}.asmdef`);

      // 1b. Test assemblies, one per test mode.
      //
      // A test folder without an .asmdef compiles into the default assembly,
      // which cannot see the module's own assembly — so the tests do not
      // reference the code they test. Unity needs the TestRunner references and
      // the editor-only platform constraint spelled out per mode.
      if (includeTests) {
        const moduleAssembly = `Game.Modules.${name}`;
        const testAssemblies: Array<{ dir: string; suffix: string; editorOnly: boolean }> = [
          { dir: "Runtime", suffix: "Tests", editorOnly: false },
          { dir: "Editor", suffix: "Editor.Tests", editorOnly: true },
        ];
        for (const spec of testAssemblies) {
          const testAsmdefPath = join(fullBase, "Tests", spec.dir, `${moduleAssembly}.${spec.suffix}.asmdef`);
          await writeFile(
            testAsmdefPath,
            JSON.stringify(
              {
                name: `${moduleAssembly}.${spec.suffix}`,
                rootNamespace: `${namespace}.Tests`,
                references: [
                  moduleAssembly,
                  STRADA_API.assemblyReferences.core,
                  "UnityEngine.TestRunner",
                  "UnityEditor.TestRunner",
                ],
                includePlatforms: spec.editorOnly ? ["Editor"] : [],
                excludePlatforms: [],
                allowUnsafeCode: false,
                overrideReferences: true,
                precompiledReferences: ["nunit.framework.dll"],
                autoReferenced: false,
                defineConstraints: ["UNITY_INCLUDE_TESTS"],
              },
              null,
              2
            ),
            "utf-8"
          );
          createdFiles.push(`${modulePath}/Tests/${spec.dir}/${moduleAssembly}.${spec.suffix}.asmdef`);
        }
      }

      // 2. ModuleConfig
      const moduleConfigPath = join(fullBase, "Scripts", `${name}ModuleConfig.cs`);
      await writeFile(moduleConfigPath, generateModuleConfig(name, namespace, includeService), "utf-8");
      createdFiles.push(`${modulePath}/Scripts/${name}ModuleConfig.cs`);

      // 3. Optional System
      if (includeSystem) {
        const systemPath = join(fullBase, "Scripts", "Systems", `${name}System.cs`);
        await writeFile(systemPath, generateSystem(name, namespace), "utf-8");
        createdFiles.push(`${modulePath}/Scripts/Systems/${name}System.cs`);
      }

      // 4. Optional Service
      if (includeService) {
        const interfacePath = join(fullBase, "Scripts", "Services", `I${name}Service.cs`);
        const implPath = join(fullBase, "Scripts", "Services", `${name}Service.cs`);

        await writeFile(interfacePath, generateServiceInterface(name, namespace), "utf-8");
        await writeFile(implPath, generateServiceImpl(name, namespace), "utf-8");

        createdFiles.push(`${modulePath}/Scripts/Services/I${name}Service.cs`);
        createdFiles.push(`${modulePath}/Scripts/Services/${name}Service.cs`);
      }

      const result = [
        `Module '${name}' created successfully!`,
        "",
        "Created files:",
        ...createdFiles.map((f) => `  ${f}`),
        "",
        "Folder structure:",
        `  ${modulePath}/`,
        // Listed from what was actually created, not from a second description
        // of it: a summary that drifts from the disk teaches the agent to file
        // its next file in a folder that is not there.
        ...createdDirs.map((rel) => `  ${rel}/`),
        "",
        `Next steps:`,
        `  1. Create a ${name}ModuleConfig ScriptableObject asset in Unity`,
        `  2. Add it to GameBootstrapper's module list`,
        `  3. Put ECS components in Scripts/Components/`,
        includeSystem
          ? `  4. Implement system logic in Scripts/Systems/${name}System.cs`
          : `  4. Add systems under Scripts/Systems/ when you need them`,
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
      `        builder.RegisterService<I${name}Service, ${name}Service>();`
    );
  }

  return `using ${STRADA_API.namespaces.modules};
using ${STRADA_API.namespaces.di};
using UnityEngine;

namespace ${namespace}
{
    [CreateAssetMenu(fileName = "${name}ModuleConfig", menuName = "Strada/Modules/${name}")]
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
  return `using ${STRADA_API.namespaces.ecs};
using ${STRADA_API.namespaces.systems};
using ${STRADA_API.namespaces.modules};

namespace ${namespace}
{
    [StradaSystem]
    [ExecutionOrder(0)]
    public class ${name}System : SystemBase
    {
        protected override void OnInitialize() { }

        protected override void OnUpdate(float deltaTime)
        {
            // TODO: Implement system logic
            // ForEach<ComponentA, ComponentB>((int entity, ref ComponentA a, ref ComponentB b) =>
            // {
            //     // Process entity
            // });
        }

        protected override void OnDispose() { }
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
  return `using ${STRADA_API.namespaces.patterns};

namespace ${namespace}
{
    public class ${name}Service : Service, I${name}Service
    {
        // TODO: Implement service
    }
}
`;
}
