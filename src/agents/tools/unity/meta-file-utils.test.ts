/**
 * Measured 2026-09-08 03:54 in a workspace lease under macOS's temp
 * directory: validatePath returns the real path (/private/var/…), the tool
 * context carries the lexical one (/var/…), and shouldGenerateMeta judged
 * every file "outside the project" — no .meta written, eleven scene metas
 * orphaned by delete. The project root must count in both forms.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldGenerateMeta } from "./meta-file-utils.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A project reachable by two names: its real directory and a symlink to it. */
function linkedProject(): { real: string; link: string } {
  const base = mkdtempSync(join(tmpdir(), "meta-roots-"));
  dirs.push(base);
  mkdirSync(join(base, "project", "Assets"), { recursive: true });
  const real = realpathSync.native(join(base, "project"));
  const link = join(base, "link");
  symlinkSync(join(base, "project"), link);
  return { real, link };
}

describe("shouldGenerateMeta across a symlinked project root", () => {
  it("accepts a real file path when the project is given by its symlink (the lease case)", () => {
    const { real, link } = linkedProject();
    expect(shouldGenerateMeta(join(real, "Assets", "Scenes", "Main.unity"), link)).toBe(true);
  });

  it("accepts a symlinked file path when the project is given by its real path", () => {
    const { real, link } = linkedProject();
    expect(shouldGenerateMeta(join(link, "Assets", "Art", "Pig.png"), real)).toBe(true);
  });

  it("still refuses what is outside Assets/, in either form", () => {
    const { real, link } = linkedProject();
    expect(shouldGenerateMeta(join(real, "ProjectSettings", "x.asset"), link)).toBe(false);
    expect(shouldGenerateMeta(join(real, "Assets", "Library", "x.png"), link)).toBe(false);
    expect(shouldGenerateMeta(join(real, "Assets", "x.png.meta"), link)).toBe(false);
    expect(shouldGenerateMeta(join(real, "..", "elsewhere", "Assets", "x.png"), link)).toBe(false);
  });

  it("does not need the project to exist (lexical roots only)", () => {
    expect(shouldGenerateMeta("/nowhere/proj/Assets/a.cs", "/nowhere/proj")).toBe(true);
    expect(shouldGenerateMeta("/nowhere/other/Assets/a.cs", "/nowhere/proj")).toBe(false);
  });
});
