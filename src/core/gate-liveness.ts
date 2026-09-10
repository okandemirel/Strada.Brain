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
import { assessSpecScope, findDesignDoc } from "../agents/autonomy/spec-scope.js";
import { realLocalAvailability } from "../agents/tools/unity/sprite-generate.js";
import { LOCAL_MODEL_CATALOG, defaultModelFor } from "../assets-local/model-catalog.js";
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

/** A 16-bit mono PCM WAV of the given length; two calls with the same seed are byte-identical. */
function wav(seconds: number, seed: number): Buffer {
  const rate = 8000;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  let s = seed;
  for (let i = 0; i < frames; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data.writeInt16LE(((s >>> 8) & 0xffff) - 0x8000, i * 2);
  }
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

const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
const PREFAB = `${HEADER}--- !u!1 &100\nGameObject:\n  m_Component:\n  - component: {fileID: 400}\n  m_Name: Hero\n--- !u!4 &400\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n`;
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
    put(root, "Assets/Prefabs/Hero.prefab", PREFAB, "11111111111111111111111111111111");
    put(root, "Assets/Art/flat.png", png(64, 64, "flat"), "22222222222222222222222222222222");
    put(root, "Assets/Art/real.png", png(64, 64, "noise"), "33333333333333333333333333333333");
    put(root, "Assets/Scripts/Builder.cs", "public class Builder { void B() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }", "44444444444444444444444444444444");
    // The schedule shape the parser recognises (a table with an L<n> tag per
    // row). Codex review 2026-09-07: the earlier prose fixture scheduled
    // nothing, so the probe proved document discovery and not the gate.
    put(root, "docs/Game_GDD.md", "# GDD\n\n| Level | Element |\n|---|---|\n| L1 | Hero |\n| L2 | Bridge |\n");
    put(root, "Assets/Audio/long.wav", wav(2, 1), "55555555555555555555555555555555");
    put(root, "Assets/Audio/blip.wav", wav(0.15, 2), "66666666666666666666666666666666");
    put(root, "Assets/Audio/blip-copy.wav", wav(0.15, 2), "77777777777777777777777777777777");

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
      const long = measureAudioClip(join(root, "Assets/Audio/long.wav"));
      const blip = measureAudioClip(join(root, "Assets/Audio/blip.wav"));
      const copy = measureAudioClip(join(root, "Assets/Audio/blip-copy.wav"));
      must(long.seconds !== undefined && Math.abs(long.seconds - 2) < 0.01, `a 2 s WAV measured ${long.seconds ?? "no"} seconds`);
      must(blip.seconds !== undefined && Math.abs(blip.seconds - 0.15) < 0.01, `a 0.15 s WAV measured ${blip.seconds ?? "no"} seconds`);
      must(blip.hash !== undefined && blip.hash === copy.hash, "byte-identical clips did not hash the same");
      must(long.hash !== blip.hash, "different clips hashed the same");
      const r = assessBuiltAsSpecified(root);
      must(r.artInventory.audio === 3, `audio count ${r.artInventory.audio}, expected 3`);
      must(r.artInventory.duplicateAudio === 1, `duplicate count ${r.artInventory.duplicateAudio}, expected 1`);
      must(r.artInventory.shortAudio === 2, `short-clip count ${r.artInventory.shortAudio}, expected 2`);
      return "3 clips: durations measured, 1 duplicate, 2 blips";
    }));

    probes.push(probe("GDD scheduled elements (spec-scope)", () => {
      const doc = findDesignDoc(root);
      must(doc === join(root, "docs", "Game_GDD.md"), `findDesignDoc returned ${doc}`);
      const scope = assessSpecScope(root);
      must(scope.scheduled === 2, `parsed ${scope.scheduled} scheduled elements, expected 2`);
      const missing = scope.missing.map((m) => m.name);
      must(missing.includes("Bridge"), `an unimplemented element was not reported missing (missing: ${missing.join(", ") || "none"})`);
      return `finds the GDD, schedules 2, reports ${missing.length} unimplemented`;
    }));

    probes.push(probe("local model availability", () => {
      // The catalog is device-gated: on a machine it supports nothing for
      // (CI's Linux runner), the default is undefined and availability is
      // legitimately false — then only the runner's marker path can be
      // proven, and the detail says so instead of reading like the full probe.
      const spec = defaultModelFor("text-to-image");
      const anySpec = spec ?? LOCAL_MODEL_CATALOG.find((s) => s.kind === "text-to-image");
      must(anySpec !== undefined, "no text-to-image model in the catalog at all");
      // Exercise the production path against a controlled root: with a venv
      // and the model's marker it must say true, without them false. The old
      // probe accepted false === false, which an always-false implementation
      // also satisfies (Codex review 2026-09-07).
      const fake = join(root, "assets-local");
      const previous = process.env["STRADA_ASSETS_LOCAL_ROOT"];
      process.env["STRADA_ASSETS_LOCAL_ROOT"] = fake;
      try {
        must(!realLocalAvailability()("text-to-image"), "availability said true for an empty model root");
        must(!new LocalModelRunner().isModelInstalled(anySpec!.id), "the runner saw a marker in an empty root");
        put(fake, "venv/bin/python3", "");
        put(fake, `.installed-${anySpec!.id}`, "probe\n");
        must(new LocalModelRunner().isModelInstalled(anySpec!.id), "the runner did not see the installed marker");
        if (spec !== undefined) {
          must(realLocalAvailability()("text-to-image"), `availability said false with venv and .installed-${spec.id} present`);
        }
      } finally {
        if (previous === undefined) delete process.env["STRADA_ASSETS_LOCAL_ROOT"];
        else process.env["STRADA_ASSETS_LOCAL_ROOT"] = previous;
      }
      if (spec === undefined) {
        return `catalog offers no text-to-image model on this device (availability is false by design); runner marker path proven with ${anySpec!.id}`;
      }
      const installed = new LocalModelRunner().isModelInstalled(spec.id);
      return `turns true with a marker, false without; this machine: ${installed ? "installed" : "not installed"} (${spec.id})`;
    }));

    probes.push(probe("scene binding (bind + place)", () => {
      bindSprite(join(root, "Assets/Prefabs/Hero.prefab"), "33333333333333333333333333333333");
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
