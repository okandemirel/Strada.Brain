import { describe, it, expect } from "vitest";
import { TypeScriptSymbolExtractor } from "./typescript-extractor.js";

const extractor = new TypeScriptSymbolExtractor();

async function extract(content: string, path = "src/test.ts") {
  return extractor.extract({ path, content, lang: "typescript" });
}

// =============================================================================
// TESTS — lang property
// =============================================================================

describe("TypeScriptSymbolExtractor — lang", () => {
  it("reports lang as 'typescript'", () => {
    expect(extractor.lang).toBe("typescript");
  });
});

// =============================================================================
// TESTS — empty / trivial input
// =============================================================================

describe("TypeScriptSymbolExtractor — empty input", () => {
  it("returns empty symbols/edges/wikilinks for empty content", async () => {
    const out = await extract("");
    // Always emits the file-level <module> virtual symbol
    expect(out.wikilinks).toEqual([]);
    // No declarations → only the module symbol
    const nonModule = out.symbols.filter((s) => s.name !== "<module>");
    expect(nonModule).toHaveLength(0);
  });
});

// =============================================================================
// TESTS — module-level virtual symbol
// =============================================================================

describe("TypeScriptSymbolExtractor — <module> virtual symbol", () => {
  it("always emits a <module> namespace symbol at line 1", async () => {
    const out = await extract("const x = 1;");
    const mod = out.symbols.find((s) => s.name === "<module>");
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("namespace");
    expect(mod!.startLine).toBe(1);
    expect(mod!.symbolId).toContain("typescript::");
    expect(mod!.symbolId).toContain("<module>");
  });
});

// =============================================================================
// TESTS — class extraction
// =============================================================================

describe("TypeScriptSymbolExtractor — class declarations", () => {
  const src = `
class Greeter {
  greet() {
    console.log("hi");
  }
}
`.trim();

  it("extracts a top-level class symbol", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "Greeter");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.startLine).toBeGreaterThanOrEqual(1);
    expect(cls!.endLine).toBeGreaterThan(cls!.startLine);
  });

  it("extracts method symbols inside the class body", async () => {
    const { symbols } = await extract(src);
    const method = symbols.find((s) => s.name === "greet");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
  });

  it("extracts call edges from method body", async () => {
    const { edges } = await extract(src);
    const callEdges = edges.filter((e) => e.kind === "calls");
    // greet() calls console.log (the log member access resolves to 'log')
    expect(callEdges.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// TESTS — exported class
// =============================================================================

describe("TypeScriptSymbolExtractor — exported class", () => {
  const src = `
export class MyService {
  doWork(): void {}
}
`.trim();

  it("extracts an exported class via export_statement wrapper", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "MyService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("extracts methods from an exported class body", async () => {
    const { symbols } = await extract(src);
    const method = symbols.find((s) => s.name === "doWork");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
  });
});

// =============================================================================
// TESTS — interface extraction
// =============================================================================

describe("TypeScriptSymbolExtractor — interface declarations", () => {
  const src = `
export interface ILogger {
  log(msg: string): void;
}
`.trim();

  it("extracts an exported interface symbol", async () => {
    const { symbols } = await extract(src);
    const iface = symbols.find((s) => s.name === "ILogger");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");
  });

  it("extracts method signatures from an exported interface body", async () => {
    const { symbols } = await extract(src);
    const method = symbols.find((s) => s.name === "log");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
  });
});

// =============================================================================
// TESTS — function extraction
// =============================================================================

describe("TypeScriptSymbolExtractor — function declarations", () => {
  const src = `
export function greet(name: string): string {
  return "Hello " + name;
}
`.trim();

  it("extracts an exported top-level function symbol", async () => {
    const { symbols } = await extract(src);
    const fn = symbols.find((s) => s.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("line range of the function matches source", async () => {
    const { symbols } = await extract(src);
    const fn = symbols.find((s) => s.name === "greet")!;
    expect(fn.startLine).toBe(1);
    expect(fn.endLine).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// TESTS — import edges
// =============================================================================

describe("TypeScriptSymbolExtractor — import edges", () => {
  const src = `
import { readFile } from 'node:fs';
import path from 'node:path';
`.trim();

  it("emits import edges for named imports", async () => {
    const { edges } = await extract(src);
    const importEdges = edges.filter((e) => e.kind === "imports");
    expect(importEdges.length).toBeGreaterThan(0);
    const readFileEdge = importEdges.find((e) => e.toSymbol.includes("readFile"));
    expect(readFileEdge).toBeDefined();
    expect(readFileEdge!.fromSymbol).toContain("<module>");
  });

  it("emits import edges for default imports", async () => {
    const { edges } = await extract(src);
    const importEdges = edges.filter((e) => e.kind === "imports");
    const pathEdge = importEdges.find((e) => e.toSymbol.includes("path"));
    expect(pathEdge).toBeDefined();
  });
});

// =============================================================================
// TESTS — symbol ID format
// =============================================================================

describe("TypeScriptSymbolExtractor — symbolId format", () => {
  it("includes the file path in the symbolId", async () => {
    const { symbols } = await extract("class Foo {}", "src/services/foo.ts");
    const cls = symbols.find((s) => s.name === "Foo")!;
    expect(cls.symbolId).toContain("src/services/foo.ts");
    expect(cls.symbolId).toContain("Foo");
  });

  it("prefixes all symbolIds with 'typescript::'", async () => {
    const { symbols } = await extract("class Foo {}");
    for (const sym of symbols) {
      expect(sym.symbolId.startsWith("typescript::")).toBe(true);
    }
  });
});

// =============================================================================
// TESTS — JSDoc extraction
// =============================================================================

describe("TypeScriptSymbolExtractor — JSDoc comment extraction", () => {
  const src = `
/** A well-documented class */
export class Documented {
  /** Does something useful */
  doStuff(): void {}
}
`.trim();

  it("captures the leading JSDoc comment on a class", async () => {
    const { symbols } = await extract(src);
    const cls = symbols.find((s) => s.name === "Documented");
    expect(cls).toBeDefined();
    expect(cls!.doc).toContain("well-documented");
  });
});

// =============================================================================
// TESTS — doc field is null when no JSDoc
// =============================================================================

describe("TypeScriptSymbolExtractor — doc is null without JSDoc", () => {
  it("doc is null for a class without a leading /** comment */", async () => {
    const { symbols } = await extract("// regular comment\nexport class Plain {}");
    const cls = symbols.find((s) => s.name === "Plain");
    expect(cls).toBeDefined();
    expect(cls!.doc).toBeNull();
  });
});

// =============================================================================
// TESTS — multiple declarations in one file
// =============================================================================

describe("TypeScriptSymbolExtractor — multiple declarations", () => {
  const src = `
export class Alpha {}
export interface IBeta {}
export function gamma(): void {}
`.trim();

  it("extracts all three top-level declarations", async () => {
    const { symbols } = await extract(src);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Alpha");
    expect(names).toContain("IBeta");
    expect(names).toContain("gamma");
  });
});

// =============================================================================
// TESTS — wikilinks is always empty for TS files
// =============================================================================

describe("TypeScriptSymbolExtractor — wikilinks", () => {
  it("always returns empty wikilinks array", async () => {
    const { wikilinks } = await extract("export class Foo {}");
    expect(wikilinks).toEqual([]);
  });
});
