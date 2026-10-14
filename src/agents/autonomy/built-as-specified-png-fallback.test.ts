/**
 * The compressed-size fallback in classifyPngBytes: what decides a PNG whose
 * pixels this reader cannot decode (here: Adam7-interlaced).
 *
 * Every image below is synthetic — shapes and noise drawn in this file — and
 * each one is encoded twice: once interlaced, so the fallback decides, and
 * once plain, so the pixel reader decides. The two readings must agree.
 */

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  classifyPngBytes,
  decodePngRgba,
  measurePngContent,
  pngChunksFit,
} from "./built-as-specified.js";

type Kind = "square" | "disc" | "noise" | "gradient" | "shadedBall";
type Rgba = readonly [number, number, number, number];

const FLAT: readonly Kind[] = ["square", "disc"];
const DRAWN: readonly Kind[] = ["noise", "gradient", "shadedBall"];
const SIZES = [32, 64, 256] as const;
/** Fastest and smallest deflate: a flat shape must stay flat at either effort. */
const LEVELS = [1, 9] as const;

const CLEAR: Rgba = [0, 0, 0, 0];

function pixelAt(kind: Kind, x: number, y: number, size: number, noise: () => number): Rgba {
  const centre = (size - 1) / 2;
  const radius = size * 0.4;
  const distance = Math.hypot(x - centre, y - centre);
  switch (kind) {
    case "square": {
      // A filled square with a one-pixel outline on a transparent ground.
      const margin = Math.floor(size * 0.15);
      const last = size - margin - 1;
      if (x < margin || x > last || y < margin || y > last) return CLEAR;
      return x === margin || x === last || y === margin || y === last ? [20, 20, 20, 255] : [40, 140, 200, 255];
    }
    case "disc":
      // A filled disc whose outline thickens with its size.
      if (distance > radius) return CLEAR;
      return distance > radius - Math.max(1, size / 32) ? [20, 20, 20, 255] : [220, 90, 40, 255];
    case "noise":
      return [noise(), noise(), noise(), 255];
    case "gradient":
      return [
        Math.round((255 * x) / (size - 1)),
        Math.round((255 * y) / (size - 1)),
        Math.round((255 * (x + y)) / (2 * (size - 1))),
        255,
      ];
    case "shadedBall": {
      // A ball lit from the upper left: smooth shading, no flat area inside it.
      if (distance > radius) return CLEAR;
      const light = Math.max(0, 1 - Math.hypot(x - centre + radius / 2, y - centre + radius / 2) / (1.6 * radius));
      return [Math.round(60 + 180 * light), Math.round(40 + 120 * light), Math.round(30 + 60 * light), 255];
    }
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const b of body) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, sum]);
}

/** Adam7 passes as [xStart, yStart, xStep, yStep] (PNG spec, section 8.2). */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/** An 8-bit RGBA PNG of `kind`, scanlines unfiltered, optionally Adam7-interlaced. */
function png(kind: Kind, size: number, opts: { interlaced: boolean; level: number }): Buffer {
  let seed = 0x5eed;
  const noise = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  };
  const pixels: Rgba[][] = [];
  for (let y = 0; y < size; y++) {
    const row: Rgba[] = [];
    for (let x = 0; x < size; x++) row.push(pixelAt(kind, x, y, size, noise));
    pixels.push(row);
  }
  const passes = opts.interlaced ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const scanlines: Buffer[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    if (x0 >= size || y0 >= size) continue;
    for (let y = y0; y < size; y += dy) {
      const line = [0]; // filter type 0: the bytes as they are
      for (let x = x0; x < size; x += dx) line.push(...pixels[y]![x]!);
      scanlines.push(Buffer.from(line));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[12] = opts.interlaced ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(scanlines), { level: opts.level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("classifyPngBytes, when the pixels cannot be decoded", () => {
  it("really is the fallback that decides an interlaced PNG", () => {
    const bytes = png("disc", 64, { interlaced: true, level: 9 });
    expect(pngChunksFit(bytes)).toBe(true);
    expect(decodePngRgba(bytes)).toBeNull();
    expect(measurePngContent(bytes)).toBeNull();
    // …while the same picture saved plainly is read by its pixels.
    expect(decodePngRgba(png("disc", 64, { interlaced: false, level: 9 }))).not.toBeNull();
  });

  for (const size of SIZES) {
    for (const level of LEVELS) {
      it(`calls a flat square and a flat disc placeholder-grade at ${size} px (deflate level ${level})`, () => {
        for (const kind of FLAT) {
          expect(classifyPngBytes(png(kind, size, { interlaced: true, level })), kind).toBe("placeholder");
        }
      });

      it(`calls noise, a gradient and a shaded ball art at ${size} px (deflate level ${level})`, () => {
        for (const kind of DRAWN) {
          expect(classifyPngBytes(png(kind, size, { interlaced: true, level })), kind).toBe("art");
        }
      });
    }
  }

  it("agrees with the pixel reader on the same pictures saved without interlacing", () => {
    for (const size of SIZES) {
      for (const kind of [...FLAT, ...DRAWN]) {
        const byPixels = classifyPngBytes(png(kind, size, { interlaced: false, level: 9 }));
        const bySize = classifyPngBytes(png(kind, size, { interlaced: true, level: 9 }));
        expect(bySize, `${kind} at ${size} px`).toBe(byPixels);
      }
    }
  });
});
