import { describe, it, expect } from "vitest";
import { buildCanvas } from "./canvas-generator.js";
import type { VaultFile, VaultSymbol, VaultWikilink, VaultEdge } from "./vault.interface.js";

function file(path: string): VaultFile {
  return { path, blobHash: "h", mtimeMs: 0, size: 1, lang: "markdown", kind: "doc", indexedAt: 0 };
}

function symbol(i: number, path: string): VaultSymbol {
  return {
    symbolId: `s${i}`, path, kind: "note", name: `s${i}`,
    display: `s${i}`, startLine: 1, endLine: 1, doc: null,
  };
}

describe("buildCanvas file-graph edge direction", () => {
  it("stores deduped file edges in canonical (deterministic) order", () => {
    // >500 symbols forces the file-level graph path.
    const symbols: VaultSymbol[] = Array.from({ length: 501 }, (_, i) => symbol(i, "A.md"));
    const files = [file("A.md"), file("B.md")];
    // The wikilink points B -> A. Canonical order is A < B, so the rendered
    // file edge must be A -> B regardless of the link's direction — previously
    // it kept the first-seen B -> A ordering (non-deterministic arrow).
    const wikilinks: VaultWikilink[] = [{ fromNote: "B.md", target: "A.md", resolved: true }];

    const canvas = buildCanvas({ symbols, edges: [], files, wikilinks });
    const fileEdges = canvas.edges.filter(
      (e) =>
        (e.fromNode === "A.md" || e.fromNode === "B.md") &&
        (e.toNode === "A.md" || e.toNode === "B.md"),
    );
    expect(fileEdges).toHaveLength(1);
    expect(fileEdges[0]!.fromNode).toBe("A.md");
    expect(fileEdges[0]!.toNode).toBe("B.md");
  });
});

describe("buildCanvas edge/node fidelity", () => {
  it("file-graph nodes are type:'file' and edges carry deterministic sides + color", () => {
    const symbols: VaultSymbol[] = Array.from({ length: 501 }, (_, i) => symbol(i, "A.md"));
    const files = [file("A.md"), file("B.md")];
    const wikilinks: VaultWikilink[] = [{ fromNote: "B.md", target: "A.md", resolved: true }];

    const canvas = buildCanvas({ symbols, edges: [], files, wikilinks });

    expect(canvas.nodes.length).toBeGreaterThan(0);
    expect(canvas.nodes.every((n) => n.type === "file")).toBe(true);

    const edge = canvas.edges.find((e) => e.fromNode === "A.md" && e.toNode === "B.md");
    expect(edge).toBeDefined();
    expect(edge!.fromSide).toBe("right");
    expect(edge!.toSide).toBe("left");
    expect(edge!.color).toBe("#10B981"); // wikilink color
  });

  it("symbol-graph nodes stay type:'text' and edges carry sides + kind color", () => {
    const symbols: VaultSymbol[] = [symbol(0, "A.md"), symbol(1, "B.md")];
    const edges: VaultEdge[] = [{ fromSymbol: "s0", toSymbol: "s1", kind: "calls", atLine: 1 }];

    const canvas = buildCanvas({ symbols, edges, files: [file("A.md"), file("B.md")], wikilinks: [] });

    expect(canvas.nodes.every((n) => n.type === "text")).toBe(true);
    const edge = canvas.edges.find((e) => e.fromNode === "s0" && e.toNode === "s1");
    expect(edge).toBeDefined();
    expect(edge!.fromSide).toBe("right");
    expect(edge!.toSide).toBe("left");
    expect(edge!.color).toBe("#6B7280"); // calls color
  });

  it("omits color for unknown edge kinds (spec-valid minimal output)", () => {
    const symbols: VaultSymbol[] = [symbol(0, "A.md"), symbol(1, "B.md")];
    const edges: VaultEdge[] = [{ fromSymbol: "s0", toSymbol: "s1", kind: "mystery" as VaultEdge["kind"], atLine: 1 }];

    const canvas = buildCanvas({ symbols, edges, files: [file("A.md"), file("B.md")], wikilinks: [] });
    const edge = canvas.edges.find((e) => e.fromNode === "s0" && e.toNode === "s1");
    expect(edge!.color).toBeUndefined();
    // JSON.stringify must drop the undefined color key.
    expect(JSON.stringify(edge)).not.toContain("color");
  });

  it("is deterministic across builds", () => {
    const symbols: VaultSymbol[] = [symbol(0, "A.md"), symbol(1, "B.md")];
    const edges: VaultEdge[] = [{ fromSymbol: "s0", toSymbol: "s1", kind: "calls", atLine: 1 }];
    const args = { symbols, edges, files: [file("A.md"), file("B.md")], wikilinks: [] as VaultWikilink[] };
    expect(JSON.stringify(buildCanvas(args))).toBe(JSON.stringify(buildCanvas(args)));
  });
});
