import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { deflateSync } from "node:zlib";
import { assessBuiltAsSpecified, assessBuiltAsSpecifiedAsync } from "./built-as-specified.js";

/**
 * CHN-8 / AUT-15: the delivery measurement walked Assets/ and read every
 * sidecar, script, PNG and clip synchronously — the daemon served nothing else
 * until it finished. The async entry point awaits that disk work and must give
 * exactly the report the synchronous one gives.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string | Buffer, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

function png(width: number, height: number, kind: "flat" | "noise"): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let c = 0xffffffff;
    for (const b of body) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (width * 4 + 1) + 1 + x] = kind === "flat" ? 0x80 : seed & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function wav(seconds: number, fill: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2, fill);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const g = (n: number): string => n.toString(16).padStart(32, "0");
const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";

/** A project with a shipped scene, bound and unbound art, clips and scripts. */
function gameProject(): string {
  const root = mkdtempSync(join(os.tmpdir(), "built-as-specified-async-"));
  roots.push(root);
  put(
    root,
    "ProjectSettings/EditorBuildSettings.asset",
    `EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: ${g(1)}\n`,
  );
  put(
    root,
    "Assets/Scenes/Main.unity",
    `${HEADER}--- !u!1 &1\nGameObject:\n  m_Name: Root\n` +
      `--- !u!1001 &1001\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ${g(10)}, type: 3}\n` +
      "--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: 1\n",
    g(2),
  );
  put(
    root,
    "Assets/Prefabs/Pig.prefab",
    `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Pig\n` +
      `--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Sprite: {fileID: 21300000, guid: ${g(20)}, type: 3}\n`,
    g(10),
  );
  put(root, "Assets/Prefabs/Unused.prefab", `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Unused\n`, g(11));
  put(root, "Assets/Art/Pig.png", png(16, 16, "noise"), g(20));
  put(root, "Assets/Art/Placeholder.png", png(32, 32, "flat"), g(21));
  put(root, "Assets/Art/Broken.png", Buffer.from("not a png"), g(22));
  put(root, "Assets/Audio/a.wav", wav(0.2, 1), g(30));
  put(root, "Assets/Audio/b.wav", wav(0.2, 1), g(31));
  put(root, "Assets/Scripts/Spawner.cs", "class S { void A() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }", g(40));
  put(root, "Assets/Tests/Probe.cs", "class T { void A() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }", g(41));
  for (let d = 0; d < 20; d++) {
    for (let f = 0; f < 15; f++) put(root, `Assets/Pack/D${d}/tex${f}.mat`, "Material: {}\n", g(1000 + d * 100 + f));
  }
  return root;
}

describe("assessBuiltAsSpecifiedAsync", () => {
  it("gives the report the synchronous measurement gives", async () => {
    const root = gameProject();
    const sync = assessBuiltAsSpecified(root);
    // The fixture exercises every read the async path does ahead of time.
    expect(sync.measured).toBe(true);
    expect(sync.artInventory).toMatchObject({ audio: 2, duplicateAudio: 1, sprites: 3, placeholderSprites: 1 });
    expect(sync.primitiveScripts).toEqual(["Assets/Scripts/Spawner.cs"]);
    expect(sync.unboundPrefabs).toEqual(["Assets/Prefabs/Unused.prefab"]);
    expect(await assessBuiltAsSpecifiedAsync(root)).toEqual(sync);
  });

  it("gives the same truncation disclosures under a small walk budget", async () => {
    const root = gameProject();
    const sync = assessBuiltAsSpecified(root, undefined, { walkBudget: 25 });
    expect(sync.incomplete.some((line) => line.includes("maximum of 25 files"))).toBe(true);
    expect(await assessBuiltAsSpecifiedAsync(root, { walkBudget: 25 })).toEqual(sync);
  });

  it("reports a missing Assets/ folder like the synchronous call", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "built-as-specified-async-"));
    roots.push(root);
    expect(await assessBuiltAsSpecifiedAsync(root)).toEqual(assessBuiltAsSpecified(root));
  });

  it("serves the event loop while it walks and reads", async () => {
    const root = gameProject();
    let ticks = 0;
    let running = true;
    const beat = (): void => {
      if (!running) return;
      ticks++;
      setImmediate(beat);
    };
    setImmediate(beat);
    await assessBuiltAsSpecifiedAsync(root);
    running = false;
    // Every awaited readdir/readFile hands the loop back; a synchronous walk
    // of the same tree lets nothing else run until it is done.
    expect(ticks).toBeGreaterThan(20);
  });
});
