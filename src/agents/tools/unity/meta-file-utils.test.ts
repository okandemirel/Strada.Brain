/**
 * Measured 2026-09-08 03:54 in a workspace lease under macOS's temp
 * directory: validatePath returns the real path (/private/var/…), the tool
 * context carries the lexical one (/var/…), and shouldGenerateMeta judged
 * every file "outside the project" — no .meta written, eleven scene metas
 * orphaned by delete. The project root must count in both forms.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldGenerateMeta, writeImporterMeta } from "./meta-file-utils.js";

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

/**
 * Audit A5 / D56 (Codex #14): regeneration rewrote the whole .meta from the
 * template; only the guid was recovered. Pivot, PPU, slices, mesh scale and
 * audio load settings authored in the Inspector were reset on every re-draw.
 */
describe("writeImporterMeta keeps an authored meta of the right importer (audit A5 / D56)", () => {
  const GUID = "0123456789abcdef0123456789abcdef";
  const template = (importer: string) => (guid: string): string =>
    `fileFormatVersion: 2\nguid: ${guid}\n${importer}:\n  externalObjects: {}\n  textureType: 8\n  spritePixelsToUnits: 100\n`;
  const authoredSprite = [
    "fileFormatVersion: 2",
    `guid: ${GUID}`,
    "TextureImporter:",
    "  externalObjects: {}",
    "  spriteMode: 2",
    "  alignment: 9",
    "  spritePivot: {x: 0.25, y: 0}",
    "  spritePixelsToUnits: 16",
    "  textureType: 8",
    "  spriteSheet:",
    "    sprites:",
    "    - name: Hero_0",
    "      rect: {x: 0, y: 0, width: 32, height: 32}",
    "    - name: Hero_1",
    "      rect: {x: 32, y: 0, width: 32, height: 32}",
    "",
  ].join("\n");
  function metaFile(content?: string): string {
    const base = mkdtempSync(join(tmpdir(), "meta-keep-"));
    dirs.push(base);
    const path = join(base, "Hero.png.meta");
    if (content !== undefined) writeFileSync(path, content, "utf8");
    return path;
  }

  it("a TextureImporter meta with PPU 16, a custom pivot and two slices survives byte for byte", () => {
    const path = metaFile(authoredSprite);
    const r = writeImporterMeta(path, "TextureImporter", template("TextureImporter"));
    expect(r).toEqual({ guid: GUID, kept: true });
    expect(readFileSync(path, "utf8")).toBe(authoredSprite);
  });

  it("only textureType is enforced on a TextureImporter: a plain texture becomes a Sprite, the rest stays", () => {
    const path = metaFile(authoredSprite.replace("  textureType: 8", "  textureType: 0"));
    const r = writeImporterMeta(path, "TextureImporter", template("TextureImporter"));
    expect(r.kept).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(authoredSprite);
  });

  it("Model and Audio importer metas are kept untouched", () => {
    for (const importer of ["ModelImporter", "AudioImporter"] as const) {
      const authored = `fileFormatVersion: 2\nguid: ${GUID}\n${importer}:\n  externalObjects: {}\n  globalScale: 0.01\n  loadType: 1\n`;
      const path = metaFile(authored);
      expect(writeImporterMeta(path, importer, template(importer))).toEqual({ guid: GUID, kept: true });
      expect(readFileSync(path, "utf8")).toBe(authored);
    }
  });

  it("guard: a meta of the WRONG importer type is replaced by the template — with its guid", () => {
    const path = metaFile(`fileFormatVersion: 2\nguid: ${GUID}\nDefaultImporter:\n  externalObjects: {}\n`);
    const r = writeImporterMeta(path, "TextureImporter", template("TextureImporter"));
    expect(r).toEqual({ guid: GUID, kept: false });
    expect(readFileSync(path, "utf8")).toBe(template("TextureImporter")(GUID));
    // …and a texture meta on what is now a mesh is replaced the same way.
    const path2 = metaFile(authoredSprite);
    expect(writeImporterMeta(path2, "ModelImporter", template("ModelImporter"))).toEqual({ guid: GUID, kept: false });
    expect(readFileSync(path2, "utf8")).toBe(template("ModelImporter")(GUID));
  });

  // Codex review 2026-09-17: "same importer" kept a TextureImporter whose
  // spriteMode was 0 (no usable sprite) and kept sheet slices that no longer
  // fit the regenerated image.
  it("spriteMode 0 becomes 1 (Single) with every other authored field kept; with slices it becomes 2", () => {
    const noSlices = authoredSprite
      .replace("  spriteMode: 2", "  spriteMode: 0")
      .replace(/    sprites:\n(?:    - name: .*\n      rect: .*\n)+/, "    sprites: []\n");
    expect(noSlices).toContain("spriteMode: 0");
    expect(noSlices).not.toContain("rect:");
    const path = metaFile(noSlices);
    expect(writeImporterMeta(path, "TextureImporter", template("TextureImporter"))).toEqual({ guid: GUID, kept: true });
    expect(readFileSync(path, "utf8")).toBe(noSlices.replace("  spriteMode: 0", "  spriteMode: 1"));

    const withSlices = metaFile(authoredSprite.replace("  spriteMode: 2", "  spriteMode: 0"));
    expect(writeImporterMeta(withSlices, "TextureImporter", template("TextureImporter")).kept).toBe(true);
    expect(readFileSync(withSlices, "utf8")).toBe(authoredSprite); // back to Multiple, slices intact
  });

  it("a 1024-wide sheet regenerated at 512×512 falls back to the template, guid kept, and says why", () => {
    const wide = authoredSprite.replace("rect: {x: 32, y: 0, width: 32, height: 32}", "rect: {x: 512, y: 0, width: 512, height: 512}");
    const path = metaFile(wide);
    const r = writeImporterMeta(path, "TextureImporter", template("TextureImporter"), { image: { width: 512, height: 512 } });
    expect(r.guid).toBe(GUID);
    expect(r.kept).toBe(false);
    expect(r.reason).toMatch(/1 of 2 sprite-sheet slices no longer fit the regenerated 512×512 image/);
    expect(readFileSync(path, "utf8")).toBe(template("TextureImporter")(GUID));
  });

  it("guard: a sheet whose slices still fit is kept; without image dimensions nothing is judged", () => {
    const path = metaFile(authoredSprite); // slices end at x=64, y=32
    expect(writeImporterMeta(path, "TextureImporter", template("TextureImporter"), { image: { width: 64, height: 32 } })).toEqual({ guid: GUID, kept: true });
    expect(readFileSync(path, "utf8")).toBe(authoredSprite);
    const wide = metaFile(authoredSprite.replace("rect: {x: 32, y: 0, width: 32, height: 32}", "rect: {x: 512, y: 0, width: 512, height: 512}"));
    expect(writeImporterMeta(wide, "TextureImporter", template("TextureImporter")).kept).toBe(true);
  });

  it("guard: no meta at all gets the template with a fresh guid; a meta with no guid gets one too", () => {
    const path = metaFile();
    const r = writeImporterMeta(path, "TextureImporter", template("TextureImporter"));
    expect(r.kept).toBe(false);
    expect(r.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(path, "utf8")).toBe(template("TextureImporter")(r.guid));
    const noGuid = metaFile("fileFormatVersion: 2\nTextureImporter:\n  textureType: 8\n");
    expect(writeImporterMeta(noGuid, "TextureImporter", template("TextureImporter")).kept).toBe(false);
  });
});
