/**
 * Procedural sprite generation for the autonomous game-build path.
 *
 * Measured 2026-08-26 (PixelFlow, stated by the user): prefab structures get
 * created while scenes stay empty, and no gate ever forces the production of
 * assets that belong to the target game. The conformance layer can SAY "check
 * unity_my_assets_cloud before making art" — but until now nothing in the toolchain
 * could MAKE any. The art that does exist in that project came from ad-hoc
 * editor scripts the agent happened to improvise.
 *
 * This tool makes asset production a capability the agent always has: a flat,
 * pixel-art-style sprite written straight into Assets/ with a Unity .meta
 * that imports it as a Sprite (textureType 8) — no Editor, no bridge, no
 * network, no new dependency (PNG framing + zlib via node:zlib).
 *
 * The output is deliberately placeholder-grade: readable silhouettes with a
 * darker outline and a light band, distinct per element. Sourced art from
 * unity_my_assets_cloud stays the preferred option; this is the floor every GDD
 * element can always reach.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { reuseOrMintGuid } from "./meta-file-utils.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { validatePath } from "../../../security/path-guard.js";

// =============================================================================
// PNG ENCODER (RGBA8, filter-0 scanlines)
// =============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA buffer size mismatch: got ${rgba.length}, want ${width * height * 4}`);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // compression (10), filter (11), interlace (12) stay 0

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => {
      raw[rowStart + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// =============================================================================
// SHAPES
// =============================================================================

export const SPRITE_SHAPES = [
  "square",
  "rounded",
  "circle",
  "diamond",
  "triangle",
  "star",
  "ring",
  "creature",
  "arrow",
  "capsule",
] as const;

export type SpriteShape = (typeof SPRITE_SHAPES)[number];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHexColor(input: string): Rgb | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return undefined;
  const v = parseInt(m[1]!, 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function shade(c: Rgb, factor: number): Rgb {
  return {
    r: Math.min(255, Math.round(c.r * factor)),
    g: Math.min(255, Math.round(c.g * factor)),
    b: Math.min(255, Math.round(c.b * factor)),
  };
}

/** Deterministic, pleasant-enough base colour from the element name. */
function colorFromName(name: string): Rgb {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = (h % 360) / 360;
  // HSL→RGB with fixed saturation/lightness keeps a coherent palette across elements.
  const s = 0.62;
  const l = 0.55;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(conv(hue + 1 / 3) * 255),
    g: Math.round(conv(hue) * 255),
    b: Math.round(conv(hue - 1 / 3) * 255),
  };
}

/** A deterministic shape when the caller did not pick one. */
function shapeFromName(name: string): SpriteShape {
  let h = 0;
  for (const ch of name) h = (h * 17 + ch.charCodeAt(0)) >>> 0;
  return SPRITE_SHAPES[h % SPRITE_SHAPES.length]!;
}

type Grid = (Rgb | null)[][];

function makeGrid(size: number): Grid {
  return Array.from({ length: size }, () => Array<Rgb | null>(size).fill(null));
}

function fillEllipse(grid: Grid, cx: number, cy: number, rx: number, ry: number, color: Rgb): void {
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid.length; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) grid[y]![x] = color;
    }
  }
}

function fillRect(grid: Grid, x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
  for (let y = Math.max(0, y0); y <= Math.min(grid.length - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(grid.length - 1, x1); x++) {
      grid[y]![x] = color;
    }
  }
}

function pointInTriangle(px: number, py: number, size: number): boolean {
  // Upright triangle: apex top-center, base along the bottom margin.
  const margin = size * 0.12;
  const apex = { x: size / 2, y: margin };
  const baseY = size - margin;
  if (py < apex.y || py > baseY) return false;
  const halfWidth = ((py - apex.y) / (baseY - apex.y)) * (size / 2 - margin);
  return Math.abs(px - apex.x) <= halfWidth;
}

function starArm(x: number, y: number, size: number): boolean {
  // 4-point star: diamond with concave sides via sum-of-axes metric.
  const c = size / 2;
  const dx = Math.abs(x - c);
  const dy = Math.abs(y - c);
  const r = size * 0.42;
  return dx + dy <= r || dx * dx + dy * dy <= (r * 0.45) ** 2;
}

function renderShape(shape: SpriteShape, size: number, base: Rgb, accent: Rgb): Grid {
  const grid = makeGrid(size);
  const margin = Math.round(size * 0.1);
  const c = (size - 1) / 2;
  const r = (size - 1) / 2 - margin;

  switch (shape) {
    case "square":
    case "rounded":
      fillRect(grid, margin, margin, size - 1 - margin, size - 1 - margin, base);
      break;
    case "capsule":
      fillEllipse(grid, c, c, r * 0.62, r, base);
      fillRect(grid, Math.round(c - r * 0.62), margin, Math.round(c + r * 0.62), size - 1 - margin, base);
      break;
    case "circle":
      fillEllipse(grid, c, c, r, r, base);
      break;
    case "ring": {
      fillEllipse(grid, c, c, r, r, base);
      fillEllipse(grid, c, c, r * 0.45, r * 0.45, accent);
      break;
    }
    case "diamond":
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (Math.abs(x - c) + Math.abs(y - c) <= r) grid[y]![x] = base;
        }
      }
      break;
    case "triangle":
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (pointInTriangle(x, y, size)) grid[y]![x] = base;
        }
      }
      break;
    case "star":
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (starArm(x, y, size)) grid[y]![x] = base;
        }
      }
      break;
    case "arrow":
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const inShaft = Math.abs(y - c) <= r * 0.3 && x >= margin && x <= size * 0.62;
          const inHead = x > size * 0.5 && Math.abs(y - c) <= (size - margin - x) * 0.9;
          if (inShaft || inHead) grid[y]![x] = base;
        }
      }
      break;
    case "creature": {
      fillEllipse(grid, c, c + size * 0.04, r * 0.95, r * 0.88, base);
      // Eyes — the cheapest way to read as a character.
      const eyeY = Math.round(c - r * 0.25);
      const eyeDX = Math.round(r * 0.38);
      const eyeR = Math.max(1, Math.round(size * 0.07));
      fillEllipse(grid, c - eyeDX, eyeY, eyeR, eyeR, { r: 255, g: 255, b: 255 });
      fillEllipse(grid, c + eyeDX, eyeY, eyeR, eyeR, { r: 255, g: 255, b: 255 });
      const pupilR = Math.max(1, Math.round(size * 0.035));
      fillEllipse(grid, c - eyeDX, eyeY, pupilR, pupilR, { r: 20, g: 20, b: 20 });
      fillEllipse(grid, c + eyeDX, eyeY, pupilR, pupilR, { r: 20, g: 20, b: 20 });
      break;
    }
  }
  return grid;
}

/** Outline + top light-band so sprites read as objects, not stains.
 *  Style-aware: the game's own profile decides whether an outline exists at
 *  all, its colour, and whether the gloss band is drawn — a "realistic,
 *  no-outline" GDD must not get outlined toon blobs. */
function finishGrid(
  grid: Grid,
  base: Rgb,
  styleOpts?: { outlineWidth?: number; outlineColor?: Rgb; gloss?: boolean },
): void {
  const size = grid.length;
  const outline = styleOpts?.outlineColor ?? shade(base, 0.5);
  const light = shade(base, 1.3);
  const drawOutline = (styleOpts?.outlineWidth ?? 1) > 0;
  const drawGloss = styleOpts?.gloss !== false;

  // Outline: any transparent pixel touching a filled one becomes outline.
  const copy = grid.map((row) => [...row]);
  if (drawOutline) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (copy[y]![x] !== null) continue;
      const touches =
        (y > 0 && copy[y - 1]![x] !== null) ||
        (y < size - 1 && copy[y + 1]![x] !== null) ||
        (x > 0 && copy[y]![x - 1] !== null) ||
        (x < size - 1 && copy[y]![x + 1] !== null);
      if (touches) grid[y]![x] = outline;
    }
  }
  }
  // Light band across the top quarter of filled pixels.
  if (drawGloss) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = copy[y]?.[x];
      if (px == null || y >= size * 0.3) continue;
      const isBase = px.r === base.r && px.g === base.g && px.b === base.b;
      if (isBase) grid[y]![x] = light;
    }
  }
  }
}

function gridToRgba(grid: Grid): Uint8Array {
  const size = grid.length;
  const rgba = new Uint8Array(size * size * 4);
  let i = 0;
  for (const row of grid) {
    for (const px of row) {
      if (px === null) {
        rgba[i + 3] = 0;
      } else {
        rgba[i] = px.r;
        rgba[i + 1] = px.g;
        rgba[i + 2] = px.b;
        rgba[i + 3] = 255;
      }
      i += 4;
    }
  }
  return rgba;
}

// =============================================================================
// UNITY .META (Sprite import settings, fresh guid)
// =============================================================================

export function spriteMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 13
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
    flipGreenChannel: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  npotScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 1
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: 100
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 8
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  ignorePngGamma: 0
  applyGammaDecoding: 0
  swizzle: 50462976
  cookieLightType: 0
  platformSettingsOverrides: {}
  spriteSheet:
    serializedVersion: 2
    sprites: []
    outline: []
    physicsShape: []
    bones: []
    spriteID: 5e97eb03825dee720800000000000000
    internalID: 0
    vertices: []
    indices:
    edges: []
    weights: []
    secondaryTextures: []
    nameFileIdTable: {}
  mipmapLimitGroupName:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

// =============================================================================
// TOOL
// =============================================================================

export class SpriteGenerateTool implements ITool {
  readonly name = "unity_generate_sprite";
  readonly description =
    "Generate a placeholder-grade sprite for a game element and write it into the project " +
    "as a Unity Sprite (PNG + import .meta, no Editor needed). Use when a GDD element has no " +
    "art and unity_my_assets_cloud turned up nothing the user already owns. Distinct shapes and " +
    "colours per element keep captured frames honest — a scene full of generated sprites still " +
    "proves what renders and what does not.";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Element name the sprite is for, e.g. 'Rocket' or 'FrozenPig'. Also the file name.",
      },
      path: {
        type: "string",
        description: "Project-relative output directory under Assets/ (default: Assets/Art/Generated).",
      },
      shape: {
        type: "string",
        enum: SPRITE_SHAPES,
        description: "Silhouette. Omit for a deterministic pick from the name.",
      },
      color: {
        type: "string",
        description: "Base colour as #rrggbb. Omit for a deterministic palette pick from the name.",
      },
      accent: {
        type: "string",
        description: "Detail colour as #rrggbb (ring core etc.). Default: white.",
      },
      size: {
        type: "number",
        description: "Square size in pixels, 16–256 (default 64).",
      },
      provider: {
        type: "string",
        enum: ["procedural", "local"],
        description:
          "'procedural' = built-in placeholder shapes (always works, offline). 'local' = open-weights " +
          "diffusion model on this machine (real art quality; install via `strada assets-local-setup`).",
      },
      prompt: {
        type: "string",
        description: "local only: the diffusion prompt. Default: a flat pixel-art mobile sprite of the name.",
      },
      negative: {
        type: "string",
        description: "local only: negative prompt (default: blurry, photo, watermark, text, cropped).",
      },
      model: {
        type: "string",
        description: "local only: catalog model id (sd15, sdxl, flux-schnell). Default: smallest your device supports.",
      },
    },
    required: ["name"],
  };

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: sprite generation is disabled in read-only mode", isError: true };
    }

    const provider = String(input["provider"] ?? "procedural");
    if (provider !== "procedural" && provider !== "local") {
      return { content: "Error: provider must be 'procedural' (built-in shapes) or 'local' (open-weights diffusion on this machine)", isError: true };
    }

    const rawName = String(input["name"] ?? "").trim();
    if (!/^[A-Za-z][\w-]{0,40}$/.test(rawName)) {
      return {
        content: "Error: name must start with a letter and contain only letters, digits, _ or - (e.g. 'FrozenPig')",
        isError: true,
      };
    }

    const dirRel = String(input["path"] ?? "Assets/Art/Generated");
    if (!/^Assets([/\\]|$)/i.test(dirRel.replace(/\\/g, "/")) && dirRel !== "Assets") {
      return { content: "Error: path must be under Assets/", isError: true };
    }

    if (provider === "local") {
      return this.executeLocal(input, context, rawName, dirRel);
    }
    return this.executeProcedural(input, context, rawName, dirRel);
  }

  /** The open-weights path: a local diffusion model draws the sprite. */
  private async executeLocal(
    input: Record<string, unknown>,
    context: ToolContext,
    rawName: string,
    dirRel: string,
  ): Promise<ToolExecutionResult> {
    const { LocalModelRunner } = await import("../../../assets-local/local-model-runner.js");
    const { defaultModelFor, supportedModels } = await import("../../../assets-local/model-catalog.js");

    const modelId = input["model"] !== undefined ? String(input["model"]) : undefined;
    // Explicit ids go through the DEVICE-GATED list too: getModelSpec would
    // hand back a 24GB-bar model on an 8GB machine and swap-thrash the run.
    const spec = modelId
      ? supportedModels().find((m) => m.id === modelId && m.kind === "text-to-image")
      : defaultModelFor("text-to-image");
    if (!spec) {
      return {
        content:
          "Error: no local text-to-image model available for this device. Run `strada assets-local-setup` " +
          "to see what your machine supports, or use provider 'procedural'.",
        isError: true,
      };
    }

    const runner = new LocalModelRunner();
    if (!runner.isModelInstalled(spec.id)) {
      return {
        content:
          `Error: ${spec.label} is not installed. Run \`strada assets-local-setup --model ${spec.id}\` first ` +
          "(or pick provider 'procedural').",
        isError: true,
      };
    }

    const relFile = `${dirRel.replace(/[/\\]+$/, "")}/${rawName}.png`;
    const pathCheck = await validatePath(context.projectPath, relFile, { allowMissingParents: true });
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error ?? "path validation failed"}`, isError: true };
    }

    const prompt =
      input["prompt"] !== undefined
        ? String(input["prompt"])
        : await (async () => {
            // The project's style.json (GDD-derived, never universal) steers
            // the default prompt; without it, the toon-casual stock default.
            let family = "toon-casual";
            let notes = "";
            try {
              const { loadStyleProfile } = await import("../../style/style-profile.js");
              const profile = loadStyleProfile(context.projectPath);
              if (profile) {
                family = profile.family;
                notes = profile.notes;
              }
            } catch {
              /* stock defaults */
            }
            const subject = rawName.replace(/([A-Z])/g, " $1").toLowerCase();
            switch (family) {
              case "realistic":
                return `realistic game render of ${subject}, detailed natural materials, studio lighting, single full-body centered, isolated on plain background`;
              case "pixel":
                return `16-bit pixel-art game sprite of ${subject}, limited palette, crisp pixels, single character centered, plain background`;
              case "lowpoly":
                return `low-poly 3d render of ${subject}, flat shaded, clean geometry, single object centered, plain background`;
              case "painterly":
                return `hand-painted game art of ${subject}, soft brush strokes, storybook style, single character centered, plain background`;
              default:
                return `flat vector game sprite of ${subject}, mobile casual game character, thick clean outline, solid colors, soft glossy shading, single full-body character centered, isolated on plain white background, studio quality${notes ? `; ${notes}` : ""}`;
            }
          })();
    const negative =
      input["negative"] !== undefined
        ? String(input["negative"])
        : "photo, realistic, blurry, watermark, signature, text, logo, dark background, " +
          "pattern background, scenery, multiple characters, cropped, deformed, extra limbs";

    try {
      mkdirSync(dirname(pathCheck.fullPath), { recursive: true });
      // Meta BEFORE art: if the pair is ever torn, a meta without art is
      // cleaned up (here, and by Unity); art without meta gets a random guid
      // and imports as a plain Texture — the binding-churn failure class.
      const guid = reuseOrMintGuid(`${pathCheck.fullPath}.meta`);
      writeFileSync(`${pathCheck.fullPath}.meta`, spriteMeta(guid), "utf8");
      const result = await runner.textToImage(spec, prompt, pathCheck.fullPath, {
        negative,
        size: 512,
        // Sprites are game assets: cut the subject out instead of trusting
        // the model to honor "white background" (measured: it doesn't).
        removeBackground: input["keepBackground"] !== true,
      });
      if (!result.ok) {
        try { rmSync(`${pathCheck.fullPath}.meta`, { force: true }); } catch { /* orphan meta cleanup */ }
        return { content: `Error: local diffusion failed: ${result.detail}`, isError: true };
      }
      return {
        content:
          `Sprite written by local diffusion (${spec.label}): ${relFile} (+ .meta). ` +
          "Unity imports it as a Sprite on next refresh. Bind it to the element's prefab now — an " +
          "unreferenced sprite draws nothing.",
      };
    } catch (err) {
      return {
        content: `Error: local sprite generation failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  private async executeProcedural(
    input: Record<string, unknown>,
    context: ToolContext,
    rawName: string,
    dirRel: string,
  ): Promise<ToolExecutionResult> {

    const sizeRaw = Number(input["size"] ?? 64);
    const size = Number.isFinite(sizeRaw) ? Math.min(256, Math.max(16, Math.round(sizeRaw))) : 64;

    // The game's OWN style profile (GDD-derived style.json), when present,
    // supplies the palette and outline. Explicit inputs always win; without a
    // profile the deterministic name-hash colour remains the floor. This is
    // what "style.json flows through every generator" actually means for the
    // default (procedural) provider.
    let profile: import("../../style/style-profile.js").StyleProfile | undefined;
    try {
      const { loadStyleProfile } = await import("../../style/style-profile.js");
      profile = loadStyleProfile(context.projectPath);
    } catch {
      /* best-effort — stock behaviour without a profile */
    }
    const paletteColor = (() => {
      if (!profile || profile.palette.length === 0) return undefined;
      let h = 0;
      for (const ch of rawName) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return parseHexColor(profile.palette[h % profile.palette.length]!);
    })();

    const colorInput = input["color"] !== undefined ? String(input["color"]) : undefined;
    const base = colorInput ? parseHexColor(colorInput) : (paletteColor ?? colorFromName(rawName));
    if (!base) {
      return { content: `Error: color must be #rrggbb, got "${colorInput}"`, isError: true };
    }
    const accentInput = input["accent"] !== undefined ? String(input["accent"]) : undefined;
    const accent = (accentInput ? parseHexColor(accentInput) : undefined) ?? { r: 245, g: 245, b: 245 };
    if (accentInput && !parseHexColor(accentInput)) {
      return { content: `Error: accent must be #rrggbb, got "${accentInput}"`, isError: true };
    }

    const shapeInput = input["shape"] !== undefined ? String(input["shape"]) : undefined;
    const shape = shapeInput
      ? (SPRITE_SHAPES as readonly string[]).includes(shapeInput)
        ? (shapeInput as SpriteShape)
        : undefined
      : shapeFromName(rawName);
    if (!shape) {
      return { content: `Error: unknown shape "${shapeInput}" — one of ${SPRITE_SHAPES.join(", ")}`, isError: true };
    }

    const relFile = `${dirRel.replace(/[/\\]+$/, "")}/${rawName}.png`;
    const pathCheck = await validatePath(context.projectPath, relFile, { allowMissingParents: true });
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error ?? "path validation failed"}`, isError: true };
    }

    try {
      const grid = renderShape(shape, size, base, accent);
      finishGrid(grid, base, profile
        ? {
            outlineWidth: profile.outline.width,
            outlineColor: parseHexColor(profile.outline.color) ?? undefined,
            gloss: profile.shading === "glossy",
          }
        : undefined);
      const png = encodePng(size, size, gridToRgba(grid));
      // Reuse the existing guid on regeneration — a fresh guid orphans every
      // prefab/scene binding to the previous version of this sprite.
      const guid = reuseOrMintGuid(`${pathCheck.fullPath}.meta`);
      mkdirSync(dirname(pathCheck.fullPath), { recursive: true });
      writeFileSync(`${pathCheck.fullPath}.meta`, spriteMeta(guid), "utf8");
      writeFileSync(pathCheck.fullPath, png);
      return {
        content:
          `Sprite written: ${relFile} (+ .meta, guid ${guid.slice(0, 8)}…, shape ${shape}, ${size}px). ` +
          "Unity imports it as a Sprite on next refresh. Bind it to the element's prefab now — an " +
          "unreferenced sprite draws nothing.",
      };
    } catch (err) {
      return {
        content: `Error: sprite write failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
