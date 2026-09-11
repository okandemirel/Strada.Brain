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
