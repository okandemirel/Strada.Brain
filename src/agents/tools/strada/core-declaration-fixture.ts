/**
 * Stand-ins for the framework's folder declaration, for tests that need a
 * project with Strada.Core installed — in both of the shapes a Strada.Core
 * checkout can have.
 *
 * They are copies, so they can rot. `module-folders.test.ts` compares the one
 * matching the Strada.Core checked out beside this repo against it whenever
 * that checkout is there, and fails when the two disagree — which is the only
 * thing that keeps a fixture honest.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Deliberately not imported from module-folders.js: a suite that mocks that
// module would otherwise import it back through this file and deadlock.
const CONFIG_DIR = "Packages/Submodules/Strada.Core/Editor/ModuleGenerator/Config";
const DECLARATION_RELATIVE_PATH = `${CONFIG_DIR}/DirectoryStructureConfig.cs`;
const LAYOUT_RELATIVE_PATH = `${CONFIG_DIR}/ModuleLayout.cs`;

/**
 * The folder list as Strada.Core declared it before the list moved into
 * ModuleLayout.cs: literal entries in DirectoryStructureConfig.cs, with
 * Scripts/Commands and a Scripts/Signals of its own.
 */
export const CORE_DECLARATION_SOURCE = `
namespace Strada.Core.Editor.ModuleGenerator.Config
{
    public class DirectoryStructureConfig : ScriptableObject
    {
        [SerializeField] private List<FolderEntry> _folders = new List<FolderEntry>
        {
            new FolderEntry { Path = "Scripts", IsMandatory = true },
            new FolderEntry { Path = "Scripts/Interfaces", RequiredComponent = ComponentType.ServiceInterface },
            new FolderEntry { Path = "Scripts/Services", RequiredComponent = ComponentType.Service },
            new FolderEntry { Path = "Scripts/Controllers", RequiredComponent = ComponentType.Controller },
            new FolderEntry { Path = "Scripts/Commands", RequiredComponent = ComponentType.Commands },
            new FolderEntry { Path = "Scripts/Models", RequiredComponent = ComponentType.Model },
            new FolderEntry { Path = "Scripts/Views", RequiredComponent = ComponentType.View },
            new FolderEntry { Path = "Scripts/Systems", RequiredComponent = ComponentType.EcsSystem },
            new FolderEntry { Path = "Scripts/Components", RequiredComponent = ComponentType.EcsComponent },
            new FolderEntry { Path = "Scripts/Events", RequiredComponent = ComponentType.Events },
            new FolderEntry { Path = "Scripts/Signals", RequiredComponent = ComponentType.Signals },
            new FolderEntry { Path = "Scripts/Data/UnityObjects", RequiredComponent = ComponentType.ConfigData },
            new FolderEntry { Path = "Scripts/Data/ValueObjects", RequiredComponent = ComponentType.ValueObject },
            new FolderEntry { Path = "Scripts/Editor", RequiredComponent = ComponentType.EditorScripts },
            new FolderEntry { Path = "Tests/Runtime", RequiredComponent = ComponentType.RuntimeTests },
            new FolderEntry { Path = "Tests/Editor", RequiredComponent = ComponentType.EditorTests },
            new FolderEntry { Path = "Art/Models", IsOptional = true },
            new FolderEntry { Path = "Art/Textures", IsOptional = true },
            new FolderEntry { Path = "Art/Materials", IsOptional = true },
            new FolderEntry { Path = "Art/Prefabs", IsOptional = true },
            new FolderEntry { Path = "Prefabs", IsOptional = true },
            new FolderEntry { Path = "Resources", IsOptional = true },
            new FolderEntry { Path = "Scriptables", IsOptional = true },
            new FolderEntry { Path = "Settings", IsOptional = true },
            new FolderEntry { Path = "Sprites", IsOptional = true },
            new FolderEntry { Path = "Audio", IsOptional = true },
            new FolderEntry { Path = "Scenes", IsOptional = true },
        };
    }
}
`;

/**
 * The layout as Strada.Core declares it now (layout schema 2): the list lives in
 * `ModuleLayout.DefaultEntries()`, Commands is gone, and Signals file into the
 * Events folder through `ModuleLayout.FolderOwner`. Taken from the framework's
 * ModuleLayout.cs; IsSelected is kept because it is a second ComponentType
 * switch in the same file that must not be read as folder ownership.
 */
export const CORE_LAYOUT_SOURCE = `
using System;
using System.Collections.Generic;
using Strada.Core.Editor.ModuleGenerator.Models;

namespace Strada.Core.Editor.ModuleGenerator.Config
{
    public enum ComponentType
    {
        None = 0,
        ModuleConfig = 1,
        AssemblyDefinition = 2,
        ServiceInterface = 3,
        Service = 4,
        Controller = 5,
        // 6 is reserved: Commands. Removed in layout schema 2; never reuse the value.
        Model = 7,
        View = 8,
        EcsSystem = 9,
        EcsComponent = 10,
        EntityMediator = 11,
        ConfigData = 12,
        ValueObject = 13,
        Events = 14,
        Signals = 15,
        RuntimeTests = 16,
        EditorTests = 17,
        EditorScripts = 18
    }

    [Serializable]
    public class FolderEntry
    {
        public string Path;
        public bool IsMandatory;
        public bool IsOptional;
        public ComponentType RequiredComponent = ComponentType.None;

        public FolderEntry Clone() => new FolderEntry
        {
            Path = Path, IsMandatory = IsMandatory, IsOptional = IsOptional, RequiredComponent = RequiredComponent
        };
    }

    public static class ModuleLayout
    {
        public const int SchemaVersion = 2;
        public const int ReservedCommandsValue = 6;

        public static List<FolderEntry> DefaultEntries() => new List<FolderEntry>
        {
            new FolderEntry { Path = "Scripts", IsMandatory = true },
            new FolderEntry { Path = "Scripts/Interfaces", RequiredComponent = ComponentType.ServiceInterface },
            new FolderEntry { Path = "Scripts/Services", RequiredComponent = ComponentType.Service },
            new FolderEntry { Path = "Scripts/Controllers", RequiredComponent = ComponentType.Controller },
            new FolderEntry { Path = "Scripts/Models", RequiredComponent = ComponentType.Model },
            new FolderEntry { Path = "Scripts/Views", RequiredComponent = ComponentType.View },
            new FolderEntry { Path = "Scripts/Systems", RequiredComponent = ComponentType.EcsSystem },
            new FolderEntry { Path = "Scripts/Components", RequiredComponent = ComponentType.EcsComponent },
            // Events and signals are both messages; they share a folder.
            new FolderEntry { Path = "Scripts/Events", RequiredComponent = ComponentType.Events },
            new FolderEntry { Path = "Scripts/Data/UnityObjects", RequiredComponent = ComponentType.ConfigData },
            new FolderEntry { Path = "Scripts/Data/ValueObjects", RequiredComponent = ComponentType.ValueObject },
            new FolderEntry { Path = "Scripts/Editor", RequiredComponent = ComponentType.EditorScripts },

            new FolderEntry { Path = "Tests/Runtime", RequiredComponent = ComponentType.RuntimeTests },
            new FolderEntry { Path = "Tests/Editor", RequiredComponent = ComponentType.EditorTests },

            new FolderEntry { Path = "Art/Models", IsOptional = true },
            new FolderEntry { Path = "Art/Textures", IsOptional = true },
            new FolderEntry { Path = "Art/Materials", IsOptional = true },
            new FolderEntry { Path = "Art/Prefabs", IsOptional = true },
            new FolderEntry { Path = "Prefabs", IsOptional = true },
            new FolderEntry { Path = "Resources", IsOptional = true },
            new FolderEntry { Path = "Scriptables", IsOptional = true },
            new FolderEntry { Path = "Settings", IsOptional = true },
            new FolderEntry { Path = "Sprites", IsOptional = true },
            new FolderEntry { Path = "Audio", IsOptional = true },
            new FolderEntry { Path = "Scenes", IsOptional = true },
        };

        public static ComponentType FolderOwner(ComponentType type)
        {
            switch (type)
            {
                case ComponentType.Signals: return ComponentType.Events;
                case ComponentType.EntityMediator: return ComponentType.View;
                case ComponentType.ModuleConfig:
                case ComponentType.AssemblyDefinition:
                    return ComponentType.None;
                default: return type;
            }
        }

        public static bool IsSelected(ComponentSelection c, ComponentType type)
        {
            switch (type)
            {
                case ComponentType.ModuleConfig: return c.ModuleConfig;
                case ComponentType.Service: return c.Service;
                case ComponentType.Events: return c.Events;
                case ComponentType.Signals: return c.Signals;
                default: return false;
            }
        }
    }
}
`;

/** DirectoryStructureConfig.cs beside CORE_LAYOUT_SOURCE: it only calls the layout. */
export const CORE_LAYOUT_CONFIG_SOURCE = `
namespace Strada.Core.Editor.ModuleGenerator.Config
{
    public class DirectoryStructureConfig : ScriptableObject
    {
        [SerializeField] private int _schemaVersion;
        [SerializeField] private List<FolderEntry> _folders = ModuleLayout.DefaultEntries();
    }
}
`;

function install(projectPath: string, relativePath: string, source: string): void {
  const target = join(projectPath, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

/** Install the older declaration into a project, as such a Strada.Core checkout would. */
export function installCoreDeclaration(projectPath: string): void {
  install(projectPath, DECLARATION_RELATIVE_PATH, CORE_DECLARATION_SOURCE);
}

/**
 * Install the current layout as a Strada.Core checkout carries it: ModuleLayout.cs
 * and a DirectoryStructureConfig.cs that only refers to it. `withLayout: false`
 * leaves ModuleLayout.cs out — a framework that is plainly there but whose
 * layout cannot be read.
 */
export function installCoreLayout(projectPath: string, { withLayout = true } = {}): void {
  install(projectPath, DECLARATION_RELATIVE_PATH, CORE_LAYOUT_CONFIG_SOURCE);
  if (withLayout) install(projectPath, LAYOUT_RELATIVE_PATH, CORE_LAYOUT_SOURCE);
}
