/**
 * A stand-in for the framework's folder declaration, for tests that need a
 * project with Strada.Core installed.
 *
 * It is a copy, so it can rot. `module-folders.test.ts` compares it against the
 * Strada.Core checked out beside this repo whenever that checkout is there, and
 * fails when the two disagree — which is the only thing that keeps a fixture
 * honest.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Deliberately not imported from module-folders.js: a suite that mocks that
// module would otherwise import it back through this file and deadlock.
const DECLARATION_RELATIVE_PATH =
  "Packages/Submodules/Strada.Core/Editor/ModuleGenerator/Config/DirectoryStructureConfig.cs";

/** The folder list as Strada.Core declares it. */
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

/** Install the declaration into a project, as a Strada.Core checkout would. */
export function installCoreDeclaration(projectPath: string): void {
  const target = join(projectPath, ...DECLARATION_RELATIVE_PATH.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, CORE_DECLARATION_SOURCE);
}
