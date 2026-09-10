/**
 * unity_generate_audio — procedural SFX and music loops written straight into
 * Assets/ as WAV + AudioImporter .meta, no Editor needed.
 *
 * Measured 2026-09-07 on the PixelFlow project: the GDD schedules a music
 * base loop, area variations and a complete SFX cue list; the toolchain had
 * no audio tool at all, and the project held nineteen WAVs — thirteen
 * 0.15-second blips, four byte-identical to another clip. This is the audio
 * counterpart of the procedural sprite: deterministic (seeded), honest about
 * what it is (synthesis, not composition), and enough for a cue list to be
 * bound and heard.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { reuseOrMintGuid } from "./meta-file-utils.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { validatePath } from "../../../security/path-guard.js";
import { outsideAssetsError } from "./generated-asset-guard.js";

export const SAMPLE_RATE = 44_100;

export const SFX_PRESETS = [
  "click", "select", "pop", "coin", "hit", "thump", "whoosh", "jump", "win", "fail", "warn", "explosion",
] as const;
export type SfxPreset = (typeof SFX_PRESETS)[number];

const NOTE_INDEX: Record<string, number> = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** Deterministic PRNG — the same seed writes the same bytes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Attack/decay/sustain/release envelope value at time t (seconds). */
function adsr(t: number, total: number, a: number, d: number, s: number, r: number): number {
  if (t < 0 || t > total) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t > total - r) return s * Math.max(0, (total - t) / r);
  return s;
}

type Osc = "sine" | "square" | "triangle" | "saw" | "noise";

function osc(kind: Osc, phase: number, rnd: () => number): number {
  const p = phase - Math.floor(phase);
  switch (kind) {
    case "sine": return Math.sin(2 * Math.PI * p);
    case "square": return p < 0.5 ? 1 : -1;
    case "triangle": return 1 - 4 * Math.abs(p - 0.5);
    case "saw": return 2 * p - 1;
    case "noise": return rnd() * 2 - 1;
  }
}

interface Voice {
  readonly osc: Osc;
  readonly startHz: number;
  readonly endHz: number;
  readonly seconds: number;
  readonly a: number;
  readonly d: number;
  readonly s: number;
  readonly r: number;
  readonly gain: number;
  readonly startAt?: number;
}

/** Render voices additively into a float buffer of `seconds`. */
function render(voices: readonly Voice[], seconds: number, rnd: () => number): Float32Array {
  const n = Math.max(1, Math.round(seconds * SAMPLE_RATE));
  const out = new Float32Array(n);
  for (const v of voices) {
    const start = Math.round((v.startAt ?? 0) * SAMPLE_RATE);
    const len = Math.round(v.seconds * SAMPLE_RATE);
    let phase = 0;
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SAMPLE_RATE;
      const k = i / Math.max(1, len);
      const hz = v.startHz * Math.pow(v.endHz / v.startHz, k);
      phase += hz / SAMPLE_RATE;
      out[start + i]! += osc(v.osc, phase, rnd) * adsr(t, v.seconds, v.a, v.d, v.s, v.r) * v.gain;
    }
  }
  return out;
}

/** One-pole low-pass, in place — softens square/saw/noise into something a phone speaker likes. */
function lowpass(buf: Float32Array, cutoffHz: number): void {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += alpha * (buf[i]! - y);
    buf[i] = y;
  }
}

function normalize(buf: Float32Array, peak = 0.85): void {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) return;
  const g = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * g;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A short cue: pitch sweeps and envelopes chosen per preset, with a seeded touch of variation. */
export function synthesizeSfx(preset: SfxPreset, seed: number): { samples: Float32Array; seconds: number } {
  const rnd = mulberry32(seed);
  const jitter = (base: number, pct: number): number => base * (1 + (rnd() * 2 - 1) * pct);
  let voices: Voice[];
  let seconds: number;
  let cutoff = 8000;
  switch (preset) {
    case "click":
      seconds = 0.06;
      voices = [{ osc: "square", startHz: jitter(1800, 0.1), endHz: 900, seconds, a: 0.001, d: 0.03, s: 0.2, r: 0.02, gain: 0.8 }];
      break;
    case "select":
      seconds = 0.12;
      voices = [{ osc: "triangle", startHz: jitter(880, 0.05), endHz: 1320, seconds, a: 0.005, d: 0.05, s: 0.4, r: 0.05, gain: 0.8 }];
      break;
    case "pop":
      seconds = 0.15;
      voices = [{ osc: "sine", startHz: jitter(600, 0.1), endHz: 150, seconds, a: 0.002, d: 0.08, s: 0.1, r: 0.05, gain: 1 }];
      break;
    case "coin":
      seconds = 0.35;
      voices = [
        { osc: "square", startHz: 988, endHz: 988, seconds: 0.09, a: 0.002, d: 0.05, s: 0.6, r: 0.03, gain: 0.5 },
        { osc: "square", startHz: 1319, endHz: 1319, seconds: 0.26, a: 0.002, d: 0.1, s: 0.5, r: 0.12, gain: 0.5, startAt: 0.09 },
      ];
      cutoff = 6000;
      break;
    case "hit":
      seconds = 0.2;
      voices = [
        { osc: "noise", startHz: 1, endHz: 1, seconds: 0.12, a: 0.001, d: 0.08, s: 0.1, r: 0.03, gain: 0.7 },
        { osc: "sine", startHz: jitter(220, 0.1), endHz: 60, seconds, a: 0.001, d: 0.12, s: 0.1, r: 0.06, gain: 0.9 },
      ];
      cutoff = 3000;
      break;
    case "thump":
      seconds = 0.3;
      voices = [{ osc: "sine", startHz: jitter(120, 0.1), endHz: 40, seconds, a: 0.002, d: 0.2, s: 0.1, r: 0.08, gain: 1 }];
      cutoff = 1500;
      break;
    case "whoosh":
      seconds = 0.45;
      voices = [{ osc: "noise", startHz: 1, endHz: 1, seconds, a: 0.12, d: 0.1, s: 0.6, r: 0.2, gain: 0.8 }];
      cutoff = 2500;
      break;
    case "jump":
      seconds = 0.25;
      voices = [{ osc: "square", startHz: jitter(300, 0.1), endHz: 900, seconds, a: 0.005, d: 0.1, s: 0.5, r: 0.1, gain: 0.7 }];
      cutoff = 5000;
      break;
    case "win": {
      seconds = 0.9;
      const notes = [523, 659, 784, 1047];
      voices = notes.map((hz, i) => ({ osc: "square" as const, startHz: hz, endHz: hz, seconds: i === 3 ? 0.45 : 0.16, a: 0.005, d: 0.06, s: 0.6, r: 0.08, gain: 0.45, startAt: i * 0.15 }));
      cutoff = 6000;
      break;
    }
    case "fail": {
      seconds = 0.7;
      const notes = [392, 349, 311];
      voices = notes.map((hz, i) => ({ osc: "saw" as const, startHz: hz, endHz: hz * 0.97, seconds: i === 2 ? 0.35 : 0.2, a: 0.01, d: 0.08, s: 0.6, r: 0.1, gain: 0.5, startAt: i * 0.18 }));
      cutoff = 2500;
      break;
    }
    case "warn":
      seconds = 0.5;
      voices = [
        { osc: "triangle", startHz: 660, endHz: 660, seconds: 0.18, a: 0.005, d: 0.05, s: 0.7, r: 0.05, gain: 0.7 },
        { osc: "triangle", startHz: 660, endHz: 660, seconds: 0.18, a: 0.005, d: 0.05, s: 0.7, r: 0.05, gain: 0.7, startAt: 0.28 },
      ];
      break;
    case "explosion":
      seconds = 0.8;
      voices = [
        { osc: "noise", startHz: 1, endHz: 1, seconds, a: 0.005, d: 0.3, s: 0.3, r: 0.4, gain: 0.9 },
        { osc: "sine", startHz: 90, endHz: 30, seconds: 0.5, a: 0.002, d: 0.3, s: 0.2, r: 0.15, gain: 0.8 },
      ];
      cutoff = 1200;
      break;
  }
  const samples = render(voices, seconds, rnd);
  lowpass(samples, cutoff);
  normalize(samples);
  return { samples, seconds };
}

export interface MusicSpec {
  readonly bpm: number;
  readonly key: string;
  readonly mode: "major" | "minor";
  readonly seconds: number;
  readonly seed: number;
}

/**
 * A seamless chiptune loop: a seeded four-chord progression in the key,
 * bass on the root, an arpeggio over the chord, a kick on every beat and a
 * hat on the off-beats. Bars are whole so the loop point falls on a downbeat.
 */
export function synthesizeMusic(spec: MusicSpec): { samples: Float32Array; seconds: number; progression: number[] } {
  const rnd = mulberry32(spec.seed);
  const scale = spec.mode === "minor" ? MINOR : MAJOR;
  const root = 48 + (NOTE_INDEX[spec.key.toUpperCase()] ?? 0); // C3-based
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const bars = Math.max(2, Math.round(spec.seconds / bar));
  const seconds = bars * bar;
  const progressions = [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 4], [0, 4, 3, 4]];
  const progression = progressions[Math.floor(rnd() * progressions.length)]!;
  const voices: Voice[] = [];
  for (let b = 0; b < bars; b++) {
    const degree = progression[b % progression.length]!;
    const chord = [0, 2, 4].map((step) => root + scale[(degree + step) % 7]! + 12 * Math.floor((degree + step) / 7));
    const at = b * bar;
    // bass: root on beats 1 and 3
    for (const off of [0, 2]) {
      voices.push({ osc: "triangle", startHz: midiToHz(chord[0]! - 12), endHz: midiToHz(chord[0]! - 12), seconds: beat * 0.9, a: 0.01, d: 0.1, s: 0.7, r: 0.1, gain: 0.5, startAt: at + off * beat });
    }
    // arpeggio: eighth notes over the chord, an octave up, seeded order
    const order = rnd() < 0.5 ? [0, 1, 2, 1] : [0, 2, 1, 2];
    for (let e = 0; e < 8; e++) {
      const note = chord[order[e % 4]!]! + 12;
      voices.push({ osc: "square", startHz: midiToHz(note), endHz: midiToHz(note), seconds: beat * 0.45, a: 0.005, d: 0.08, s: 0.4, r: 0.05, gain: 0.22, startAt: at + e * beat * 0.5 });
    }
    // drums
    for (let k = 0; k < 4; k++) {
      voices.push({ osc: "sine", startHz: 150, endHz: 45, seconds: 0.18, a: 0.001, d: 0.12, s: 0.1, r: 0.05, gain: 0.7, startAt: at + k * beat });
      voices.push({ osc: "noise", startHz: 1, endHz: 1, seconds: 0.05, a: 0.001, d: 0.03, s: 0.2, r: 0.02, gain: 0.18, startAt: at + k * beat + beat / 2 });
    }
  }
  const samples = render(voices, seconds, rnd);
  lowpass(samples, 6500);
  normalize(samples, 0.8);
  return { samples, seconds, progression };
}

/** Unity AudioImporter sidecar; `loop` is a runtime AudioSource setting, so the importer needs nothing for it. */
export function audioMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
AudioImporter:
  externalObjects: {}
  serializedVersion: 8
  defaultSettings:
    serializedVersion: 2
    loadType: 0
    sampleRateSetting: 0
    sampleRateOverride: 44100
    compressionFormat: 1
    quality: 1
    conversionMode: 0
    preloadAudioData: 0
  platformSettingOverrides: {}
  forceToMono: 0
  normalize: 1
  loadInBackground: 0
  ambisonic: 0
  3D: 0
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`;
}

export class AudioGenerateTool implements ITool {
  readonly name = "unity_generate_audio";
  readonly description =
    "Generate an audio clip for a game cue and write it into the project as a WAV + AudioImporter .meta " +
    "(no Editor needed). kind 'sfx': one of the presets, a short synthesized cue that a casual/retro game " +
    "can ship. kind 'music': a seamless seeded chiptune loop in a key and tempo — a procedural stand-in for " +
    "composed music, and it says so. Deterministic per seed. Use when the GDD names a cue or a loop and " +
    "unity_my_assets_cloud has nothing the user already owns; bind the clip to an AudioSource afterwards.";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: { type: "string", description: "Clip name, e.g. 'ui_click' or 'music_main' (letters, digits, _ or -)." },
      kind: { type: "string", enum: ["sfx", "music"], description: "'sfx' (default) or 'music'." },
      preset: { type: "string", enum: [...SFX_PRESETS], description: `sfx only: ${SFX_PRESETS.join(", ")} (default 'pop').` },
      bpm: { type: "number", description: "music only: tempo, 60-200 (default 110)." },
      key: { type: "string", description: "music only: C, C#, D … B (default C)." },
      mode: { type: "string", enum: ["major", "minor"], description: "music only (default major)." },
      seconds: { type: "number", description: "music only: target loop length, rounded to whole bars (default 30, max 120)." },
      seed: { type: "number", description: "Variation; the same seed writes the same bytes (default: from the name)." },
      path: { type: "string", description: "Directory under Assets/ (default Assets/Audio/Generated)." },
    },
    required: ["name"],
  };

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.readOnly) return { content: "Error: audio generation is disabled in read-only mode", isError: true };
    const rawName = String(input["name"] ?? "").trim();
    if (!/^[A-Za-z][\w-]{0,60}$/.test(rawName)) {
      return { content: "Error: name must start with a letter and contain only letters, digits, _ or - (e.g. 'ui_click')", isError: true };
    }
    const kind = String(input["kind"] ?? "sfx");
    if (kind !== "sfx" && kind !== "music") return { content: "Error: kind must be 'sfx' or 'music'", isError: true };
    const dirRel = String(input["path"] ?? "Assets/Audio/Generated").replace(/\\/g, "/");
    if (!/^Assets(\/|$)/i.test(dirRel)) return { content: "Error: path must be under Assets/", isError: true };
    const relFile = `${dirRel.replace(/\/+$/, "")}/${rawName}.wav`;
    const pathCheck = await validatePath(context.projectPath, relFile, { allowMissingParents: true });
    if (!pathCheck.valid) return { content: `Error: ${pathCheck.error ?? "path validation failed"}`, isError: true };
    const outside = outsideAssetsError(context.projectPath, pathCheck.fullPath, dirRel);
    if (outside) return { content: outside, isError: true };
    const seed = typeof input["seed"] === "number" && Number.isFinite(input["seed"]) ? Math.floor(input["seed"]) : hashName(rawName);

    let samples: Float32Array;
    let seconds: number;
    let what: string;
    if (kind === "sfx") {
      const preset = String(input["preset"] ?? "pop") as SfxPreset;
      if (!SFX_PRESETS.includes(preset)) {
        return { content: `Error: preset must be one of ${SFX_PRESETS.join(", ")} (got "${preset}")`, isError: true };
      }
      ({ samples, seconds } = synthesizeSfx(preset, seed));
      what = `sfx preset '${preset}'`;
    } else {
      const bpm = clamp(Number(input["bpm"] ?? 110), 60, 200);
      const key = String(input["key"] ?? "C").toUpperCase();
      if (!(key in NOTE_INDEX)) return { content: `Error: key must be one of ${Object.keys(NOTE_INDEX).join(", ")}`, isError: true };
      const mode = input["mode"] === "minor" ? "minor" : "major";
      const target = clamp(Number(input["seconds"] ?? 30), 4, 120);
      const music = synthesizeMusic({ bpm, key, mode, seconds: target, seed });
      samples = music.samples;
      seconds = music.seconds;
      what = `music loop ${key} ${mode} ${bpm} bpm, chords ${music.progression.map((d) => d + 1).join("-")}`;
    }

    try {
      const guid = reuseOrMintGuid(`${pathCheck.fullPath}.meta`);
      mkdirSync(dirname(pathCheck.fullPath), { recursive: true });
      writeFileSync(`${pathCheck.fullPath}.meta`, audioMeta(guid), "utf8");
      writeFileSync(pathCheck.fullPath, encodeWav(samples));
      return {
        content:
          `Audio written: ${relFile} (+ .meta, guid ${guid.slice(0, 8)}…, ${what}, ${seconds.toFixed(2)}s, seed ${seed}). ` +
          (kind === "music"
            ? "PROCEDURAL: a synthesized chiptune loop, not composed music — it fills the slot and loops cleanly; the delivery report will call it procedural. "
            : "Synthesized cue. ") +
          "Bind it to an AudioSource (loop=true for music) — an unreferenced clip is never heard.",
      };
    } catch (err) {
      return { content: `Error: audio write failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function hashName(name: string): number {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
