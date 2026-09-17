import { describe, it, expect } from "vitest";
import { CSharpSymbolExtractor } from "./csharp-extractor.js";

const extractor = new CSharpSymbolExtractor();

async function extract(content: string, path = "Assets/Test.cs") {
  return extractor.extract({ path, content, lang: "csharp" });
}

// =============================================================================
// TESTS — lang property
// =============================================================================

describe("CSharpSymbolExtractor — lang", () => {
  it("reports lang as 'csharp'", () => {
    expect(extractor.lang).toBe("csharp");
  });
});

// =============================================================================
// TESTS — empty input
// =============================================================================

describe("CSharpSymbolExtractor — empty input", () => {
  it("returns only the <module> virtual symbol for empty content", async () => {
    const out = await extract("");
    const nonModule = out.symbols.filter((s) => s.name !== "<module>");
    expect(nonModule).toHaveLength(0);
    expect(out.wikilinks).toEqual([]);
  });
});

// =============================================================================
// TESTS — <module> virtual symbol
// =============================================================================

describe("CSharpSymbolExtractor — <module> virtual symbol", () => {
  it("emits a <module> namespace symbol at line 1", async () => {
    const out = await extract("// just a comment");
    const mod = out.symbols.find((s) => s.name === "<module>");
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("namespace");
    expect(mod!.startLine).toBe(1);
    expect(mod!.symbolId).toContain("csharp::");
    expect(mod!.symbolId).toContain("<module>");
  });
});

// =============================================================================
// TESTS — using directives → import edges
// =============================================================================

describe("CSharpSymbolExtractor — using directives", () => {
  const src = `using System;
using UnityEngine;

public class Foo {}`;

  it("emits import edges for each using directive", async () => {
    const { edges } = await extract(src);
    const importEdges = edges.filter((e) => e.kind === "imports");
    expect(importEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("import edges originate from the <module> symbol", async () => {
    const { edges } = await extract(src);
    const importEdges = edges.filter((e) => e.kind === "imports");
    for (const edge of importEdges) {
      expect(edge.fromSymbol).toContain("<module>");
    }
  });

  it("import edge targets include the imported namespace", async () => {
    const { edges } = await extract(src);
    const importEdges = edges.filter((e) => e.kind === "imports");
    const targets = importEdges.map((e) => e.toSymbol);
    expect(targets.some((t) => t.includes("System"))).toBe(true);
    expect(targets.some((t) => t.includes("UnityEngine"))).toBe(true);
  });
});

// =============================================================================
// TESTS — namespace extraction
// =============================================================================

describe("CSharpSymbolExtractor — namespace declarations", () => {
  const src = `namespace Strada.Core {
  public class Manager {}
}`;

  it("extracts the namespace as a symbol with kind 'namespace'", async () => {
    const { symbols } = await extract(src);
    const ns = symbols.find((s) => s.name === "Strada.Core" || s.name === "Core");
    expect(ns).toBeDefined();
    expect(ns!.kind).toBe("namespace");
  });

  it("extracts a class inside the namespace", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "Manager");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });
});

// =============================================================================
// TESTS — class extraction
// =============================================================================

describe("CSharpSymbolExtractor — class declarations", () => {
  const src = `
public class PlayerController {
  public void Start() {
    Debug.Log("started");
  }

  public void Update() {}
}
`.trim();

  it("extracts the class symbol with kind 'class'", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "PlayerController");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("extracts method declarations from the class body", async () => {
    const { symbols } = await extract(src);
    const start = symbols.find((s) => s.name === "Start");
    const update = symbols.find((s) => s.name === "Update");
    expect(start).toBeDefined();
    expect(start!.kind).toBe("method");
    expect(update).toBeDefined();
    expect(update!.kind).toBe("method");
  });

  it("emits call edges for method invocations inside a method body", async () => {
    const { edges } = await extract(src);
    const callEdges = edges.filter((e) => e.kind === "calls");
    // Start() calls Debug.Log → member access resolves to 'Log'
    expect(callEdges.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// TESTS — interface extraction
// =============================================================================

describe("CSharpSymbolExtractor — interface declarations", () => {
  const src = `
namespace Strada {
  public interface IMovable {
    void Move(float dx, float dy);
  }
}
`.trim();

  it("extracts an interface symbol with kind 'interface'", async () => {
    const { symbols } = await extract(src);
    const iface = symbols.find((s) => s.name === "IMovable");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");
  });

  it("extracts method declarations from interface body", async () => {
    const { symbols } = await extract(src);
    const method = symbols.find((s) => s.name === "Move");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
  });
});

// =============================================================================
// TESTS — struct extraction
// =============================================================================

describe("CSharpSymbolExtractor — struct declarations", () => {
  const src = `
public struct Vector2 {
  public float x;
  public float y;
}
`.trim();

  it("extracts a struct as a 'class' kind symbol", async () => {
    // Source: n.type === 'struct_declaration' → kind = 'class' (not 'interface')
    const { symbols } = await extract(src);
    const structSym = symbols.find((s) => s.name === "Vector2");
    expect(structSym).toBeDefined();
    expect(structSym!.kind).toBe("class");
  });
});

// =============================================================================
// TESTS — inheritance / base_list → inherits edges
// =============================================================================

describe("CSharpSymbolExtractor — inheritance edges", () => {
  const src = `
public class Enemy : MonoBehaviour, IDamageable {
  public void TakeDamage(int amount) {}
}
`.trim();

  it("emits 'inherits' edges for base types", async () => {
    const { edges } = await extract(src);
    const inheritEdges = edges.filter((e) => e.kind === "inherits");
    expect(inheritEdges.length).toBeGreaterThanOrEqual(2);
    const targets = inheritEdges.map((e) => e.toSymbol);
    expect(targets.some((t) => t.includes("MonoBehaviour"))).toBe(true);
    expect(targets.some((t) => t.includes("IDamageable"))).toBe(true);
  });
});

// =============================================================================
// TESTS — constructor extraction
// =============================================================================

describe("CSharpSymbolExtractor — constructor declarations", () => {
  const src = `
public class GameManager {
  public GameManager() {
    Init();
  }
}
`.trim();

  it("extracts constructor as a method-kind symbol", async () => {
    const { symbols } = await extract(src);
    const ctor = symbols.find((s) => s.name === "GameManager" && s.kind === "method");
    expect(ctor).toBeDefined();
  });
});

// =============================================================================
// TESTS — XML doc comment extraction
// =============================================================================

describe("CSharpSymbolExtractor — XML doc comments", () => {
  const src = `
/// <summary>
/// Manages game state.
/// </summary>
public class StateManager {}
`.trim();

  it("captures leading /// comments as the doc field", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "StateManager");
    expect(cls).toBeDefined();
    expect(cls!.doc).toContain("Manages game state");
  });
});

// =============================================================================
// TESTS — doc is null when no XML doc
// =============================================================================

describe("CSharpSymbolExtractor — doc is null without XML doc", () => {
  it("doc is null when no leading /// comment on the class", async () => {
    const { symbols } = await extract("// regular comment\npublic class Plain {}");
    const cls = symbols.find((s) => s.name === "Plain");
    expect(cls).toBeDefined();
    expect(cls!.doc).toBeNull();
  });
});

// =============================================================================
// TESTS — symbolId format
// =============================================================================

describe("CSharpSymbolExtractor — symbolId format", () => {
  it("includes the file path in the symbolId", async () => {
    const { symbols } = await extract("public class Foo {}", "Assets/Scripts/Foo.cs");
    const cls = symbols.find((s) => s.name === "Foo")!;
    expect(cls.symbolId).toContain("Assets/Scripts/Foo.cs");
    expect(cls.symbolId).toContain("Foo");
  });

  it("prefixes all symbolIds with 'csharp::'", async () => {
    const { symbols } = await extract("public class Foo {}");
    for (const sym of symbols) {
      expect(sym.symbolId.startsWith("csharp::")).toBe(true);
    }
  });
});

// =============================================================================
// TESTS — line ranges
// =============================================================================

describe("CSharpSymbolExtractor — line ranges", () => {
  const src = `public class Alpha {
  public void Beta() {}
}`;

  it("reports correct startLine for a top-level class", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "Alpha");
    expect(cls!.startLine).toBe(1);
  });

  it("reports endLine >= startLine for all symbols", async () => {
    const { symbols } = await extract(src);
    for (const sym of symbols) {
      expect(sym.endLine).toBeGreaterThanOrEqual(sym.startLine);
    }
  });
});

// =============================================================================
// TESTS — wikilinks always empty for C# files
// =============================================================================

describe("CSharpSymbolExtractor — wikilinks", () => {
  it("always returns empty wikilinks array", async () => {
    const { wikilinks } = await extract("public class Foo {}");
    expect(wikilinks).toEqual([]);
  });
});

// =============================================================================
// TESTS — overloads are distinct symbols (plan 3.11 / audit 05.F4 / D49)
// =============================================================================

describe("CSharpSymbolExtractor — callable identity", () => {
  it("gives each overload its own symbol, separated by parameter TYPES not arity", async () => {
    // Save(int) and Save(string) used to collapse into one `Repo.Save`: one
    // doc, one span, one set of callers for two different methods.
    const out = await extract(`
namespace Game {
  public class Repo {
    /// <summary>by id</summary>
    public void Save(int id) { }
    /// <summary>by name</summary>
    public void Save(string name) { }
    public void Save() { }
    public T Load<T>(string key, int version) { return default(T); }
  }
}
`);
    const methods = out.symbols.filter((s) => s.kind === "method");
    const ids = methods.map((s) => s.symbolId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.endsWith("Game.Repo.Save(int)"))).toBe(true);
    expect(ids.some((id) => id.endsWith("Game.Repo.Save(string)"))).toBe(true);
    expect(ids.some((id) => id.endsWith("Game.Repo.Save()"))).toBe(true);
    // The generic arity is part of the identity too.
    expect(ids.some((id) => id.includes("Game.Repo.Load`1(string,int)"))).toBe(true);
    // The bare name stays searchable, and the display carries the signature.
    expect(methods.every((s) => s.name === "Save" || s.name === "Load")).toBe(true);
    expect(methods.find((s) => s.symbolId.endsWith("Save(string)"))!.display).toBe("Save(string)");
    // Each overload keeps its OWN doc comment and span.
    const byId = methods.find((s) => s.symbolId.endsWith("Save(int)"))!;
    expect(byId.doc).toContain("by id");
    expect(methods.find((s) => s.symbolId.endsWith("Save(string)"))!.doc).toContain("by name");
    expect(byId.startLine).not.toBe(methods.find((s) => s.symbolId.endsWith("Save(string)"))!.startLine);
  });

  it("separates a ref/out parameter from its by-value overload, and keeps a plain method simple (guard)", async () => {
    const out = await extract(`
public class P {
  public void Try(int v) { }
  public void Try(ref int v) { }
  public void Plain() { }
}
`);
    const ids = out.symbols.filter((s) => s.kind === "method").map((s) => s.symbolId);
    expect(ids.some((id) => id.endsWith("P.Try(int)"))).toBe(true);
    expect(ids.some((id) => id.endsWith("P.Try(ref int)"))).toBe(true);
    expect(ids.some((id) => id.endsWith("P.Plain()"))).toBe(true);
  });

  it("a call edge still leaves the method's own symbol as its source", async () => {
    const out = await extract(`
public class C {
  public void A(int x) { B(); }
  public void B() { }
}
`);
    const a = out.symbols.find((s) => s.symbolId.endsWith("C.A(int)"))!;
    expect(out.edges.some((e) => e.fromSymbol === a.symbolId && e.kind === "calls")).toBe(true);
  });
});

// =============================================================================
// Round 10 #15: the grammar does not wrap a `params` parameter in a
// `parameter` node, so a node-typed walk skipped it and every params overload
// collapsed into the no-argument one.
// =============================================================================

describe("CSharpSymbolExtractor — parameter shapes the grammar spells differently", () => {
  it("separates params overloads from each other and from the empty one", async () => {
    const out = await extract(`
public class C {
  public void F() { }
  public void F(params int[] args) { }
  public void F(params string[] args) { }
}
`);
    const ids = out.symbols.filter((s) => s.kind === "method").map((s) => s.symbolId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.some((id) => id.endsWith("C.F()"))).toBe(true);
    expect(ids.some((id) => id.endsWith("C.F(params int[])"))).toBe(true);
    expect(ids.some((id) => id.endsWith("C.F(params string[])"))).toBe(true);
  });

  it("reads generics, attributes, defaults and out/ref the same way (guard)", async () => {
    const out = await extract(`
using System.Collections.Generic;
public class C {
  public void M(Dictionary<int, string> map) { }
  public void M(List<int> items, int count = 3) { }
  public void M(out int written) { written = 0; }
  public T Conv<T>(T value, int n) { return value; }
  public void Attr([CallerMemberName] string caller = "") { }
}
`);
    const ids = out.symbols.filter((s) => s.kind === "method").map((s) => s.symbolId.split("::").at(-1));
    // A comma inside a generic argument list is not a parameter separator.
    expect(ids).toContain("C.M(Dictionary<int,string>)");
    // A default value does not change the callable; the name never appears.
    expect(ids).toContain("C.M(List<int>,int)");
    expect(ids).toContain("C.M(out int)");
    expect(ids).toContain("C.Conv\`1(T,int)");
    // An attribute is not a type.
    expect(ids).toContain("C.Attr(string)");
  });
});

// =============================================================================
// Round 11 #18: a default VALUE is not part of a callable's identity, and
// reading the parameter list as text let one corrupt the signature — a comma
// inside a string default split it, and a '<' swallowed the rest of the list
// until the signature collided with a different overload.
// =============================================================================

describe("CSharpSymbolExtractor — an optional default never changes the identity", () => {
  it("keeps a quoted comma, angle bracket or parenthesis out of the signature", async () => {
    const out = await extract(`
public class C {
  public void F(string s = "a,b", int n = 0) { }
  public void G(string s = "a<b", int n = 0) { }
  public void H(string s) { }
  public void I(int[] xs, string s = ")") { }
}
`);
    const ids = out.symbols.filter((sym) => sym.kind === "method").map((sym) => sym.symbolId.split("::").at(-1));
    expect(ids).toContain("C.F(string,int)");
    expect(ids).toContain("C.G(string,int)");
    // …and the one-parameter overload keeps its own identity: G must not
    // collapse onto it.
    expect(ids).toContain("C.H(string)");
    expect(ids).toContain("C.I(int[],string)");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the same method with and without a default is the SAME callable (guard)", async () => {
    const withDefault = await extract("public class C { public void F(int a = 3) { } }");
    const without = await extract("public class C { public void F(int a) { } }");
    const id = (o: Awaited<ReturnType<typeof extract>>) =>
      o.symbols.filter((s2) => s2.kind === "method").map((s2) => s2.symbolId)[0];
    expect(id(withDefault)).toBe(id(without));
  });
});
