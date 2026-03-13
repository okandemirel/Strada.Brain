import { describe, it, expect } from "vitest";
import {
  parseDeep,
  getClasses,
  getStructs,
  getInterfaces,
  getEnums,
  getMethods,
  getConstructors,
  getFields,
  getProperties,
  getDependencies,
  deepInheritsFrom,
  deepImplements,
  flattenTypes,
} from "./csharp-deep-parser.js";

describe("parseDeep", () => {
  it("returns empty AST for oversized files", () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    const ast = parseDeep(huge, "big.cs");
    expect(ast.usings).toHaveLength(0);
    expect(ast.namespaces).toHaveLength(0);
    expect(ast.types).toHaveLength(0);
  });

  it("parses using directives", () => {
    const code = `
using System;
using System.Collections.Generic;
using UnityEngine;
`;
    const ast = parseDeep(code, "t.cs");
    expect(ast.usings).toHaveLength(3);
    expect(ast.usings[0]!.namespace).toBe("System");
    expect(ast.usings[1]!.namespace).toBe("System.Collections.Generic");
    expect(ast.usings[2]!.namespace).toBe("UnityEngine");
  });

  it("parses using static", () => {
    const code = `using static System.Math;`;
    const ast = parseDeep(code, "t.cs");
    expect(ast.usings[0]!.isStatic).toBe(true);
    expect(ast.usings[0]!.namespace).toBe("System.Math");
  });

  it("parses using alias", () => {
    const code = `using Vec3 = UnityEngine.Vector3;`;
    const ast = parseDeep(code, "t.cs");
    expect(ast.usings[0]!.alias).toBe("Vec3");
    expect(ast.usings[0]!.namespace).toBe("UnityEngine.Vector3");
  });
});

describe("namespace parsing", () => {
  it("parses block namespace", () => {
    const code = `
namespace Game.Combat
{
    public class DamageSystem { }
}`;
    const ast = parseDeep(code, "t.cs");
    expect(ast.namespaces).toHaveLength(1);
    expect(ast.namespaces[0]!.name).toBe("Game.Combat");
    expect(ast.namespaces[0]!.isFileScoped).toBe(false);
    expect(ast.namespaces[0]!.members).toHaveLength(1);
  });

  it("parses file-scoped namespace", () => {
    const code = `
namespace Game.Combat;

public class DamageSystem { }
`;
    const ast = parseDeep(code, "t.cs");
    expect(ast.namespaces).toHaveLength(1);
    expect(ast.namespaces[0]!.name).toBe("Game.Combat");
    expect(ast.namespaces[0]!.isFileScoped).toBe(true);
    expect(ast.namespaces[0]!.members).toHaveLength(1);
  });
});

describe("class parsing", () => {
  it("parses simple class", () => {
    const code = `public class Player { }`;
    const ast = parseDeep(code, "t.cs");
    const classes = getClasses(ast);
    expect(classes).toHaveLength(1);
    expect(classes[0]!.name).toBe("Player");
    expect(classes[0]!.modifiers).toContain("public");
  });

  it("parses abstract class", () => {
    const code = `public abstract class BaseSystem { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.modifiers).toContain("abstract");
  });

  it("parses static class", () => {
    const code = `public static class Utils { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.modifiers).toContain("static");
  });

  it("parses partial class", () => {
    const code = `public partial class Player { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.modifiers).toContain("partial");
  });

  it("parses class with inheritance", () => {
    const code = `public class CombatSystem : SystemBase { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.baseTypes).toEqual(["SystemBase"]);
    expect(deepInheritsFrom(classes[0]!, "SystemBase")).toBe(true);
  });

  it("parses class with interfaces", () => {
    const code = `public class MyService : ServiceBase, IMyService, IDisposable { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.baseTypes).toEqual(["ServiceBase", "IMyService", "IDisposable"]);
    expect(deepImplements(classes[0]!, "IMyService")).toBe(true);
  });

  it("parses generic class", () => {
    const code = `public class Container<T, U> { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.genericParams).toEqual(["T", "U"]);
  });

  it("parses class with generic base type", () => {
    const code = `public class PlayerMediator : EntityMediator<PlayerView> { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.baseTypes).toEqual(["EntityMediator<PlayerView>"]);
    expect(deepInheritsFrom(classes[0]!, "EntityMediator")).toBe(true);
  });

  it("parses nested generics in base type", () => {
    const code = `public class Repo : Repository<Dictionary<string, List<int>>> { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.baseTypes[0]).toContain("Dictionary");
    expect(classes[0]!.baseTypes[0]).toContain("List");
  });

  it("parses class with attributes", () => {
    const code = `
[Serializable]
[RequireComponent(typeof(Rigidbody))]
public class Player { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.attributes).toHaveLength(2);
    expect(classes[0]!.attributes[0]!.name).toBe("Serializable");
    expect(classes[0]!.attributes[1]!.name).toBe("RequireComponent");
  });

  it("parses nested class", () => {
    const code = `
public class Outer {
    public class Inner { }
}`;
    const ast = parseDeep(code, "t.cs");
    const classes = getClasses(ast);
    const outer = classes.find((c) => c.name === "Outer");
    expect(outer).toBeDefined();
    expect(outer!.nestedTypes).toHaveLength(1);
    expect(outer!.nestedTypes[0]!.name).toBe("Inner");
  });

  it("calculates line numbers", () => {
    const code = `// line1
// line2
public class ThirdLine { }`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes[0]!.line).toBe(3);
  });
});

describe("struct parsing", () => {
  it("parses struct with interface", () => {
    const code = `public struct Health : IComponent { }`;
    const structs = getStructs(parseDeep(code, "t.cs"));
    expect(structs).toHaveLength(1);
    expect(structs[0]!.name).toBe("Health");
    expect(structs[0]!.baseTypes).toContain("IComponent");
    expect(deepImplements(structs[0]!, "IComponent")).toBe(true);
  });

  it("parses readonly struct", () => {
    const code = `public readonly struct Velocity : IComponent { }`;
    const structs = getStructs(parseDeep(code, "t.cs"));
    expect(structs[0]!.modifiers).toContain("readonly");
  });
});

describe("interface parsing", () => {
  it("parses interface with base interfaces", () => {
    const code = `public interface IPlayerService : IService, IDisposable { }`;
    const ifaces = getInterfaces(parseDeep(code, "t.cs"));
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0]!.name).toBe("IPlayerService");
    expect(ifaces[0]!.baseTypes).toContain("IService");
  });

  it("parses interface methods", () => {
    const code = `
public interface IService {
    void Initialize();
    Task<bool> ProcessAsync(string input);
}`;
    const ifaces = getInterfaces(parseDeep(code, "t.cs"));
    const methods = getMethods(ifaces[0]!);
    expect(methods).toHaveLength(2);
    expect(methods[0]!.name).toBe("Initialize");
    expect(methods[0]!.returnType).toBe("void");
  });
});

describe("enum parsing", () => {
  it("parses enum with values", () => {
    const code = `
public enum Direction {
    North,
    South,
    East,
    West
}`;
    const enums = getEnums(parseDeep(code, "t.cs"));
    expect(enums).toHaveLength(1);
    expect(enums[0]!.name).toBe("Direction");
    expect(enums[0]!.values).toEqual(["North", "South", "East", "West"]);
  });

  it("parses enum with explicit values", () => {
    const code = `
public enum Priority {
    Low = 0,
    Medium = 5,
    High = 10
}`;
    const enums = getEnums(parseDeep(code, "t.cs"));
    expect(enums[0]!.values).toEqual(["Low", "Medium", "High"]);
  });
});

describe("method parsing", () => {
  it("parses public method with parameters", () => {
    const code = `
public class A {
    public void Process(int x, string name) { }
}`;
    const methods = getMethods(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.name).toBe("Process");
    expect(methods[0]!.returnType).toBe("void");
    expect(methods[0]!.parameters).toHaveLength(2);
    expect(methods[0]!.parameters[0]!.type).toBe("int");
    expect(methods[0]!.parameters[0]!.name).toBe("x");
  });

  it("parses async method", () => {
    const code = `
public class A {
    public async Task<bool> LoadAsync() { return true; }
}`;
    const methods = getMethods(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(methods[0]!.modifiers).toContain("async");
  });

  it("parses override method", () => {
    const code = `
public class A {
    public override void OnUpdate(float dt) { }
}`;
    const methods = getMethods(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(methods[0]!.modifiers).toContain("override");
    expect(methods[0]!.name).toBe("OnUpdate");
  });

  it("parses expression-bodied method", () => {
    const code = `
public class A {
    public int GetValue() => 42;
}`;
    const methods = getMethods(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(methods[0]!.name).toBe("GetValue");
    expect(methods[0]!.returnType).toBe("int");
  });

  it("parses method with default parameters", () => {
    const code = `
public class A {
    public void Setup(int count = 10, string name = "test") { }
}`;
    const methods = getMethods(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(methods[0]!.parameters).toHaveLength(2);
    expect(methods[0]!.parameters[0]!.hasDefault).toBe(true);
    expect(methods[0]!.parameters[1]!.hasDefault).toBe(true);
  });

  it("parses method with generic return type", () => {
    const code = `
public class A {
    public List<string> GetItems() { return new(); }
}`;
    const methods = getMethods(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(methods[0]!.returnType).toContain("List");
  });
});

describe("constructor parsing", () => {
  it("parses constructor with DI parameters", () => {
    const code = `
public class GameService {
    public GameService(ILogger logger, IEventBus eventBus) { }
}`;
    const cls = getClasses(parseDeep(code, "t.cs"))[0]!;
    const ctors = getConstructors(cls);
    expect(ctors).toHaveLength(1);
    expect(ctors[0]!.className).toBe("GameService");
    expect(ctors[0]!.parameters).toHaveLength(2);

    const deps = getDependencies(cls);
    expect(deps).toContain("ILogger");
    expect(deps).toContain("IEventBus");
  });

  it("parses constructor with base call", () => {
    const code = `
public class CombatSystem : SystemBase {
    public CombatSystem(IEntityManager em) : base(em) { }
}`;
    const ctors = getConstructors(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(ctors).toHaveLength(1);
    expect(ctors[0]!.parameters).toHaveLength(1);
  });
});

describe("field parsing", () => {
  it("parses private field", () => {
    const code = `
public class A {
    private readonly int _count;
}`;
    const fields = getFields(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe("_count");
    expect(fields[0]!.type).toBe("int");
    expect(fields[0]!.modifiers).toContain("readonly");
  });

  it("parses field with initializer", () => {
    const code = `
public class A {
    private string _name = "default";
}`;
    const fields = getFields(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(fields[0]!.name).toBe("_name");
    expect(fields[0]!.type).toBe("string");
  });
});

describe("property parsing", () => {
  it("parses auto-property", () => {
    const code = `
public class A {
    public string Name { get; set; }
}`;
    const props = getProperties(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(props).toHaveLength(1);
    expect(props[0]!.name).toBe("Name");
    expect(props[0]!.type).toBe("string");
    expect(props[0]!.hasGetter).toBe(true);
    expect(props[0]!.hasSetter).toBe(true);
  });

  it("parses read-only property", () => {
    const code = `
public class A {
    public int Count { get; }
}`;
    const props = getProperties(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(props[0]!.hasGetter).toBe(true);
    expect(props[0]!.hasSetter).toBe(false);
  });

  it("parses expression-bodied property", () => {
    const code = `
public class A {
    public int Total => _items.Count;
}`;
    const props = getProperties(getClasses(parseDeep(code, "t.cs"))[0]!);
    expect(props[0]!.hasGetter).toBe(true);
    expect(props[0]!.hasSetter).toBe(false);
  });
});

describe("complete file parsing", () => {
  it("parses a full Strada.Core system file", () => {
    const code = `
using Strada.Core.ECS;
using Strada.Core.Events;
using UnityEngine;

namespace Game.Combat
{
    [SystemPriority(100)]
    public class DamageSystem : SystemBase
    {
        private readonly IEventBus _eventBus;
        private EntityQuery _query;

        public DamageSystem(IEventBus eventBus)
        {
            _eventBus = eventBus;
        }

        public override void OnCreate()
        {
            _query = World.CreateQuery()
                .With<Health>()
                .With<DamageDealer>()
                .Build();
        }

        public override void OnUpdate(float deltaTime)
        {
            foreach (var entity in _query)
            {
                var health = World.Get<Health>(entity);
                var damage = World.Get<DamageDealer>(entity);
                health.Current -= damage.Amount * deltaTime;
                World.Set(entity, health);
            }
        }
    }
}`;
    const ast = parseDeep(code, "DamageSystem.cs");

    expect(ast.usings).toHaveLength(3);
    expect(ast.namespaces).toHaveLength(1);
    expect(ast.namespaces[0]!.name).toBe("Game.Combat");

    const classes = getClasses(ast);
    expect(classes).toHaveLength(1);

    const cls = classes[0]!;
    expect(cls.name).toBe("DamageSystem");
    expect(cls.baseTypes).toContain("SystemBase");
    expect(cls.attributes[0]!.name).toBe("SystemPriority");

    const ctors = getConstructors(cls);
    expect(ctors).toHaveLength(1);
    expect(ctors[0]!.parameters[0]!.type).toBe("IEventBus");

    const methods = getMethods(cls);
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain("OnCreate");
    expect(methodNames).toContain("OnUpdate");

    const fields = getFields(cls);
    expect(fields.length).toBeGreaterThanOrEqual(1);

    const deps = getDependencies(cls);
    expect(deps).toContain("IEventBus");
  });

  it("parses a Strada component struct", () => {
    const code = `
namespace Game.Combat
{
    public struct Health : IComponent
    {
        public float Current;
        public float Max;
        public bool IsAlive => Current > 0;
    }
}`;
    const ast = parseDeep(code, "Health.cs");
    const structs = getStructs(ast);
    expect(structs).toHaveLength(1);
    expect(structs[0]!.name).toBe("Health");
    expect(deepImplements(structs[0]!, "IComponent")).toBe(true);
  });

  it("handles comments and strings without false matches", () => {
    const code = `
// This is a comment with class keyword
/* Another comment with namespace in it */
public class RealClass {
    private string _msg = "class Fake : Base { }";
}`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    expect(classes).toHaveLength(1);
    expect(classes[0]!.name).toBe("RealClass");
  });

  it("handles preprocessor directives", () => {
    const code = `
#if UNITY_EDITOR
public class EditorOnly { }
#endif
public class AlwaysPresent { }
`;
    const classes = getClasses(parseDeep(code, "t.cs"));
    // Both classes should be parsed (preprocessor is ignored, all branches included)
    expect(classes.length).toBeGreaterThanOrEqual(1);
    const names = classes.map((c) => c.name);
    expect(names).toContain("AlwaysPresent");
  });
});

describe("flattenTypes", () => {
  it("collects types from namespaces and top-level", () => {
    const code = `
public class TopLevel { }

namespace NS1 {
    public class Inside { }
}`;
    const ast = parseDeep(code, "t.cs");
    const all = flattenTypes(ast);
    const names = all.map((t) => t.name);
    expect(names).toContain("TopLevel");
    expect(names).toContain("Inside");
  });

  it("collects nested types recursively", () => {
    const code = `
public class Outer {
    public class Middle {
        public class Inner { }
    }
}`;
    const ast = parseDeep(code, "t.cs");
    const all = flattenTypes(ast);
    const names = all.map((t) => t.name);
    expect(names).toContain("Outer");
    expect(names).toContain("Middle");
    expect(names).toContain("Inner");
  });
});

describe("deepInheritsFrom", () => {
  it("matches simple base class", () => {
    const code = `public class A : SystemBase { }`;
    const cls = getClasses(parseDeep(code, "t.cs"))[0]!;
    expect(deepInheritsFrom(cls, "SystemBase")).toBe(true);
    expect(deepInheritsFrom(cls, "Other")).toBe(false);
  });

  it("strips generics for matching", () => {
    const code = `public class Med : EntityMediator<View> { }`;
    const cls = getClasses(parseDeep(code, "t.cs"))[0]!;
    expect(deepInheritsFrom(cls, "EntityMediator")).toBe(true);
  });
});

describe("deepImplements", () => {
  it("matches interface in base types", () => {
    const code = `public class Svc : ISvc, IDisposable { }`;
    const cls = getClasses(parseDeep(code, "t.cs"))[0]!;
    expect(deepImplements(cls, "ISvc")).toBe(true);
    expect(deepImplements(cls, "IDisposable")).toBe(true);
    expect(deepImplements(cls, "INothing")).toBe(false);
  });
});
