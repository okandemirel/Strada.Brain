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

// Audit 2026-09-02: on the live index (2,826 files / 57,630 edges, all with
// unresolved targets) one canvas regeneration took ~76 s, and it ran
// synchronously on every 800 ms watcher batch. 99.9% of that was
// guessFileFromUnresolved: a linear scan of every file — with three regex
// replaces each — per edge. The mapping must be built once per canvas.
describe("buildCanvas file-graph maps unresolved targets without rescanning every file per edge", () => {
  const FILES = 3000;
  const EDGES = 20000;

  function corpus() {
    const files: VaultFile[] = [];
    for (let i = 0; i < FILES; i++) {
      // Mixed spellings and suffixes so the basename normalisation is exercised:
      // Foo12.ts / foo12.test.ts / Foo12.d.ts all normalise to "foo12".
      const stem = i % 3 === 0 ? `Foo${i}.ts` : i % 3 === 1 ? `foo${i}.test.ts` : `Foo${i}.d.ts`;
      files.push({ ...file(`src/dir${i % 40}/${stem}`), lang: "typescript", kind: "source" });
    }
    // >500 symbols forces the file graph; one symbol per file, all in file 0's dir.
    const symbols: VaultSymbol[] = files.map((f, i) => ({ ...symbol(i, f.path), kind: "class" as const }));
    const edges: VaultEdge[] = [];
    for (let i = 0; i < EDGES; i++) {
      // Every target is unresolved and names some other file's basename.
      const target = (i * 7919) % FILES;
      edges.push({ fromSymbol: `s${i % FILES}`, toSymbol: `typescript::unresolved::foo${target}`, kind: "calls", atLine: 1 });
    }
    return { files, symbols, edges };
  }

  /** Reference semantics: first file (in input order) whose normalised basename matches, case-insensitively. */
  function referenceFileEdges(files: VaultFile[], symbols: VaultSymbol[], edges: VaultEdge[]): Set<string> {
    const symbolToFile = new Map(symbols.map((s) => [s.symbolId, s.path]));
    const normalised = files.map((f) => (f.path.split("/").pop() ?? f.path)
      .replace(/\.(test|spec)\.[^.]+$/, "").replace(/\.d\.ts$/, "").replace(/\.[^.]+$/, "").toLowerCase());
    const out = new Set<string>();
    for (const e of edges) {
      const from = symbolToFile.get(e.fromSymbol)!;
      const name = e.toSymbol.split("::").pop()!.toLowerCase();
      let to: string | undefined;
      for (let i = 0; i < files.length; i++) {
        if (normalised[i] === name) { to = files[i]!.path; break; }
      }
      if (to && to !== from) out.add(from < to ? `${from}|${to}` : `${to}|${from}`);
    }
    return out;
  }

  it("resolves every unresolved edge to the same file as a per-edge scan, in bounded time", () => {
    const { files, symbols, edges } = corpus();
    const expected = referenceFileEdges(files, symbols, edges);
    expect(expected.size).toBeGreaterThan(1000);

    const started = performance.now();
    const canvas = buildCanvas({ symbols, edges, files, wikilinks: [] });
    const elapsedMs = performance.now() - started;

    const got = new Set(canvas.edges.map((e) => `${e.fromNode}|${e.toNode}`));
    expect(got).toEqual(expected);
    // 20k edges x 3k files is 60M basename normalisations per-edge; measured
    // 14.2 s on this machine before the fix. The bound is >10x the fixed cost
    // and >10x under the quadratic one, so it is not a timing coin-flip.
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("buildCanvas symbol-graph group is the full parent dir (consistent with file graph)", () => {
  it("uses the full directory path, not just the first two segments", () => {
    const symbols: VaultSymbol[] = [symbol(0, "a/b/c/Foo.cs"), symbol(1, "a/b/c/Bar.cs")];
    const canvas = buildCanvas({ symbols, edges: [], files: [file("a/b/c/Foo.cs"), file("a/b/c/Bar.cs")], wikilinks: [] });
    expect(canvas.nodes.every((n) => n.group === "a/b/c")).toBe(true);
  });
});
