/**
 * The declaration these tests parse is the real one: the file is read from the
 * Strada.Core checked out beside this repo when it is there, so a change to the
 * framework's structure shows up here rather than silently diverging.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import os from "node:os";
import {
  CORE_DECLARATION_SOURCE,
  CORE_LAYOUT_SOURCE,
  installCoreDeclaration,
  installCoreLayout,
} from "./core-declaration-fixture.js";
import {
  parseDeclaredFolders,
  parseFolderOwners,
  foldersForModule,
  folderForComponent,
  optionalFolderPaths,
  describeFrameworkInstall,
  readDeclaredModuleFolders,
  readLayoutAt,
  readModuleLayout,
  declarationPathFor,
  CORE_INSTALL_PATH,
  LAYOUT_DECLARATION_FILES,
} from "./module-folders.js";

// STRADA_CORE_PATH names the checkout explicitly (CI clones it elsewhere, so
// the sibling path never existed there and these tests always skipped, OPS-11).
const CORE_PATH_FROM_ENV = process.env["STRADA_CORE_PATH"]?.trim() || undefined;
const CORE_ROOT = CORE_PATH_FROM_ENV ?? join(process.cwd(), "..", "Strada.Core");

const tempProject = (tag: string) => mkdtempSync(join(os.tmpdir(), `module-folders-${tag}-`));
const OLDER_DECLARATION = LAYOUT_DECLARATION_FILES.find((f) => f.endsWith("DirectoryStructureConfig.cs"))!;
const LAYOUT_DECLARATION = LAYOUT_DECLARATION_FILES.find((f) => f.endsWith("ModuleLayout.cs"))!;

const SAMPLE = `
        [SerializeField] private List<FolderEntry> _folders = new List<FolderEntry>
        {
            new FolderEntry { Path = "Scripts", IsMandatory = true },
            new FolderEntry { Path = "Scripts/Services", RequiredComponent = ComponentType.Service },
            new FolderEntry { Path = "Scripts/Editor", RequiredComponent = ComponentType.EditorScripts },
            new FolderEntry { Path = "Tests/Runtime", RequiredComponent = ComponentType.RuntimeTests },
            new FolderEntry { Path = "Art/Models", IsOptional = true },
            new FolderEntry { Path = "Art/Textures", IsOptional = true },
            new FolderEntry { Path = "Prefabs", IsOptional = true },
        };
`;

describe("reading the declared module structure", () => {
  it("reads path, mandatory, optional and component off each entry", () => {
    const folders = parseDeclaredFolders(SAMPLE);

    expect(folders).toHaveLength(7);
    expect(folders[0]).toEqual({
      path: "Scripts",
      mandatory: true,
      optional: false,
      component: null,
    });
    expect(folders[1]).toEqual({
      path: "Scripts/Services",
      mandatory: false,
      optional: false,
      component: "Service",
    });
    expect(folders[4]).toEqual({
      path: "Art/Models",
      mandatory: false,
      optional: true,
      component: null,
    });
  });

  it("ignores fields it does not know about", () => {
    // The framework must be free to add to an entry without breaking this.
    const folders = parseDeclaredFolders(
      `new FolderEntry { Path = "Scripts/Widgets", RequiredComponent = ComponentType.Widget, SomethingNew = 3 }`,
    );
    expect(folders).toEqual([
      { path: "Scripts/Widgets", mandatory: false, optional: false, component: "Widget" },
    ]);
  });

  it("treats ComponentType.None as no component", () => {
    const folders = parseDeclaredFolders(
      `new FolderEntry { Path = "Misc", RequiredComponent = ComponentType.None, IsOptional = true }`,
    );
    expect(folders[0]?.component).toBeNull();
  });

  it("returns null when the framework is not installed", () => {
    // Not a licence to guess: a module whose shape the framework never agreed
    // to is the failure this reader exists to prevent.
    const empty = mkdtempSync(join(os.tmpdir(), "module-folders-none-"));
    expect(readDeclaredModuleFolders(empty)).toBeNull();
  });

  it("reads the declaration out of an installed Strada.Core", () => {
    const projectPath = tempProject("installed");
    const target = join(projectPath, CORE_INSTALL_PATH, OLDER_DECLARATION);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, SAMPLE);

    const folders = readDeclaredModuleFolders(projectPath);
    expect(folders?.map((f) => f.path)).toContain("Scripts/Services");
  });
});

describe("where an installed Strada.Core declares its layout", () => {
  // The framework moved the list from literal entries in
  // DirectoryStructureConfig.cs to ModuleLayout.DefaultEntries(), leaving the
  // config with only a call to it. A reader of the old file alone found nothing
  // in a framework that was plainly installed.

  it("reads ModuleLayout.cs when the config only refers to it", () => {
    const projectPath = tempProject("layout");
    installCoreLayout(projectPath);

    const paths = readDeclaredModuleFolders(projectPath)?.map((f) => f.path);
    expect(paths).toHaveLength(25);
    expect(paths).toContain("Scripts/Events");
    expect(paths).not.toContain("Scripts/Signals");
    expect(paths).not.toContain("Scripts/Commands");
  });

  it("still reads the literal list of an older Strada.Core", () => {
    const projectPath = tempProject("older");
    installCoreDeclaration(projectPath);

    const paths = readDeclaredModuleFolders(projectPath)?.map((f) => f.path);
    expect(paths).toHaveLength(27);
    expect(paths).toContain("Scripts/Signals");
  });

  it("names the file it read the layout from", () => {
    const current = tempProject("layout-path");
    installCoreLayout(current);
    expect(declarationPathFor(current)).toBe(join(current, CORE_INSTALL_PATH, LAYOUT_DECLARATION));

    const older = tempProject("older-path");
    installCoreDeclaration(older);
    expect(declarationPathFor(older)).toBe(join(older, CORE_INSTALL_PATH, OLDER_DECLARATION));

    expect(declarationPathFor(tempProject("none-path"))).toBeNull();
  });

  it("takes the first file that lists folders, newest home first", () => {
    // A checkout mid-move may carry both; the layout table is the one the
    // framework's generator builds from.
    const projectPath = tempProject("both");
    installCoreDeclaration(projectPath);
    const layoutFile = join(projectPath, CORE_INSTALL_PATH, LAYOUT_DECLARATION);
    mkdirSync(dirname(layoutFile), { recursive: true });
    writeFileSync(layoutFile, CORE_LAYOUT_SOURCE);

    const paths = readDeclaredModuleFolders(projectPath)?.map((f) => f.path);
    expect(paths).toContain("Scripts/Events");
    expect(paths).not.toContain("Scripts/Signals");
  });

  it("tells a missing framework apart from a layout it cannot read", () => {
    expect(readModuleLayout(tempProject("absent")).status).toBe("not-installed");

    const projectPath = tempProject("unreadable");
    installCoreLayout(projectPath, { withLayout: false });
    const lookup = readModuleLayout(projectPath);
    expect(lookup.status).toBe("unreadable");
    // Says which files it looked in and what was wrong with each.
    const reason = lookup.status === "unreadable" ? lookup.reason : "";
    expect(reason).toMatch(/ModuleLayout\.cs: not found/);
    expect(reason).toMatch(/DirectoryStructureConfig\.cs: lists no folder entries/);
  });
});

describe("who files into whose folder", () => {
  const current = { folders: parseDeclaredFolders(CORE_LAYOUT_SOURCE), folderOwners: parseFolderOwners(CORE_LAYOUT_SOURCE) };
  const older = { folders: parseDeclaredFolders(CORE_DECLARATION_SOURCE), folderOwners: parseFolderOwners(CORE_DECLARATION_SOURCE) };

  it("reads FolderOwner, and only FolderOwner", () => {
    // IsSelected in the same file is a ComponentType switch too; it says what
    // is selected, not where anything goes.
    expect([...current.folderOwners].sort()).toEqual([
      ["AssemblyDefinition", null],
      ["EntityMediator", "View"],
      ["ModuleConfig", null],
      ["Signals", "Events"],
    ]);
    expect(older.folderOwners.size).toBe(0);
  });

  it("gives a component the folder its owner declares", () => {
    expect(folderForComponent(current, "Signals")).toBe("Scripts/Events");
    expect(folderForComponent(older, "Signals")).toBe("Scripts/Signals");
    // FolderOwner sends the module's own config to the code root.
    expect(folderForComponent(current, "ModuleConfig")).toBe("Scripts");
  });

  it("has no folder for a component the layout no longer declares", () => {
    expect(folderForComponent(current, "Commands")).toBeNull();
    expect(folderForComponent(older, "Commands")).toBe("Scripts/Commands");
  });

  it("creates the owner's folder for a component that shares it", () => {
    const chosen = foldersForModule(current.folders, new Set(["Signals"]), [], current.folderOwners);
    expect(chosen).toEqual(["Scripts", "Scripts/Events"]);
  });
});

describe("choosing a module's folders", () => {
  const declared = parseDeclaredFolders(SAMPLE);

  it("always creates the mandatory ones", () => {
    expect(foldersForModule(declared, new Set())).toEqual(["Scripts"]);
  });

  it("creates a component's folder only when that component was selected", () => {
    expect(foldersForModule(declared, new Set(["Service"]))).toEqual(["Scripts", "Scripts/Services"]);
  });

  it("leaves optional folders out unless they are asked for", () => {
    const chosen = foldersForModule(declared, new Set(["Service"]));
    expect(chosen).not.toContain("Prefabs");
    expect(chosen).not.toContain("Art/Models");
  });

  it("creates an optional folder that was asked for", () => {
    expect(foldersForModule(declared, new Set(), ["Prefabs"])).toContain("Prefabs");
  });

  it("takes a parent folder to mean everything declared beneath it", () => {
    // An author asks for "Art", not for four separate subfolders.
    const chosen = foldersForModule(declared, new Set(), ["Art"]);
    expect(chosen).toContain("Art/Models");
    expect(chosen).toContain("Art/Textures");
  });

  it("tolerates a trailing slash the way an author would write it", () => {
    expect(foldersForModule(declared, new Set(), ["Art/"])).toContain("Art/Models");
  });

  it("lists the optional folders an author may ask for", () => {
    expect(optionalFolderPaths(declared)).toEqual(["Art/Models", "Art/Textures", "Prefabs"]);
  });
});

describe("the real Strada.Core declaration", () => {
  // Resolved exactly as a project's install is, so this passes against a
  // Strada.Core of either shape and fails when the reader cannot follow it.
  const available = existsSync(CORE_ROOT);
  const lookup = available ? readLayoutAt(CORE_ROOT) : null;
  const layout = lookup?.status === "declared" ? lookup.layout : null;

  // Skipping is for machines without a checkout. A run that named one and does
  // not have it is misconfigured, and must say so instead of passing silently.
  it.runIf(CORE_PATH_FROM_ENV !== undefined)("finds the checkout STRADA_CORE_PATH names", () => {
    expect(available, `${CORE_ROOT} does not exist`).toBe(true);
  });

  it.skipIf(!available)("declares its layout where this reader looks", () => {
    expect(lookup?.status, lookup?.status === "unreadable" ? lookup.reason : undefined).toBe("declared");
  });

  it.skipIf(!available)("parses, and declares Scripts mandatory", () => {
    expect(layout?.folders.length).toBeGreaterThan(10);
    expect(layout?.folders.find((f) => f.path === "Scripts")?.mandatory).toBe(true);
  });

  it.skipIf(!available)("keeps code under Scripts and authored assets at the root", () => {
    // The line the structure is built on. If the framework moves it, this test
    // is where the agent's generator finds out.
    const byPath = new Map((layout?.folders ?? []).map((f) => [f.path, f]));

    for (const code of ["Scripts/Services", "Scripts/Systems", "Scripts/Editor"]) {
      expect(byPath.has(code), `${code} not declared`).toBe(true);
    }
    for (const asset of ["Prefabs", "Resources", "Art/Models"]) {
      expect(byPath.get(asset)?.optional, `${asset} not declared as an optional root folder`).toBe(
        true,
      );
    }
  });

  it.skipIf(!available)("agrees with the fixture the tests build projects from", () => {
    // A fixture is a copy, and a copy rots. This is the only thing that tells us
    // when it has: every folder the framework declares must appear in the
    // fixture of the same shape with the same rule, nothing extra may be
    // invented, and the same components must share the same folders.
    expect(layout, "no declared layout to compare").not.toBeNull();
    const fixtureSource =
      basename(layout!.file) === basename(LAYOUT_DECLARATION) ? CORE_LAYOUT_SOURCE : CORE_DECLARATION_SOURCE;
    const fixture = parseDeclaredFolders(fixtureSource);

    const shape = (f: ReturnType<typeof parseDeclaredFolders>[number]) =>
      `${f.path}|${f.mandatory}|${f.optional}|${f.component ?? "-"}`;

    expect(fixture.map(shape).sort()).toEqual(layout!.folders.map(shape).sort());
    expect([...parseFolderOwners(fixtureSource)].sort()).toEqual([...layout!.folderOwners].sort());
  });
});

describe("describeFrameworkInstall — the runtime says what the project is", () => {
  // Measured 2026-08-23: a run given an empty Strada Unity skeleton built a
  // vanilla dotnet project beside the framework because nothing at startup
  // said the framework was there.

  it("announces the framework when its layout can be read", () => {
    for (const install of [installCoreLayout, installCoreDeclaration]) {
      const projectPath = tempProject("notice");
      install(projectPath);
      const msg = describeFrameworkInstall(projectPath);
      expect(msg).toContain("Strada.Core framework detected");
      expect(msg).toContain("strada_create_");
    }
  });

  it("does not announce a framework whose layout strada_create_module cannot read", () => {
    // The notice and the tool must agree: "detected" at startup followed by a
    // refusal from the tool is the contradiction a run cannot act on.
    const projectPath = tempProject("notice-unreadable");
    installCoreLayout(projectPath, { withLayout: false });
    const msg = describeFrameworkInstall(projectPath);
    expect(msg).not.toContain("detected");
    expect(msg).toContain("module layout could not be read");
    expect(msg).toContain("ModuleLayout.cs");
  });

  it("reports absence without a framework directory", () => {
    expect(describeFrameworkInstall(tempProject("notice-plain"))).toContain("No Strada.Core");
  });

  it("is silent without a configured Unity project", () => {
    expect(describeFrameworkInstall(undefined)).toBeNull();
  });
});
