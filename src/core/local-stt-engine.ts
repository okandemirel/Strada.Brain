/**
 * Local Speech-to-Text Engine
 *
 * Provider-free voice transcription using @huggingface/transformers (Whisper ONNX).
 * Audio format conversion uses FFmpeg (system dependency) when available.
 * Falls back gracefully when dependencies are missing — callers should
 * chain this with cloud STT as a fallback.
 *
 * Environment variables:
 *   STT_MODE       "auto" | "local" | "cloud" | "disabled"  (default: "auto")
 *   STT_MODEL      HuggingFace model ID                     (default: "onnx-community/whisper-tiny.en")
 *   STT_CACHE_DIR  Model download cache directory            (default: ~/.strada/models)
 */

import { getLogger } from "../utils/logger.js";
import { rm, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Pipeline = (audio: Float32Array) => Promise<{ text: string }>;

interface WaveFileInstance {
  toBitDepth(depth: string): void;
  toSampleRate(rate: number): void;
  getSamples(): Float32Array | Float32Array[];
}

/* -------------------------------------------------------------------------- */
/*  Lazy-loaded state (Promise-guarded for concurrency safety)                */
/* -------------------------------------------------------------------------- */

let pipelineFactory: ((task: string, model: string) => Promise<Pipeline>) | null = null;
let WaveFileCtor: (new (buf: Buffer) => WaveFileInstance) | null = null;

let depsPromise: Promise<boolean> | null = null;
let ffmpegPromise: Promise<string | null> | null = null;
let pipelinePromise: Promise<Pipeline> | null = null;

/* -------------------------------------------------------------------------- */
/*  Configuration helpers                                                     */
/* -------------------------------------------------------------------------- */

export function sttMode(): string {
  return (process.env["STT_MODE"] ?? "auto").toLowerCase().trim();
}

function sttModel(): string {
  return process.env["STT_MODEL"]?.trim() || "onnx-community/whisper-tiny.en";
}

function sttCacheDir(): string {
  const raw = process.env["STT_CACHE_DIR"]?.trim();
  if (raw) return resolve(raw); // resolve() normalizes any traversal segments
  return join(homedir(), ".strada", "models");
}

/* -------------------------------------------------------------------------- */
/*  Dependency detection (concurrency-safe via stored Promises)               */
/* -------------------------------------------------------------------------- */

async function doDetectFfmpeg(): Promise<string | null> {
  try {
    const cmd = platform() === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(cmd, ["ffmpeg"], { timeout: 5_000 });
    return stdout.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

function detectFfmpeg(): Promise<string | null> {
  if (!ffmpegPromise) ffmpegPromise = doDetectFfmpeg();
  return ffmpegPromise;
}

async function doLoadDependencies(): Promise<boolean> {
  try {
    // Dynamic import — package is an optionalDependency
    // The string concatenation prevents bundlers from resolving at compile time
    const transformers: Record<string, unknown> = await import("@huggingface/transformers" + "");
    pipelineFactory = transformers["pipeline"] as typeof pipelineFactory;
    const env = transformers["env"] as Record<string, unknown> | undefined;
    if (env) env["cacheDir"] = sttCacheDir();
  } catch {
    getLogger().debug("@huggingface/transformers not installed — local STT disabled");
    return false;
  }

  try {
    const wavefile: Record<string, unknown> = await import("wavefile" + "");
    WaveFileCtor = (wavefile["WaveFile"]
      ?? (wavefile["default"] as Record<string, unknown>)?.["WaveFile"]
      ?? null) as typeof WaveFileCtor;
  } catch {
    getLogger().debug("wavefile not installed — WAV-only local conversion unavailable");
  }

  return true;
}

function loadDependencies(): Promise<boolean> {
  if (!depsPromise) depsPromise = doLoadDependencies();
  return depsPromise;
}

/* -------------------------------------------------------------------------- */
/*  Pipeline management (concurrency-safe)                                    */
/* -------------------------------------------------------------------------- */

async function doCreatePipeline(): Promise<Pipeline> {
  if (!pipelineFactory) throw new Error("transformers.js not loaded");
  const model = sttModel();
  getLogger().info("Loading local Whisper model (first use may download ~40-150 MB)", { model });
  const p = await pipelineFactory("automatic-speech-recognition", model);
  getLogger().info("Local Whisper model ready", { model });
  return p;
}

function getOrCreatePipeline(): Promise<Pipeline> {
  if (!pipelinePromise) pipelinePromise = doCreatePipeline();
  return pipelinePromise;
}

/* -------------------------------------------------------------------------- */
/*  Audio conversion                                                          */
/* -------------------------------------------------------------------------- */

const MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

function mimeToExt(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TO_EXT[base] ?? "audio";
}

/** Convert audio to 16 kHz mono Float32Array using FFmpeg. */
async function convertWithFfmpeg(audioData: Buffer, mimeType: string): Promise<Float32Array | null> {
  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) return null;

  const tmpDir = await mkdtemp(join(tmpdir(), "strada-stt-"));

  try {
    const ext = mimeToExt(mimeType);
    const inputPath = join(tmpDir, `input.${ext}`);
    const outputPath = join(tmpDir, "output.wav");

    await writeFile(inputPath, audioData);

    await execFileAsync(ffmpeg, [
      "-i", inputPath,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_f32le",
      "-f", "wav",
      "-y",
      outputPath,
    ], { timeout: 30_000 });

    const wavBuffer = await readFile(outputPath);
    return extractPcmFromF32leWav(wavBuffer);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse a WAV buffer produced by FFmpeg with pcm_f32le codec.
 * Finds the "data" sub-chunk and returns raw PCM as Float32Array.
 * Only valid for pcm_f32le WAV files (32-bit float LE) — returns null otherwise.
 */
function extractPcmFromF32leWav(wavBuf: Buffer): Float32Array | null {
  // Verify RIFF header
  if (wavBuf.length < 44) return null;
  if (wavBuf[0] !== 0x52 || wavBuf[1] !== 0x49 || wavBuf[2] !== 0x46 || wavBuf[3] !== 0x46) return null;

  // Check bit depth (offset 34) = 32 and audio format (offset 20) = 3 (IEEE float)
  const audioFormat = wavBuf.readUInt16LE(20);
  const bitsPerSample = wavBuf.readUInt16LE(34);
  if (audioFormat !== 3 || bitsPerSample !== 32) return null;

  // Find the "data" sub-chunk
  for (let i = 12; i < wavBuf.length - 8; i++) {
    if (wavBuf[i] === 0x64 && wavBuf[i + 1] === 0x61
      && wavBuf[i + 2] === 0x74 && wavBuf[i + 3] === 0x61) {
      const dataSize = wavBuf.readUInt32LE(i + 4);
      const offset = i + 8;
      const pcm = wavBuf.subarray(offset, offset + dataSize);
      // Ensure proper alignment for Float32Array
      const aligned = new Uint8Array(pcm.byteLength);
      aligned.set(pcm);
      return new Float32Array(aligned.buffer);
    }
  }
  return null;
}

/** Convert WAV buffer to Float32Array using the wavefile library (no FFmpeg). */
function convertWavDirect(audioData: Buffer): Float32Array | null {
  if (!WaveFileCtor) return null;

  try {
    const wav = new WaveFileCtor(audioData);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    const raw = wav.getSamples();
    if (Array.isArray(raw)) {
      const ch0 = raw[0];
      const ch1 = raw[1];
      if (!ch0) return null;
      if (ch1) {
        // Merge stereo → mono (plain average)
        for (let i = 0; i < ch0.length; i++) {
          ch0[i] = ((ch0[i] ?? 0) + (ch1[i] ?? 0)) / 2;
        }
      }
      return ch0;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Convert arbitrary audio buffer to 16 kHz mono Float32Array.
 * Tries wavefile (WAV only) → FFmpeg (all formats) → null.
 */
async function audioToFloat32(audioData: Buffer, mimeType: string): Promise<Float32Array | null> {
  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

  // For WAV input, try direct conversion first (fastest, no FFmpeg)
  if (normalizedMime === "audio/wav" || normalizedMime === "audio/x-wav") {
    const direct = convertWavDirect(audioData);
    if (direct) return direct;
  }

  // FFmpeg handles all formats: WebM, OGG, MP4, MP3, FLAC, WAV
  return convertWithFfmpeg(audioData, mimeType);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Transcribe audio buffer locally using Whisper.
 * Returns transcribed text or null if local STT is unavailable/fails.
 */
export async function transcribeLocal(
  audioData: Buffer,
  mimeType: string,
): Promise<string | null> {
  const mode = sttMode();
  if (mode === "disabled" || mode === "cloud") return null;

  if (!(await loadDependencies())) return null;

  const logger = getLogger();

  try {
    const samples = await audioToFloat32(audioData, mimeType);
    if (!samples || samples.length === 0) {
      logger.debug("Local STT: could not decode audio to PCM", { mimeType });
      return null;
    }

    const pipeline = await getOrCreatePipeline();

    const result = await Promise.race([
      pipeline(samples),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Local STT timeout (30 s)")), 30_000),
      ),
    ]);

    const text = result?.text?.trim() ?? "";
    if (text) {
      logger.debug("Local STT transcription completed", { mimeType, chars: text.length });
    }
    return text || null;
  } catch (error) {
    logger.warn("Local STT transcription failed", {
      error: error instanceof Error ? error.message : String(error),
      mimeType,
    });
    return null;
  }
}

/** Check if local STT is available (dependencies present, not disabled). */
export async function isLocalSttAvailable(): Promise<boolean> {
  const mode = sttMode();
  if (mode === "disabled" || mode === "cloud") return false;
  return loadDependencies();
}

/** Release the cached Whisper pipeline to free memory. */
export function disposeLocalStt(): void {
  const pending = pipelinePromise;
  pipelinePromise = null;
  if (pending) {
    void pending.then(async (p) => {
      const disposable = p as unknown as { dispose?: () => Promise<void> };
      await disposable.dispose?.();
    }).catch(() => {});
  }
}
