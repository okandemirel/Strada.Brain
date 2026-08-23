/**
 * The declaration these tests parse is the real one: the file is read from the
 * Strada.Core checked out beside this repo when it is there, so a change to the
 * framework's structure shows up here rather than silently diverging.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { CORE_DECLARATION_SOURCE } from "./core-declaration-fixture.js";
import {
  parseDeclaredFolders,
  foldersForModule,
  optionalFolderPaths,
  describeFrameworkInstall,
  readDeclaredModuleFolders,
  declarationPathFor,
} from "./module-folders.js";

const SIBLING_DECLARATION = join(
  process.cwd(),
  "..",
  "Strada.Core",
  "Editor/ModuleGenerator/Config/DirectoryStructureConfig.cs",
);

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
    const projectPath = mkdtempSync(join(os.tmpdir(), "module-folders-installed-"));
    const target = declarationPathFor(projectPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, SAMPLE);

    const folders = readDeclaredModuleFolders(projectPath);
    expect(folders?.map((f) => f.path)).toContain("Scripts/Services");
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
  const available = existsSync(SIBLING_DECLARATION);

  it.skipIf(!available)("parses, and declares Scripts mandatory", () => {
    const folders = parseDeclaredFolders(readFileSync(SIBLING_DECLARATION, "utf-8"));

    expect(folders.length).toBeGreaterThan(10);
    expect(folders.find((f) => f.path === "Scripts")?.mandatory).toBe(true);
  });

  it.skipIf(!available)("keeps code under Scripts and authored assets at the root", () => {
    // The line the structure is built on. If the framework moves it, this test
    // is where the agent's generator finds out.
    const folders = parseDeclaredFolders(readFileSync(SIBLING_DECLARATION, "utf-8"));
    const byPath = new Map(folders.map((f) => [f.path, f]));

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
    // fixture with the same rule, and nothing extra may be invented.
    const real = parseDeclaredFolders(readFileSync(SIBLING_DECLARATION, "utf-8"));
    const fixture = parseDeclaredFolders(CORE_DECLARATION_SOURCE);

    const shape = (f: ReturnType<typeof parseDeclaredFolders>[number]) =>
      `${f.path}|${f.mandatory}|${f.optional}|${f.component ?? "-"}`;

    expect(fixture.map(shape).sort()).toEqual(real.map(shape).sort());
  });
});

describe("describeFrameworkInstall — the runtime says what the project is", () => {
  // Measured 2026-08-23: a run given an empty Strada Unity skeleton built a
  // vanilla dotnet project beside the framework because nothing at startup
  // said the framework was there.
  const yes = () => true;
  const no = () => false;

  it("announces the framework when the declaration exists", () => {
    const msg = describeFrameworkInstall("/proj", yes);
    expect(msg).toContain("Strada.Core framework detected");
    expect(msg).toContain("strada_create_");
  });

  it("names the missing declaration when only the directory exists", () => {
    const msg = describeFrameworkInstall("/proj", (p) => !p.includes("DirectoryStructureConfig"));
    expect(msg).toContain("module structure declaration");
  });

  it("reports absence without a framework directory", () => {
    expect(describeFrameworkInstall("/plain", no)).toContain("No Strada.Core");
  });

  it("is silent without a configured Unity project", () => {
    expect(describeFrameworkInstall(undefined)).toBeNull();
  });
});
