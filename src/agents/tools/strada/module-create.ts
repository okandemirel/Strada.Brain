import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";
import { createGeneratedFile } from "./generated-file.js";
import {
  readModuleLayout,
  foldersForModule,
  folderForComponent,
  optionalFolderPaths,
  CORE_INSTALL_PATH,
  INCOMPLETE_CHECKOUT_HINT,
} from "./module-folders.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { STRADA_API } from "../../context/strada-api-reference.js";

export class ModuleCreateTool implements ITool {
  readonly name = "strada_create_module";
  readonly description =
    "Create a new Strada.Core module with all necessary files following Strada conventions. " +
    "Generates: ModuleConfig, asmdef, and the module folder structure the framework declares — Scripts/{Interfaces,Services,Systems,Components} plus Tests/Runtime and Tests/Editor, Folders come from Strada.Core\u0027s module layout (ModuleLayout.cs, or DirectoryStructureConfig.cs in older versions), so they always match what the Unity generator produces. " +
    "Safe on a module folder that already holds code: files already there are kept as they are, never overwritten, and only the missing ones are created. " +
    "A type the module already declares anywhere is not generated again, and when either half of the I<Name>Service/<Name>Service pair exists neither half is generated or registered; the result lists what was kept and what is left to register.";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Module name (e.g., 'Inventory', 'Combat', 'UI'). A trailing 'Module' is accepted and not repeated, so 'Board' and 'BoardModule' produce the same module.",
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
        description:
          "Include the folder signals go in, as the installed Strada.Core declares it: Scripts/Signals in a layout that gives them their own, Scripts/Events in one that files them with events (ModuleLayout.cs). Default: false",
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
        description:
          "Include a Scripts/Commands/ folder where the installed Strada.Core declares one. The older layout (DirectoryStructureConfig.cs) declares one; the newer one (ModuleLayout.cs) does not, and the result then says so. Default: false",
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

    // "BoardModule" is what a module is called, so callers pass it — and every
    // name below is composed off this one. Left raw it produced
    // BoardModuleModuleConfig, an asset menu to match, and a
    // BoardModuleModule/ folder. The suffix names the kind of thing, not this
    // particular one, so it is stripped here and re-added where it belongs.
    // Anchored: "Modulator" keeps its tail.
    const rawName = String(input["name"] ?? "");
    const name = /.Module$/.test(rawName) ? rawName.replace(/Module$/, "") : rawName;
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
      const lookup = readModuleLayout(context.projectPath);
      if (lookup.status === "not-installed") {
        return {
          content:
            `Error: Strada.Core is not installed at ${CORE_INSTALL_PATH}, and it is where a module's ` +
            `folder structure is declared. Install the framework first — guessing the structure is how a ` +
            `module ends up in a shape the framework never agreed to.`,
          isError: true,
        };
      }
      if (lookup.status === "incomplete") {
        return {
          content:
            `Error: the Strada.Core checkout is incomplete — ${CORE_INSTALL_PATH} is there, but ` +
            `${INCOMPLETE_CHECKOUT_HINT}. No module was created — guessing the structure is how a module ` +
            `ends up in a shape the framework never agreed to.`,
          isError: true,
        };
      }
      // Kept apart from "not installed": that told an agent standing in an
      // installed framework to install it, when the real fault was a layout
      // file this reader could not follow.
      if (lookup.status === "unreadable") {
        return {
          content:
            `Error: Strada.Core is installed at ${CORE_INSTALL_PATH}, but its module layout could not be read ` +
            `(${lookup.reason}). The framework may declare its layout somewhere this tool does not yet read, ` +
            `or the checkout is incomplete. No module was created — guessing the structure is how a module ` +
            `ends up in a shape the framework never agreed to.`,
          isError: true,
        };
      }
      const { layout } = lookup;
      const declared = layout.folders;

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

      const declaredOptional = optionalFolderPaths(declared);
      // Omitted means all of them. A module gets the authored-asset folders the
      // framework declares without the agent having to know they exist — asking
      // it to name them is how they went unmade. Pass an explicit list to narrow
      // it, or an empty list for a module that holds no assets.
      const rawAssetFolders = input["asset_folders"];
      const assetFolders = Array.isArray(rawAssetFolders)
        ? rawAssetFolders.map((f) => String(f))
        : declaredOptional;
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

      const createdDirs = foldersForModule(declared, components, assetFolders, layout.folderOwners);

      // A component the layout files with another (Signals with Events) or no
      // longer has (Commands) is said so here; creating nothing in silence left
      // the agent to invent the missing folder itself.
      const layoutFile = basename(layout.file);
      const placementNotes: string[] = [];
      for (const component of components) {
        const folder = folderForComponent(layout, component);
        if (folder === null) {
          placementNotes.push(
            `  ${component}: the installed Strada.Core declares no folder for it (${layoutFile}), so none was created`,
          );
        } else if (layout.folderOwners.has(component)) {
          placementNotes.push(`  ${component} → ${folder}/ (${layoutFile} files it there)`);
        }
      }

      const dirs = [
        fullBase,
        ...createdDirs.map((rel) => join(fullBase, ...rel.split("/"))),
      ];

      await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })));

      // Nothing already in the module is replaced. The conformance gate sends
      // the agent here for a module folder that holds code but lacks its
      // config or assembly, so this call has to fill those gaps and leave the
      // code alone — it used to truncate every template path it shared.
      //
      // "Already there" is judged by what the module declares, not by the
      // template's own path: an IBoardService in Scripts/Interfaces (where the
      // framework's layout files it) is the same type a stub in
      // Scripts/Services would declare a second time.
      const existing = await readModuleSources(fullBase);
      const keptFiles: string[] = [];
      const keep = (rel: string): void => {
        if (!keptFiles.includes(`${modulePath}/${rel}`)) keptFiles.push(`${modulePath}/${rel}`);
      };
      const place = async (rel: string, content: string): Promise<boolean> => {
        const outcome = await createGeneratedFile(context.projectPath, join(fullBase, ...rel.split("/")), content);
        if (outcome === "created") createdFiles.push(`${modulePath}/${rel}`);
        else keep(rel);
        return outcome === "created";
      };
      // A folder compiles into the nearest .asmdef at or above it, so one in
      // the folder or between it and the module root already owns it; and an
      // assembly name the module already declares is a duplicate assembly a
      // second time. Either stops every assembly in the project compiling.
      // Returns the assembly the folder ends up in.
      const placeAssembly = async (
        folder: string,
        fileName: string,
        assemblyName: string,
        content: string,
      ): Promise<string> => {
        const segments = folder.split("/").filter(Boolean);
        const owners = segments.length === 0 ? [""] : segments.map((_, i) => segments.slice(0, i + 1).join("/"));
        const owning =
          existing.assemblies.find((a) => owners.includes(folderOf(a.rel))) ??
          existing.assemblies.find((a) => a.name === assemblyName);
        if (owning) {
          keep(owning.rel);
          return owning.name ?? assemblyName;
        }
        await place(`${folder ? `${folder}/` : ""}${fileName}`, content);
        return assemblyName;
      };

      // 1. Assembly Definition
      const moduleAssembly = await placeAssembly(
        "",
        `${name}.asmdef`,
        `Game.Modules.${name}`,
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
      );

      // 1b. Test assemblies, one per test mode.
      //
      // A test folder without an .asmdef compiles into the default assembly,
      // which cannot see the module's own assembly — so the tests do not
      // reference the code they test. Unity needs the TestRunner references and
      // the editor-only platform constraint spelled out per mode.
      //
      // They reference the assembly the module root really has: a kept root
      // .asmdef under another name is the module's assembly, and a reference
      // to Game.Modules.<Name> would name one that does not exist.
      if (includeTests) {
        const testAssemblies: Array<{ dir: string; suffix: string; editorOnly: boolean }> = [
          { dir: "Runtime", suffix: "Tests", editorOnly: false },
          { dir: "Editor", suffix: "Editor.Tests", editorOnly: true },
        ];
        for (const spec of testAssemblies) {
          await placeAssembly(
            `Tests/${spec.dir}`,
            `${moduleAssembly}.${spec.suffix}.asmdef`,
            `${moduleAssembly}.${spec.suffix}`,
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
          );
        }
      }

      // 2. Optional System
      if (includeSystem) {
        const declared = declarationOf(existing, `${name}System`);
        if (declared) keep(declared);
        else await place(`Scripts/Systems/${name}System.cs`, generateSystem(name, namespace));
      }

      // 3. Optional Service — the interface and its implementation are one
      // unit. Strada.Core constrains RegisterService<TInterface, TImplementation>
      // with `where TImplementation : class, TInterface`, so a stub half next to
      // a hand-written half either declares a type twice or fails that
      // constraint: the module stops compiling. With either half there, neither
      // is generated and the author's pair is left to the author.
      let serviceCreated = false;
      const keptServiceHalves: string[] = [];
      if (includeService) {
        for (const type of [`I${name}Service`, `${name}Service`]) {
          const declared = declarationOf(existing, type);
          if (declared && !keptServiceHalves.includes(declared)) keptServiceHalves.push(declared);
        }
        keptServiceHalves.forEach(keep);
        if (keptServiceHalves.length === 0) {
          const interfaceCreated = await place(`Scripts/Services/I${name}Service.cs`, generateServiceInterface(name, namespace));
          const implCreated = await place(`Scripts/Services/${name}Service.cs`, generateServiceImpl(name, namespace));
          serviceCreated = interfaceCreated && implCreated;
        }
      }

      // 4. ModuleConfig — one per module, wherever in it the author put it: a
      // second <Name>ModuleConfig class is a duplicate definition. It registers
      // the service pair only when this call made both halves; registering a
      // pair it did not make is a compile error waiting on someone else's code.
      const existingConfig = existing.files.find((f) => /ModuleConfig\.cs$/i.test(f)) ?? null;
      if (existingConfig) keep(existingConfig);
      else await place(`Scripts/${name}ModuleConfig.cs`, generateModuleConfig(name, namespace, serviceCreated));

      const headline =
        keptFiles.length === 0
          ? `Module '${name}' created successfully!`
          : createdFiles.length === 0
            ? `Module '${name}' already exists at ${modulePath}: every file it would create is there and was kept as it was. Nothing was overwritten.`
            : `Module '${name}' completed at ${modulePath}: created what was missing and kept ${keptFiles.length} existing file(s) as they were. Nothing was overwritten.`;
      const result = [
        headline,
        "",
        "Created files:",
        ...(createdFiles.length > 0 ? createdFiles.map((f) => `  ${f}`) : ["  (none)"]),
        ...(keptFiles.length > 0
          ? ["", "Kept (already existed, left unchanged):", ...keptFiles.map((f) => `  ${f}`)]
          : []),
        ...(existingConfig && serviceCreated
          ? ["", `The kept ${existingConfig} was not changed: register I${name}Service there yourself.`]
          : []),
        ...(keptServiceHalves.length > 0
          ? [
              "",
              `Service: ${keptServiceHalves.map((f) => `${modulePath}/${f}`).join(", ")} already declare(s) part of the I${name}Service/${name}Service ` +
                `pair, so neither half was generated — a stub beside a hand-written half would not compile against it. ` +
                `The pair was not registered by this call: once ${name}Service implements I${name}Service, make sure ` +
                `the module config's Configure calls builder.RegisterService<I${name}Service, ${name}Service>().`,
            ]
          : []),
        "",
        "Folder structure:",
        `  ${modulePath}/`,
        // Listed from what was actually created, not from a second description
        // of it: a summary that drifts from the disk teaches the agent to file
        // its next file in a folder that is not there.
        ...createdDirs.map((rel) => `  ${rel}/`),
        ...(placementNotes.length > 0 ? ["", "Requested components:", ...placementNotes] : []),
        "",
        `Next steps:`,
        `  1. Create a ${name}ModuleConfig ScriptableObject asset in Unity`,
        `  2. Add it to GameBootstrapper's module list`,
        `  3. Put ECS components in Scripts/Components/`,
        includeSystem
          ? `  4. Implement system logic in Scripts/Systems/${name}System.cs`
          : `  4. Add systems under Scripts/Systems/ when you need them`,
      ].join("\n");

      return { content: result, metadata: { createdFiles, keptFiles } };
    } catch {
      return { content: "Error: could not create module", isError: true };
    }
  }
}

/** What a module already holds, read before this tool writes anything. */
interface ModuleSources {
  /** Every file, module-relative with "/" separators, sorted. */
  files: string[];
  /** C# sources by module-relative path, comments stripped. */
  csharp: Map<string, string>;
  /** Every .asmdef and the assembly name it declares (null when unreadable). */
  assemblies: Array<{ rel: string; name: string | null }>;
}

async function readModuleSources(moduleRoot: string): Promise<ModuleSources> {
  const entries = await readdir(moduleRoot, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(moduleRoot, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  const read = (rel: string) => readFile(join(moduleRoot, ...rel.split("/")), "utf-8").catch(() => "");
  const csharp = new Map<string, string>();
  const assemblies: ModuleSources["assemblies"] = [];
  for (const rel of files) {
    if (/\.cs$/i.test(rel)) {
      csharp.set(rel, (await read(rel)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
    } else if (/\.asmdef$/i.test(rel)) {
      let assemblyName: string | null = null;
      try {
        const parsed = JSON.parse(await read(rel)) as { name?: unknown };
        if (typeof parsed.name === "string") assemblyName = parsed.name;
      } catch {
        // An unreadable .asmdef still owns its folder.
      }
      assemblies.push({ rel, name: assemblyName });
    }
  }
  return { files, csharp, assemblies };
}

/** The module file that already declares `type`: one named for it, or any C# source declaring it. */
function declarationOf(module: ModuleSources, type: string): string | null {
  const named = module.files.find((rel) => rel === `${type}.cs` || rel.endsWith(`/${type}.cs`));
  if (named) return named;
  const declares = new RegExp(`\\b(?:class|interface|struct|record|enum)\\s+${type}\\b`);
  for (const [rel, source] of module.csharp) {
    if (declares.test(source)) return rel;
  }
  return null;
}

/** The module-relative folder of a module-relative file; "" for the module root. */
function folderOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "" : rel.slice(0, slash);
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
