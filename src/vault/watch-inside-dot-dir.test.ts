import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A vault that lives inside .strada must still watch itself.
 *
 * The ignore pattern excludes Library, Temp, .git, node_modules and .strada,
 * and it was tested against the absolute path. The dev-knowledge vault is
 * rooted at `<project>/.strada/knowledge`, so every path beneath it contains
 * `/.strada/` and matched: that watcher ignored its entire vault and had never
 * once fired.
 *
 * Measured 2026-08-22: notes edited while a run was live stayed in the index
 * exactly as they had been. Two chunks still named a project that had been
 * deleted and scrubbed from every file on disk, and the next plan sent a goal
 * to audit it.
 */

const source = readFileSync("src/vault/watcher.ts", "utf8");

describe("what the watcher ignores", () => {
  it("judges a path by where it sits in the vault, not by the vault's own address", () => {
    const call = source.slice(source.indexOf("ignored:"), source.indexOf("ignored:") + 220);

    expect(call, "the ignore test still runs against the absolute path").not.toMatch(
      /ignored:\s*\(path\)\s*=>\s*IGNORE_REGEX\.test\(path\.replaceAll/u,
    );
    expect(call).toMatch(/relative|computeRel|rel\b/u);
  });

  it("still ignores the directories it is meant to ignore", () => {
    // The intent has to survive: a Library or .git folder *inside* a vault is
    // still noise, and removing the rule would be worse than the bug.
    expect(source).toContain("Library");
    expect(source).toContain("node_modules");
    expect(source).toContain(".strada");
  });
});
