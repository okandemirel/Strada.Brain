/**
 * The spec-scope gate speaks for any game, not the one it was written on
 *.
 *
 * Its instruction once carried one project's own vocabulary and structure and
 * sent them to every game, whose document may say none of it. A worker told to
 * build content the design never asked for builds it. The prompt is pinned
 * word for word below, so no such clause can come back unnoticed.
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
| Kiln 23 | Celadon Glaze |
| Kiln 47 | Raku Tongs |
| Kiln 71 | Slip Mould |
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
  it("names the missing elements and adds nothing the document did not say", () => {
    // The whole prompt, so a clause naming one project's layout, labels or
    // content plan fails here whatever words it uses.
    expect(specScopeText()).toBe(
      "[STRADA SPEC SCOPE] The design document schedules 3 elements; 2 have no implementation in this project: " +
        "Celadon Glaze (Kiln 23), Slip Mould (Kiln 71). " +
        "The spec is the contract — a delivery that omits scheduled elements is partial, not done. " +
        "Implement each as the design document specifies it — its rules and its interactions with the other " +
        "elements — following the project's module pattern, and make it reachable in the shipped game.",
    );
  });

  it("names the campaign's GDD file when one holds the document", () => {
    const text = specScopeText({ text: GDD, path: "docs/PotteryBook.md" }) ?? "";
    expect(text).toContain("Celadon Glaze (Kiln 23)");
    expect(text).toContain("Implement each as docs/PotteryBook.md specifies it");
  });

  it("never sends a text-only campaign's run to look for a design file (review gdd-W10)", () => {
    // The campaign's GDD is in no file; docs/ here holds a document, and it
    // is not that one. "As the design document specifies it" sent the run to it.
    const text = specScopeText({ text: GDD }) ?? "";
    expect(text).toContain("Celadon Glaze (Kiln 23)");
    expect(text).not.toContain("as the design document specifies it");
    expect(text).toContain("campaign's GDD is not saved in the project, so no file holds it");
    expect(text).toContain("do not look for one");
  });
});
