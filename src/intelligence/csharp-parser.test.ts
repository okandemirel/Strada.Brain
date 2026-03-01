import { describe, it, expect } from "vitest";
import {
  parseCSharpFile,
  inheritsFrom,
  implementsInterface,
} from "./csharp-parser.js";

describe("parseCSharpFile", () => {
  it("returns empty result for files exceeding 1MB", () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    const result = parseCSharpFile(huge, "big.cs");
    expect(result.classes).toHaveLength(0);
    expect(result.structs).toHaveLength(0);
    expect(result.methods).toHaveLength(0);
    expect(result.usings).toHaveLength(0);
    expect(result.namespace).toBe("");
  });

  it("parses a complete C# file", () => {
    const code = `
using Strada.Core.ECS;
using UnityEngine;

namespace Game.Combat
{
    public class CombatSystem : SystemBase
    {
        public override void OnUpdate(float deltaTime)
        {
        }
    }
}`;
    const result = parseCSharpFile(code, "CombatSystem.cs");
    expect(result.filePath).toBe("CombatSystem.cs");
    expect(result.namespace).toBe("Game.Combat");
    expect(result.usings).toHaveLength(2);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]!.name).toBe("CombatSystem");
    expect(result.classes[0]!.baseClass).toBe("SystemBase");
  });
});

describe("extractUsings", () => {
  it("extracts using statements", () => {
    const code = `using System;\nusing System.Collections.Generic;\nusing UnityEngine;`;
    const result = parseCSharpFile(code, "t.cs");
    expect(result.usings).toHaveLength(3);
    expect(result.usings[0]!.namespace).toBe("System");
    expect(result.usings[1]!.namespace).toBe("System.Collections.Generic");
    expect(result.usings[2]!.namespace).toBe("UnityEngine");
  });

  it("returns empty for no usings", () => {
    const result = parseCSharpFile("class A {}", "t.cs");
    expect(result.usings).toHaveLength(0);
  });
});

describe("extractNamespace", () => {
  it("extracts block namespace", () => {
    const result = parseCSharpFile("namespace MyApp.Core {\n}", "t.cs");
    expect(result.namespace).toBe("MyApp.Core");
  });

  it("extracts file-scoped namespace", () => {
    const result = parseCSharpFile("namespace MyApp.Core;", "t.cs");
    expect(result.namespace).toBe("MyApp.Core");
  });

  it("returns empty when no namespace", () => {
    const result = parseCSharpFile("class A {}", "t.cs");
    expect(result.namespace).toBe("");
  });
});

describe("extractClasses", () => {
  it("extracts simple class", () => {
    const code = "public class Player {\n}";
    const result = parseCSharpFile(code, "Player.cs");
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]!.name).toBe("Player");
    expect(result.classes[0]!.isAbstract).toBe(false);
  });

  it("extracts abstract class", () => {
    const code = "public abstract class BaseSystem {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.classes[0]!.isAbstract).toBe(true);
    expect(result.classes[0]!.modifiers).toContain("abstract");
  });

  it("extracts static class", () => {
    const code = "public static class Utils {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.classes[0]!.isStatic).toBe(true);
  });

  it("extracts partial class", () => {
    const code = "public partial class Player {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.classes[0]!.isPartial).toBe(true);
  });

  it("extracts generic class", () => {
    const code = "public class Container<T, U> {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.classes[0]!.genericArgs).toEqual(["T", "U"]);
  });

  it("extracts class with inheritance and interfaces", () => {
    const code = "public class PlayerSystem : SystemBase, IDisposable {\n}";
    const result = parseCSharpFile(code, "t.cs");
    const cls = result.classes[0]!;
    expect(cls.baseClass).toBe("SystemBase");
    expect(cls.interfaces).toContain("IDisposable");
  });

  it("detects I-prefix as interface, not base class", () => {
    const code = "public class MyService : IService, IDisposable {\n}";
    const result = parseCSharpFile(code, "t.cs");
    const cls = result.classes[0]!;
    expect(cls.baseClass).toBeUndefined();
    expect(cls.interfaces).toContain("IService");
    expect(cls.interfaces).toContain("IDisposable");
  });

  it("calculates line numbers", () => {
    // The regex uses ^ with /m flag, so empty lines before the class
    // only count if the regex matches at a specific position.
    // The class regex starts matching from beginning of a line.
    const code = "// line1\n// line2\npublic class ThirdLine {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.classes[0]!.lineNumber).toBe(3);
  });
});

describe("extractStructs", () => {
  it("extracts struct with interface", () => {
    const code = "public struct Health : IComponent {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.structs).toHaveLength(1);
    expect(result.structs[0]!.name).toBe("Health");
    expect(result.structs[0]!.interfaces).toContain("IComponent");
  });

  it("detects readonly struct", () => {
    const code = "public readonly struct Velocity : IComponent {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.structs[0]!.isReadonly).toBe(true);
  });

  it("extracts struct without interfaces", () => {
    const code = "public struct Point {\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.structs[0]!.interfaces).toHaveLength(0);
  });
});

describe("extractMethods", () => {
  it("extracts public method", () => {
    const code = `class A {
    public void DoSomething(int x, string y)
    {
    }
}`;
    const result = parseCSharpFile(code, "t.cs");
    expect(result.methods).toHaveLength(1);
    expect(result.methods[0]!.name).toBe("DoSomething");
    expect(result.methods[0]!.returnType).toBe("void");
    expect(result.methods[0]!.parameters).toEqual(["int x", "string y"]);
  });

  it("extracts async method modifiers", () => {
    // The method regex captures modifier groups — "public override" is one capture group
    // but "async" gets captured as part of the remaining modifiers before return type.
    // The regex: (modifier\s+)* captures "public override async"
    const code = `class A {
    public async void ProcessAsync(CancellationToken ct)
    {
    }
}`;
    const result = parseCSharpFile(code, "t.cs");
    const method = result.methods[0]!;
    expect(method.modifiers).toContain("async");
    expect(method.name).toBe("ProcessAsync");
  });

  it("skips control flow keywords", () => {
    const code = `class A {
    public void Run()
    {
        if (x > 0) {}
        while (true) {}
        for (int i = 0; i < 10; i++) {}
        foreach (var item in list) {}
    }
}`;
    const result = parseCSharpFile(code, "t.cs");
    // Should only find Run, not if/while/for/foreach
    const names = result.methods.map((m) => m.name);
    expect(names).toContain("Run");
    expect(names).not.toContain("if");
    expect(names).not.toContain("while");
    expect(names).not.toContain("for");
    expect(names).not.toContain("foreach");
  });

  it("extracts method with no parameters", () => {
    const code = "class A {\n    public void Init()\n    {\n    }\n}";
    const result = parseCSharpFile(code, "t.cs");
    expect(result.methods[0]!.parameters).toEqual([]);
  });
});

describe("inheritsFrom", () => {
  it("returns true for matching base class", () => {
    const cls = {
      name: "CombatSystem",
      namespace: "Game",
      baseClass: "SystemBase",
      interfaces: [],
      genericArgs: [],
      isAbstract: false,
      isPartial: false,
      isStatic: false,
      modifiers: ["public"],
      filePath: "t.cs",
      lineNumber: 1,
    };
    expect(inheritsFrom(cls, "SystemBase")).toBe(true);
  });

  it("returns false for non-matching base class", () => {
    const cls = {
      name: "A", namespace: "X", baseClass: "B", interfaces: [],
      genericArgs: [], isAbstract: false, isPartial: false, isStatic: false,
      modifiers: [], filePath: "t.cs", lineNumber: 1,
    };
    expect(inheritsFrom(cls, "C")).toBe(false);
  });

  it("strips generic arguments from base class", () => {
    const cls = {
      name: "PlayerMediator", namespace: "Game", baseClass: "EntityMediator<PlayerView>",
      interfaces: [], genericArgs: [], isAbstract: false, isPartial: false,
      isStatic: false, modifiers: [], filePath: "t.cs", lineNumber: 1,
    };
    expect(inheritsFrom(cls, "EntityMediator")).toBe(true);
  });

  it("returns false when no base class", () => {
    const cls = {
      name: "A", namespace: "X", interfaces: [],
      genericArgs: [], isAbstract: false, isPartial: false, isStatic: false,
      modifiers: [], filePath: "t.cs", lineNumber: 1,
    };
    expect(inheritsFrom(cls, "Anything")).toBe(false);
  });
});

describe("implementsInterface", () => {
  it("returns true for matching interface", () => {
    expect(
      implementsInterface({ interfaces: ["IComponent", "IDisposable"] }, "IComponent")
    ).toBe(true);
  });

  it("returns false for non-matching interface", () => {
    expect(
      implementsInterface({ interfaces: ["IComponent"] }, "IDisposable")
    ).toBe(false);
  });

  it("strips generic arguments", () => {
    expect(
      implementsInterface({ interfaces: ["IService<Player>"] }, "IService")
    ).toBe(true);
  });

  it("returns false for empty interfaces", () => {
    expect(implementsInterface({ interfaces: [] }, "IComponent")).toBe(false);
  });
});
