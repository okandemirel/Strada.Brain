/**
 * The spec-scope gate speaks for any game, not the one it was written on
 * (GDD-drift trace M4, 2026-10-11).
 *
 * It told every run to implement a missing element "in the sim module with
 * its R-rule interactions and a level that showcases it": the test vehicle's
 * own rule labels, its module layout and a level-based structure, sent to a
 * game whose document may have none of them. A worker told to build a
 * showcase level builds content the design never asked for.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { StradaConformanceGuard } from "./strada-conformance.js";
import type { RunDesignDoc } from "./run-design-doc.js";

const GDD = `
## Pottery shelf

| Opens at | Ware |
|----------|------|
| Kiln 5 | Celadon Glaze |
| Kiln 17 | Raku Tongs |
| Kiln 33 | Slip Mould |
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function specScopeText(designDoc?: RunDesignDoc): string | null {
  const root = mkdtempSync(join(os.tmpdir(), "spec-scope-wording-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "GDD.md"), `${GDD}\n# rest of a large document\n${"x".repeat(500)}`);
  const scripts = join(root, "Assets", "Modules", "M", "Scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "RakuTongs.cs"), "public class RakuTongs {}");
  const guard = new StradaConformanceGuard(undefined, { projectPath: root, enabled: true, designDoc });
  (guard as unknown as { wroteProjectCode: boolean }).wroteProjectCode = true;
  return (guard as unknown as { specScopePrompt(): string | null }).specScopePrompt();
}

describe("the spec-scope prompt", () => {
  it("names the missing elements without a test vehicle's rule labels or level structure", () => {
    const text = specScopeText() ?? "";
    expect(text).toContain("[STRADA SPEC SCOPE]");
    expect(text).toContain("Celadon Glaze (Kiln 5)");
    expect(text).not.toMatch(/R-rule|showcases|sim module/i);
    expect(text).toContain("as the design document specifies it");
  });

  it("names the campaign's GDD file when one holds the document", () => {
    const text = specScopeText({ text: GDD, path: "docs/PotteryBook.md" }) ?? "";
    expect(text).toContain("Celadon Glaze (Kiln 5)");
    expect(text).toContain("Implement each as docs/PotteryBook.md specifies it");
  });

  it("never sends a text-only campaign's run to look for a design file (review gdd-W10)", () => {
    // The campaign's GDD is in no file; docs/ here holds a document, and it
    // is not that one. "As the design document specifies it" sent the run to it.
    const text = specScopeText({ text: GDD }) ?? "";
    expect(text).toContain("Celadon Glaze (Kiln 5)");
    expect(text).not.toContain("as the design document specifies it");
    expect(text).toContain("campaign's GDD is not saved in the project, so no file holds it");
    expect(text).toContain("do not look for one");
  });
});
