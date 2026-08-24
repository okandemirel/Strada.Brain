import { describe, it, expect } from "vitest";
import { extractScheduledElements, elementCodeTokens, assessSpecScope } from "./spec-scope.js";

const GDD_SNIPPET = `
## 4. GAME ELEMENTS

### 4.1 Element Introduction Schedule

| Unlock | Element | One-line pitch |
|--------|---------|----------------|
| L21 | Hard Pixel | Armored cube, 2 hits |
| L36 | Ice Block | Encased cube |
| L46 | Wall | Indestructible shaping cell |
| L61 | Lock & Key | Region sealed until key cleared |
`;

describe("spec scope — the design document is the checklist", () => {
  it("extracts the element schedule from a GDD-style table", () => {
    const els = extractScheduledElements(GDD_SNIPPET);
    expect(els.map((e) => e.name)).toEqual(["Hard Pixel", "Ice Block", "Wall", "Lock & Key"]);
    expect(els[0]?.unlock).toBe("L21");
  });

  it("builds code-token shapes an implementation might use", () => {
    expect(elementCodeTokens("Ice Block")).toContain("IceBlock");
    expect(elementCodeTokens("Lock & Key")).toContain("LockKey");
  });

  it("names scheduled elements missing from Assets code", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const root = mkdtempSync(join(tmpdir(), "spec-scope-"));
    try {
      const docs = join(root, "docs");
      mkdirSync(docs, { recursive: true });
      const gdd = join(docs, "GDD.md");
      writeFileSync(gdd, GDD_SNIPPET + "\n# rest of a large document\n" + "x".repeat(500));
      const scripts = join(root, "Assets", "Modules", "M", "Scripts");
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, "IceBlock.cs"), "public class IceBlock {}");

      const report = assessSpecScope(root);
      expect(report.scheduled).toBe(4);
      expect(report.missing.map((m) => m.name)).toEqual(["Hard Pixel", "Wall", "Lock & Key"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
