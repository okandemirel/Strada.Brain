import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { UnityDeliveryMeasureTool } from "./delivery-measure.js";
import { createToolContext } from "../../../test-helpers.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function put(root: string, rel: string, body: string | Buffer, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

/** A flat 8×8 PNG: placeholder-grade by the assessor's own rule (no detail). */
function flatPng(): Buffer {
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
  const crc = (buf: Buffer): number => {
    let c = -1;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < 8; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 0x80)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("unity_delivery_measure", () => {
  it("reports the delivery gate's own inventory: counts, refusal, and the placeholder paths", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "delivery-measure-")); roots.push(root);
    mkdirSync(join(root, "Assets"), { recursive: true });
    put(root, "Assets/Art/Generated/Slime.png", flatPng(), "a".repeat(32));
    put(root, "ProjectSettings/EditorBuildSettings.asset", "EditorBuildSettings:\n  m_Scenes: []\n");
    const tool = new UnityDeliveryMeasureTool();
    const result = await tool.execute({}, createToolContext({ projectPath: root, workingDirectory: root }));
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content) as { artInventory: { sprites: number; placeholderSprites: number }; placeholderSprites: { count: number; listed: string[] }; refusal: unknown };
    expect(payload.artInventory.sprites).toBe(1);
    expect(payload.placeholderSprites.count).toBe(payload.artInventory.placeholderSprites);
    expect(payload.placeholderSprites.listed.some((p) => p.includes("Slime.png"))).toBe(payload.placeholderSprites.count > 0);
  });

  it("refuses to hand back numbers for a directory it could not measure", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "delivery-measure-")); roots.push(root);
    const tool = new UnityDeliveryMeasureTool();
    const result = await tool.execute({}, createToolContext({ projectPath: root, workingDirectory: root }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nothing here is a count");
  });
});
