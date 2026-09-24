import { describe, it, expect, vi, afterEach } from "vitest";
import { Parser, Tree } from "web-tree-sitter";
import { TypeScriptSymbolExtractor } from "./typescript-extractor.js";
import { CSharpSymbolExtractor } from "./csharp-extractor.js";

// MEM-4: web-tree-sitter parsers and trees live in the WASM heap and have no
// finalizer, so every extraction that does not delete() them leaks (measured
// ~1.3 MB per parse of a 62 KB file) and WASM memory never shrinks.
describe("tree-sitter resources are freed after each extraction (MEM-4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TypeScript extraction deletes its parser and tree", async () => {
    const parserDelete = vi.spyOn(Parser.prototype, "delete");
    const treeDelete = vi.spyOn(Tree.prototype, "delete");
    const out = await new TypeScriptSymbolExtractor().extract({
      path: "src/a.ts",
      content: "export class A { run(): void {} }",
      lang: "typescript",
    });
    expect(out.symbols.some((s) => s.name === "A")).toBe(true);
    expect(parserDelete).toHaveBeenCalledTimes(1);
    expect(treeDelete).toHaveBeenCalledTimes(1);
  });

  it("C# extraction deletes its parser and tree, even when the result is empty", async () => {
    const parserDelete = vi.spyOn(Parser.prototype, "delete");
    const treeDelete = vi.spyOn(Tree.prototype, "delete");
    await new CSharpSymbolExtractor().extract({ path: "Assets/A.cs", content: "public class A { }", lang: "csharp" });
    await new CSharpSymbolExtractor().extract({ path: "Assets/B.cs", content: "", lang: "csharp" });
    expect(parserDelete).toHaveBeenCalledTimes(2);
    expect(treeDelete).toHaveBeenCalledTimes(2);
  });
});
