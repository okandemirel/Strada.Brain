import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PreviousAsset } from "./generated-asset-guard.js";

/** A real PNG: `flat` is one colour everywhere, `noise` is drawn art. */
function png(width: number, height: number, kind: "flat" | "noise"): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      const v = kind === "flat" ? 40 : (x * 37 + y * 91) % 251;
      raw[at++] = v; raw[at++] = (v * 7) % 251; raw[at++] = (v * 13) % 251; raw[at++] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("what already sits at a generation target", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "strada-guard-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("classifies the BYTES, not the backup's filename (Codex 2026-09-11 N#5)", () => {
    // The backup is written as `<asset>.strada-prev`, and the classifier only
    // looked at paths ending in .png — so every placeholder under a backup
    // name came back "real art" and generation refused to replace it.
    const flat = join(dir, "Flat.png");
    writeFileSync(flat, png(64, 64, "flat"));
    expect(new PreviousAsset(flat).existingIsRealArt).toBe(false);

    const drawn = join(dir, "Hero.png");
    writeFileSync(drawn, png(64, 64, "noise"));
    expect(new PreviousAsset(drawn).existingIsRealArt).toBe(true);

    // An unreadable file is not real art either.
    const empty = join(dir, "Empty.png");
    writeFileSync(empty, Buffer.alloc(0));
    expect(new PreviousAsset(empty).existingIsRealArt).toBe(false);

    // …and nothing at the target at all is not art.
    expect(new PreviousAsset(join(dir, "Absent.png")).existingIsRealArt).toBe(false);
  });

  it("two generations at one path do not share backups, and a failed restore keeps them (Codex 2026-09-11 N#9)", () => {
    const target = join(dir, "Hero.png");
    const original = png(64, 64, "noise");
    writeFileSync(target, original);
    const first = new PreviousAsset(target);
    const second = new PreviousAsset(target);
    // Two calls, two backups: the first to finish used to delete the only
    // copy the second could restore from.
    first.commit();
    writeFileSync(target, Buffer.alloc(3)); // the second call damaged its output
    second.restore();
    expect(readFileSync(target).equals(original)).toBe(true);

    // A restore that could not put the file back keeps what it has: deleting
    // the backups in a finally block threw away the only surviving copy.
    const third = new PreviousAsset(target);
    rmSync(target, { force: true });
    mkdirSync(target, { recursive: true }); // a directory where the file was: the copy cannot land
    expect(() => third.restore()).toThrow();
    expect(readdirSync(dir).some((f) => f.includes(".strada-prev"))).toBe(true);
  });

  it("does not roll back art another generation COMMITTED, and a failed restore can be repeated (Codex 2026-09-11 O#17)", () => {
    const target = join(dir, "Hero.png");
    const original = png(64, 64, "noise");
    writeFileSync(target, original);
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);

    // A draws and commits.
    const newArt = png(64, 64, "flat");
    writeFileSync(target, newArt);
    a.commit();

    // B then fails and restores ITS snapshot — which is the OLD image, and
    // would erase art that has already been committed.
    b.restore();
    expect(readFileSync(target).equals(newArt)).toBe(true);

    // A restore that could not put the file back may be repeated once the
    // filesystem allows it: `done` used to be set before the copy.
    const c = new PreviousAsset(target);
    writeFileSync(target, Buffer.alloc(4));
    rmSync(target, { force: true });
    mkdirSync(target, { recursive: true });
    expect(() => c.restore()).toThrow();
    rmSync(target, { recursive: true, force: true });
    c.restore();
    expect(readFileSync(target).equals(newArt)).toBe(true);
    // …and once it HAS succeeded it is finished: calling it again is a no-op,
    // not a second copy from backups that are already gone.
    expect(() => c.restore()).not.toThrow();
    expect(readFileSync(target).equals(newArt)).toBe(true);
  });

  it("a failed overlapping generation puts back the COMMITTED art, not its own stale snapshot (Codex 2026-09-12 P#19)", () => {
    const target = join(dir, "Hero.png");
    const original = png(64, 64, "noise");
    writeFileSync(target, original);
    writeFileSync(`${target}.meta`, "guid: original");
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);

    const committed = png(48, 48, "noise");
    writeFileSync(target, committed);
    writeFileSync(`${target}.meta`, "guid: committed");
    a.commit();

    // B's draw is damaged and overwrites A's committed bytes, so the
    // "is their art still on disk" guard cannot see them any more. Restoring
    // B's snapshot here erases art that had been committed.
    writeFileSync(target, Buffer.alloc(9));
    b.restore();

    expect(readFileSync(target).equals(committed)).toBe(true);
    expect(readFileSync(`${target}.meta`, "utf8")).toBe("guid: committed");
    // Nothing of the retained copies is left behind once every generation has
    // settled — Unity would import them as assets of their own.
    expect(readdirSync(dir).sort()).toEqual(["Hero.png", "Hero.png.meta"]);
  });

  it("puts back a DAMAGED .meta beside intact committed art (Codex 2026-09-12 Q#6)", () => {
    const target = join(dir, "Hero.png");
    writeFileSync(target, png(64, 64, "noise"));
    writeFileSync(`${target}.meta`, "guid: original");
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);

    const committed = png(48, 48, "noise");
    writeFileSync(target, committed);
    writeFileSync(`${target}.meta`, "guid: committed");
    a.commit();

    // B damages ONLY the importer. The image's digest still matches, so the
    // "their art is intact" guard used to return and leave it damaged.
    writeFileSync(`${target}.meta`, "guid: DAMAGED");
    b.restore();

    expect(readFileSync(target).equals(committed)).toBe(true);
    expect(readFileSync(`${target}.meta`, "utf8")).toBe("guid: committed");
  });

  it("does not put back a stale snapshot when the committed copy is gone (Codex 2026-09-12 Q#6)", () => {
    const target = join(dir, "Hero.png");
    const original = png(64, 64, "noise");
    writeFileSync(target, original);
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);

    const committed = png(48, 48, "noise");
    writeFileSync(target, committed);
    a.commit();
    // The retention copy is lost (a crash, a cleanup, a full disk).
    for (const f of readdirSync(dir)) {
      if (f.includes(".strada-committed-")) rmSync(join(dir, f), { force: true });
    }

    writeFileSync(target, Buffer.alloc(9)); // B's damaged draw
    b.restore();

    // The damaged draw is visible and regenerable; silently reverting to the
    // pre-commit original would erase committed art and look fine.
    expect(readFileSync(target).equals(original)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["Hero.png"]);
  });

  it("a superseded retained copy does not outlive the commit that replaced it (Codex 2026-09-12 Q#6)", () => {
    const target = join(dir, "Hero.png");
    writeFileSync(target, png(64, 64, "noise"));
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);
    const c = new PreviousAsset(target);

    writeFileSync(target, png(48, 48, "noise"));
    a.commit();
    const second = png(32, 32, "noise");
    writeFileSync(target, second);
    b.commit();
    c.restore();

    // C's failure puts back the NEWEST committed image, and nothing is left
    // beside it for Unity to import.
    expect(readFileSync(target).equals(second)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["Hero.png"]);
  });

  it("restores the committed pair's ABSENCE of a .meta, and keeps nothing half-copied (Codex 2026-09-12 S#9)", () => {
    const target = join(dir, "Hero.png");
    writeFileSync(target, png(64, 64, "noise"));
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);

    // A committed image with NO .meta beside it.
    const committed = png(48, 48, "noise");
    writeFileSync(target, committed);
    a.commit();

    // B damages the image AND writes a .meta the committed state never had.
    writeFileSync(target, Buffer.alloc(9));
    writeFileSync(`${target}.meta`, "guid: DAMAGED");
    b.restore();

    expect(readFileSync(target).equals(committed)).toBe(true);
    // The unexpected .meta used to survive the restore.
    expect(readdirSync(dir).sort()).toEqual(["Hero.png"]);
  });

  it("an unwanted .meta beside INTACT committed art is still removed (Codex 2026-09-12 T#5)", () => {
    // The committed pair had no .meta, so its digest was undefined and the
    // "their art is intact" shortcut counted that as intact — a damaged .meta
    // written afterwards survived the rollback with the image untouched.
    const target = join(dir, "Hero.png");
    writeFileSync(target, png(64, 64, "noise"));
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);

    const committed = png(48, 48, "noise");
    writeFileSync(target, committed);
    a.commit();

    // B leaves the image ALONE and only adds metadata that was never there.
    writeFileSync(`${target}.meta`, "guid: DAMAGED");
    b.restore();

    expect(readFileSync(target).equals(committed)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["Hero.png"]);
  });

  it("a retention that failed leaves nothing behind for Unity to import (Codex 2026-09-12 T#6)", () => {
    // With three generations open, A retained its pair and B's retention
    // failed: B's record replaced A's, so A's copies were referenced by
    // nothing and stayed in Assets/ for good.
    const target = join(dir, "Hero.png");
    writeFileSync(target, png(64, 64, "noise"));
    writeFileSync(`${target}.meta`, "guid: original");
    const a = new PreviousAsset(target);
    const b = new PreviousAsset(target);
    const c = new PreviousAsset(target);

    writeFileSync(target, png(48, 48, "noise"));
    a.commit();
    // B commits with its .meta unreadable: the retention cannot be completed.
    writeFileSync(target, png(32, 32, "noise"));
    rmSync(`${target}.meta`, { force: true });
    mkdirSync(`${target}.meta`, { recursive: true }); // a directory where a file must be
    b.commit();
    rmSync(`${target}.meta`, { recursive: true, force: true });
    c.restore();

    // Whatever the outcome of the restore, nothing is left beside the asset.
    expect(readdirSync(dir).filter((f) => f.includes(".strada-committed-"))).toEqual([]);
  });

  it("restores the previous pair byte for byte", () => {
    const target = join(dir, "Hero.png");
    const original = png(64, 64, "noise");
    writeFileSync(target, original);
    writeFileSync(`${target}.meta`, "guid: abc");
    const prev = new PreviousAsset(target);
    writeFileSync(target, Buffer.alloc(10));
    prev.restore();
    expect(readFileSync(target).equals(original)).toBe(true);
    expect(readFileSync(`${target}.meta`, "utf8")).toBe("guid: abc");
  });
});
