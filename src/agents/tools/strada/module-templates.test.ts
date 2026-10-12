/**
 * Reading Strada.Core's module templates: the file is C#, and this reader runs
 * the part of C# it is written in. These tests hold the reader to the fixture
 * copy, the copy to the Strada.Core checked out beside this repo, and — opted in
 * with STRADA_TEMPLATE_GROUND_TRUTH=1 — the reader to the C# compiler itself.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { CORE_TEMPLATES_SOURCE } from "./core-templates-fixture.js";
import { installCoreTemplates } from "./core-declaration-fixture.js";
import { parseModuleSourceTemplates, readTemplatesAt, TEMPLATE_DECLARATION_FILE } from "./module-templates.js";

const CORE_PATH_FROM_ENV = process.env["STRADA_CORE_PATH"]?.trim() || undefined;
const CORE_ROOT = CORE_PATH_FROM_ENV ?? join(process.cwd(), "..", "Strada.Core");
const CORE_PACKAGE = "Packages/Submodules/Strada.Core";

const OPTION_FIELDS = [
  "ModuleConfig", "ServiceInterface", "Service", "Controller", "Model", "View", "EcsSystem", "EcsComponent",
  "EntityMediator", "ConfigData", "ValueObject", "Events", "Signals", "RuntimeTests", "EditorTests", "Summaries",
];

const fixture = () => parseModuleSourceTemplates(CORE_TEMPLATES_SOURCE, "fixture");

/** Option bit i is OPTION_FIELDS[i], the constructor's parameter order. */
const selectionOf = (mask: number) => Object.fromEntries(OPTION_FIELDS.map((f, bit) => [f, (mask & (1 << bit)) !== 0]));

function unreadable(source: string): string {
  const root = mkdtempSync(join(os.tmpdir(), "module-templates-"));
  installCoreTemplates(root, source);
  const lookup = readTemplatesAt(join(root, CORE_PACKAGE));
  expect(lookup.status).toBe("unreadable");
  return lookup.status === "unreadable" ? lookup.reason : "";
}

describe("reading ModuleSourceTemplates.cs", () => {
  it("reads the option fields off ModuleTemplateOptions' constructor", () => {
    expect(fixture().options).toEqual(OPTION_FIELDS);
  });

  it("runs Files(): the files a selection produces, in Core's order, with Core's text", () => {
    const files = fixture().render("Harbor", "Game.Modules.Harbor", {
      ModuleConfig: true, ServiceInterface: true, Service: true, ConfigData: true, ValueObject: true,
    });
    expect(files.map((f) => [f.component, f.fileName])).toEqual([
      ["ModuleConfig", "HarborModuleConfig.cs"],
      ["ServiceInterface", "IHarborService.cs"],
      ["Service", "HarborService.cs"],
      ["ConfigData", "CD_Harbor.cs"],
      ["ValueObject", "HarborConfig.cs"],
    ]);
    expect(files[0]!.source).toBe(
      [
        "using UnityEngine;",
        "using Strada.Core.DI;",
        "using Strada.Core.Modules;",
        "using Strada.Core.Patterns;",
        "",
        "namespace Game.Modules.Harbor",
        "{",
        "    /// <summary>",
        "    /// Module configuration for Harbor.",
        "    /// </summary>",
        '    [CreateAssetMenu(fileName = "HarborModuleConfig", menuName = "Harbor/Module Config")]',
        "    public class HarborModuleConfig : ModuleConfig",
        "    {",
        "        protected override void Configure(IModuleBuilder builder)",
        "        {",
        "            builder.RegisterService<IHarborService, HarborService>();",
        "        }",
        "",
        "        /// <summary>",
        "        /// Hands the module's controllers and services to the bootstrapper's PatternManager,",
        "        /// which initializes them after every module is installed, ticks them each frame and",
        "        /// disposes them at shutdown.",
        "        /// </summary>",
        "        public override void Initialize(IServiceLocator services)",
        "        {",
        "            var patterns = services.Get<PatternManager>();",
        "            patterns.RegisterService(services.Get<IHarborService>());",
        "        }",
        "",
        "        public override void Shutdown()",
        "        {",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("takes an unset option at Core's default: summaries on, the rest off", () => {
    const [config] = fixture().render("Harbor", "Game.Modules.Harbor", { ModuleConfig: true });
    expect(config!.source).toContain("/// Module configuration for Harbor.");
    expect(config!.source).not.toContain("RegisterService");
    expect(config!.source).not.toContain("PatternManager>()");
    const [plain] = fixture().render("Harbor", "Game.Modules.Harbor", { ModuleConfig: true, Summaries: false });
    expect(plain!.source).not.toContain("/// Module configuration");
  });

  it("calls a Core without the file absent, not unreadable", () => {
    const root = mkdtempSync(join(os.tmpdir(), "module-templates-absent-"));
    expect(readTemplatesAt(root)).toEqual({ status: "absent" });
  });
});

describe("a template file this reader cannot follow is unreadable, with the reason", () => {
  it("a construct outside the part of C# it reads", () => {
    const reason = unreadable(
      CORE_TEMPLATES_SOURCE.replace("var files = new List<GeneratedFile>(16);", "var files = new List<GeneratedFile>(16);\n switch (name) { }"),
    );
    expect(reason).toContain(TEMPLATE_DECLARATION_FILE);
    expect(reason).toMatch(/switch/);
  });

  it("a call on a value it does not model, found when the file is read", () => {
    // Only the Controller selection reaches it: the read renders every option
    // alone, so it is caught before a module is half written.
    const reason = unreadable(
      CORE_TEMPLATES_SOURCE.replace(
        'sb.AppendLine($"    public class {name}Controller : TickableController");',
        'sb.AppendLine($"    public class {name}Controller : TickableController"); sb.Clear();',
      ),
    );
    expect(reason).toMatch(/Clear/);
  });

  it("no Files() at all", () => {
    expect(unreadable(CORE_TEMPLATES_SOURCE.replace("Files(string name", "AllFiles(string name"))).toMatch(/Files/);
  });

  // A name it cannot resolve used to become a value whose printed form was its
  // last segment, so the file read as declared and wrote that word into the
  // module: `Indentpublic interface ...`, `Empty`, `NewLine`.
  const withServiceLine = (replacement: string): string => {
    const edited = CORE_TEMPLATES_SOURCE.replace(
      'sb.AppendLine($"    public interface I{name}Service : IService");',
      replacement,
    );
    expect(edited).not.toBe(CORE_TEMPLATES_SOURCE);
    return edited;
  };

  it("a class-level constant it does not read", () => {
    const source = withServiceLine('sb.AppendLine($"{Indent}public interface I{name}Service : IService");').replace(
      "public static class ModuleSourceTemplates\n    {",
      'public static class ModuleSourceTemplates\n    {\n        private const string Indent = "    ";',
    );
    expect(unreadable(source)).toMatch(/Indent/);
  });

  it("a framework member it does not model: string.Empty", () => {
    expect(
      unreadable(withServiceLine('sb.AppendLine(string.Empty); sb.AppendLine($"    public interface I{name}Service : IService");')),
    ).toMatch(/string\.Empty/);
  });

  it("a framework type it does not model: Environment.NewLine", () => {
    expect(
      unreadable(withServiceLine('sb.Append($"    public interface I{name}Service : IService{Environment.NewLine}");')),
    ).toMatch(/Environment/);
  });

  it("a comparison of values it does not model, which it would answer by identity", () => {
    // Two reads of the same enum member are different objects here: == was
    // always false, so the branch silently never ran.
    const source = CORE_TEMPLATES_SOURCE.replace(
      "if (enabled) files.Add(new GeneratedFile(component, fileName, source()));",
      "if (enabled && component != Config.ComponentType.Events) files.Add(new GeneratedFile(component, fileName, source()));",
    );
    expect(source).not.toBe(CORE_TEMPLATES_SOURCE);
    expect(unreadable(source)).toMatch(/ComponentType/);
  });

  it("a list built from another, which it would have made empty", () => {
    const source = CORE_TEMPLATES_SOURCE.replace(
      "foreach (var u in usings)",
      "foreach (var u in new List<string>(usings))",
    );
    expect(source).not.toBe(CORE_TEMPLATES_SOURCE);
    expect(unreadable(source)).toMatch(/List<string>/);
  });
});

describe("a selection names only options Core declares", () => {
  it("refuses a field ModuleTemplateOptions does not have, instead of rendering without it", () => {
    // Core renaming EcsSystem would otherwise make include_system write nothing
    // and say nothing.
    expect(() => fixture().render("Harbor", "Game.Modules.Harbor", { ModuleConfig: true, Systems: true })).toThrow(
      /Systems/,
    );
  });

  it("a file that would never finish", () => {
    const looping = CORE_TEMPLATES_SOURCE.replace(
      "foreach (var u in usings)\n                sb.AppendLine(u);",
      "var grow = new List<string> { \"x\" };\n            foreach (var g in grow) grow.Add(g);",
    );
    expect(looping).not.toBe(CORE_TEMPLATES_SOURCE);
    expect(unreadable(looping)).toMatch(/runs longer/);

    const recursing = CORE_TEMPLATES_SOURCE.replace(
      "var sb = new StringBuilder();",
      "var sb = new StringBuilder(); Wrap(ns, usings, writeBody);",
    );
    expect(recursing).not.toBe(CORE_TEMPLATES_SOURCE);
    expect(unreadable(recursing)).toMatch(/nest deeper/);
  });
});

describe("the real Strada.Core templates", () => {
  const available = existsSync(join(CORE_ROOT, TEMPLATE_DECLARATION_FILE));
  const lookup = available ? readTemplatesAt(CORE_ROOT) : null;

  // Skipping is for machines without a checkout. A run that named one and does
  // not have it is misconfigured, and must say so instead of passing silently.
  it.runIf(CORE_PATH_FROM_ENV !== undefined)("finds them in the checkout STRADA_CORE_PATH names", () => {
    expect(available, `${join(CORE_ROOT, TEMPLATE_DECLARATION_FILE)} does not exist`).toBe(true);
  });

  it.skipIf(!available)("are read", () => {
    expect(lookup?.status, lookup?.status === "unreadable" ? lookup.reason : undefined).toBe("declared");
  });

  it.skipIf(!available)("agree with the fixture copy the tests build projects from", () => {
    // A fixture is a copy, and a copy rots. Rendered for every option alone,
    // all of them, none, and a spread between, the two must write the same files.
    expect(lookup?.status).toBe("declared");
    if (lookup?.status !== "declared") return;
    const masks = [0, 0xffff, ...OPTION_FIELDS.map((_, bit) => 1 << bit), ...OPTION_FIELDS.map((_, bit) => 0xffff & ~(1 << bit))];
    for (let m = 0x1357; masks.length < 200; m = (m * 7919 + 104_729) % 0x10000) masks.push(m);
    for (const mask of masks) {
      expect(lookup.templates.render("Harbor", "Game.Modules.Harbor", selectionOf(mask)), `selection ${mask}`).toEqual(
        fixture().render("Harbor", "Game.Modules.Harbor", selectionOf(mask)),
      );
    }
  });
});

describe.runIf(process.env["STRADA_TEMPLATE_GROUND_TRUTH"] === "1")("the reader against the C# compiler", () => {
  // Compiles Core's own ModuleSourceTemplates.cs with dotnet, runs Files() for
  // a few hundred selections, and compares every file with what this reader
  // renders from the same source. Needs dotnet and the Strada.Core checkout.
  it("renders what Core's own code renders", { timeout: 240_000 }, () => {
    expect(existsSync(join(CORE_ROOT, TEMPLATE_DECLARATION_FILE)), `${CORE_ROOT} has no templates`).toBe(true);
    const sdk = execFileSync("dotnet", ["--version"]).toString().trim();
    const dir = mkdtempSync(join(os.tmpdir(), "module-templates-dotnet-"));
    writeFileSync(
      join(dir, "Dump.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net${sdk.split(".")[0]}.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${CORE_ROOT}/Editor/ModuleGenerator/Templates/ModuleSourceTemplates.cs" />
    <Compile Include="${CORE_ROOT}/Editor/ModuleGenerator/Models/ModuleDefinition.cs" />
    <Compile Include="${CORE_ROOT}/Editor/ModuleGenerator/Config/ModuleLayout.cs" />
    <Compile Include="Program.cs" />
  </ItemGroup>
</Project>
`,
    );
    writeFileSync(
      join(dir, "Program.cs"),
      `using System;
using System.Text;
using Strada.Core.Editor.ModuleGenerator.Templates;

static class Program
{
    static string Esc(string s) => s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\n", "\\\\n").Replace("\\r", "\\\\r").Replace("\\t", "\\\\t");

    static void Main(string[] args)
    {
        var json = new StringBuilder("[");
        for (int i = 0; i < args.Length; i++)
        {
            var mask = int.Parse(args[i]);
            bool B(int bit) => (mask & (1 << bit)) != 0;
            var o = new ModuleTemplateOptions(B(0), B(1), B(2), B(3), B(4), B(5), B(6), B(7), B(8), B(9), B(10), B(11), B(12), B(13), B(14), B(15));
            json.Append(i == 0 ? "[" : ",[");
            var first = true;
            foreach (var f in ModuleSourceTemplates.Files("Harbor", "Game.Modules.Harbor", o))
            {
                json.Append(first ? "" : ",");
                first = false;
                json.Append("{\\"component\\":\\"" + f.Component + "\\",\\"fileName\\":\\"" + Esc(f.FileName) + "\\",\\"source\\":\\"" + Esc(f.Source) + "\\"}");
            }
            json.Append("]");
        }
        Console.Out.Write(json.Append("]").ToString());
    }
}
`,
    );
    execFileSync("dotnet", ["build", join(dir, "Dump.csproj"), "-nologo", "-v", "q", "-o", join(dir, "out")], { stdio: "pipe" });

    const lookup = readTemplatesAt(CORE_ROOT);
    expect(lookup.status).toBe("declared");
    if (lookup.status !== "declared") return;
    const masks = [0, 0xffff, ...OPTION_FIELDS.map((_, bit) => 1 << bit)];
    for (let m = 0x2468; masks.length < 400; m = (m * 7919 + 104_729) % 0x10000) masks.push(m);
    const truth = JSON.parse(
      execFileSync("dotnet", [join(dir, "out", "Dump.dll"), ...masks.map(String)], { maxBuffer: 1 << 28 }).toString(),
    ) as Array<Array<{ component: string; fileName: string; source: string }>>;
    masks.forEach((mask, k) => {
      expect(lookup.templates.render("Harbor", "Game.Modules.Harbor", selectionOf(mask)), `selection ${mask}`).toEqual(truth[k]);
    });
  });
});
