/**
 * Gate liveness — at boot, prove that each measurement gate FIRES on a
 * fixture it must fire on, in this process, with this module system.
 *
 * Measured 2026-09-07: two gates had been dead for a whole campaign while
 * every test passed — the local-model availability check and the
 * GDD-scheduled-elements gate both called require() inside a try/catch in an
 * ESM package, threw ReferenceError, and answered "false"/"null". The test
 * runner shims require, so nothing red ever showed. A gate that cannot fire
 * on its own fixture is reported as DEAD in the boot report, not assumed.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  assessBuiltAsSpecified,
  isPlaceholderGradePng,
  measureAudioClip,
} from "../agents/autonomy/built-as-specified.js";
import { findDesignDoc } from "../agents/autonomy/spec-scope.js";
import { realLocalAvailability } from "../agents/tools/unity/sprite-generate.js";
import { defaultModelFor } from "../assets-local/model-catalog.js";
import { LocalModelRunner } from "../assets-local/local-model-runner.js";
import { bindSprite, placePrefab, prefabRoot } from "../agents/tools/unity/scene-binding.js";

export interface GateProbe {
  readonly gate: string;
  readonly ok: boolean;
  readonly detail: string;
}

function put(root: string, rel: string, body: string | Buffer, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

/** A valid RGBA PNG; flat compresses to a few hundred bytes, noise does not. */
function png(width: number, height: number, kind: "flat" | "noise"): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
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

const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
const PREFAB = `${HEADER}--- !u!1 &100\nGameObject:\n  m_Component:\n  - component: {fileID: 400}\n  m_Name: Pig\n--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n`;
const SCENE = `${HEADER}--- !u!1 &500\nGameObject:\n  m_Component:\n  - component: {fileID: 501}\n  m_Name: Main Camera\n--- !u!20 &502\nCamera:\n  m_GameObject: {fileID: 500}\n  orthographic: 0\n--- !u!4 &501\nTransform:\n  m_GameObject: {fileID: 500}\n  m_Father: {fileID: 0}\n--- !u!1660057539 &9223372036854775807\nSceneRoots:\n  m_ObjectHideFlags: 0\n  m_Roots:\n  - {fileID: 501}\n`;

function probe(gate: string, run: () => string): GateProbe {
  try {
    return { gate, ok: true, detail: run() };
  } catch (err) {
    return { gate, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Run every probe on throwaway fixtures. Fast (tens of ms), no Unity, no network. */
export function probeGateLiveness(): GateProbe[] {
  const root = mkdtempSync(join(tmpdir(), "strada-gate-liveness-"));
  try {
    put(root, "ProjectSettings/EditorBuildSettings.asset", "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: 00000000000000000000000000000001\n");
    put(root, "Assets/Scenes/Main.unity", SCENE, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    put(root, "Assets/Prefabs/Pig.prefab", PREFAB, "11111111111111111111111111111111");
    put(root, "Assets/Art/flat.png", png(64, 64, "flat"), "22222222222222222222222222222222");
    put(root, "Assets/Art/real.png", png(64, 64, "noise"), "33333333333333333333333333333333");
    put(root, "Assets/Scripts/Builder.cs", "public class Builder { void B() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }", "44444444444444444444444444444444");
    put(root, "docs/Game_GDD.md", "# GDD\n\nElement schedule: pig, ball\n");

    const probes: GateProbe[] = [];

    probes.push(probe("placeholder-sprite classifier", () => {
      must(isPlaceholderGradePng(join(root, "Assets/Art/flat.png")), "a flat 64×64 PNG was not classified placeholder-grade");
      must(!isPlaceholderGradePng(join(root, "Assets/Art/real.png")), "a noisy 64×64 PNG was classified placeholder-grade");
      return "flat → placeholder, noise → real";
    }));

    probes.push(probe("structural delivery refusal", () => {
      const r = assessBuiltAsSpecified(root);
      must(r.measured, "the scan did not run");
      must(r.refusal !== undefined && /render NOTHING/.test(r.refusal), `no refusal on a scene with 0 renderers and a CreatePrimitive script (got: ${r.refusal ?? "none"})`);
      must(r.artInventory.placeholderSprites === 1, `placeholder count ${r.artInventory.placeholderSprites}, expected 1`);
      return "refuses a renderer-less scene; counts 1 placeholder";
    }));

    probes.push(probe("audio inventory", () => {
      const clip = measureAudioClip(join(root, "Assets/Art/real.png"));
      must(clip.hash !== undefined, "no content hash for a readable file");
      return "hashes clips";
    }));

    probes.push(probe("GDD discovery (spec-scope)", () => {
      const doc = findDesignDoc(root);
      must(doc === join(root, "docs", "Game_GDD.md"), `findDesignDoc returned ${doc}`);
      return "finds docs/<Name>_GDD.md";
    }));

    probes.push(probe("local model availability", () => {
      const spec = defaultModelFor("text-to-image");
      const direct = spec !== undefined && new LocalModelRunner().isModelInstalled(spec.id);
      const probed = realLocalAvailability()("text-to-image");
      must(probed === direct, `availability says ${probed}, the runner says ${direct}`);
      return direct ? `installed (${spec!.id})` : "no local model installed — consistent";
    }));

    probes.push(probe("scene binding (bind + place)", () => {
      bindSprite(join(root, "Assets/Prefabs/Pig.prefab"), "33333333333333333333333333333333");
      placePrefab(join(root, "Assets/Scenes/Main.unity"), "11111111111111111111111111111111", prefabRoot(PREFAB));
      const r = assessBuiltAsSpecified(root);
      must(r.shippedRenderers === 1, `placed prefab renderer not counted (shippedRenderers=${r.shippedRenderers})`);
      return "a bound, placed prefab is counted as shipped";
    }));

    return probes;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One line for the boot report, plus a notice per dead gate. */
export function summarizeGateLiveness(probes: readonly GateProbe[]): { summary: string; dead: string[] } {
  const dead = probes.filter((p) => !p.ok).map((p) => `GATE DEAD: ${p.gate} — ${p.detail}`);
  return { summary: `Gate liveness: ${probes.length - dead.length}/${probes.length} gates fire on their fixtures`, dead };
}
