/**
 * Local-model runner — one isolated Python venv for all open-weights models,
 * driven over subprocess (the same headless pattern as the Unity path).
 *
 * Layout under ~/.strada/assets-local/:
 *   venv/                 one shared venv (torch is the heavy shared dep)
 *   scripts/              the inference drivers this runner writes
 *   weights/              HF_HOME cache for downloaded model weights
 *   .installed-<modelId>  marker per successfully installed model (the marker
 *                         alone is NOT the installed check — see
 *                         isModelInstalled: the weights under weights/ and a
 *                         repo-shipped model's src/<id> clone are measured too)
 *
 * Everything is optional: with nothing installed the generation tools fall
 * back to their procedural providers, and the setup menu is the only place
 * that ever pays the download cost.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, rmSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_REMOVAL_PACKAGES, getModelSpec, type LocalModelSpec } from "./model-catalog.js";
import { getLoggerSafe } from "../utils/logger.js";

// =============================================================================
// PYTHON DRIVERS (written into the venv area on demand)
// =============================================================================

export const TXT2IMG_SCRIPT = `import argparse, sys
p = argparse.ArgumentParser()
p.add_argument("--model", required=True)
p.add_argument("--family", default="sd15", choices=["sd15", "sdxl", "flux"])
p.add_argument("--prompt", default="")
p.add_argument("--negative", default="")
p.add_argument("--out", default="")
p.add_argument("--jobs", default="")
p.add_argument("--steps", type=int, default=0)
p.add_argument("--size", type=int, default=512)
p.add_argument("--rmbg", type=int, default=0)
p.add_argument("--seed", type=int, default=-1)
a = p.parse_args()
# One pipeline load for many prompts: --jobs names a JSON list of
# {"prompt","negative","out"}. Loading SD1.5 costs ~10 s per process; a
# sprint that needs two hundred sprites pays it once, not two hundred times.
import json
jobs = json.load(open(a.jobs)) if a.jobs else [{"prompt": a.prompt, "negative": a.negative, "out": a.out, "seed": a.seed}]
if not jobs or any(not j.get("prompt") or not j.get("out") for j in jobs):
    sys.exit("txt2img: every job needs a prompt and an out path")

import torch
device = "mps" if torch.backends.mps.is_available() else "cpu"
# fp16 on MPS is the classic black-image NaN trap for SD1.5/SDXL (measured
# live: a full-black pig sprite). fp32 on MPS is correct and cheap enough at
# 512²; FLUX is the exception — it is built for bfloat16.
if a.family == "flux":
    from diffusers import FluxPipeline
    pipe = FluxPipeline.from_pretrained(a.model, torch_dtype=torch.bfloat16)
    steps = a.steps or 4
elif a.family == "sdxl":
    from diffusers import StableDiffusionXLPipeline
    pipe = StableDiffusionXLPipeline.from_pretrained(a.model, torch_dtype=torch.float32)
    steps = a.steps or 25
else:
    from diffusers import StableDiffusionPipeline
    pipe = StableDiffusionPipeline.from_pretrained(a.model, torch_dtype=torch.float32)
    steps = a.steps or 20

pipe = pipe.to(device)
if device == "mps":
    pipe.enable_attention_slicing()

for job in jobs:
    # A seed makes a retry a different draw, and the same seed the same bytes.
    seed = int(job.get("seed", -1) if job.get("seed") is not None else -1)
    gen = torch.Generator(device="cpu").manual_seed(seed) if seed >= 0 else None
    image = pipe(prompt=job["prompt"], negative_prompt=job.get("negative") or None,
                 num_inference_steps=steps, height=a.size, width=a.size, generator=gen).images[0]
    if a.rmbg:
        # Game sprites need transparency, not a model-guessed background. rembg
        # (already in the venv for TripoSR) cuts the subject out; without this,
        # "plain white background" in the prompt is a coin flip the model loses.
        from rembg import remove
        cut = remove(image)
        # Measured 2026-09-07: a green pig on the green background the model
        # drew anyway — rembg removed the pig with the background and left 19 KB
        # of alpha specks. A cut-out that kept under 3% of the pixels is not a
        # sprite; the raw draw with its background is, and says so.
        try:
            alpha = cut.getchannel("A")
            opaque = sum(1 for v in alpha.getdata() if v > 32)
            coverage = opaque / float(alpha.width * alpha.height)
        except Exception:
            coverage = 1.0
        if coverage < 0.03:
            image = image.convert("RGBA")
            image.save(job["out"])
            print("KEPT-BG", job["out"], "coverage=%.3f" % coverage, flush=True)
            continue
        image = cut
    image.save(job["out"])
    print("WROTE", job["out"], flush=True)
`;

/**
 * Pull a model's weights into the HF cache at INSTALL time (item 2.15).
 *
 * Before this, weights were fetched lazily by the first inference, so
 * "installed" meant "a marker file exists" — a model whose weights had never
 * been downloaded, or had been deleted, or whose download died halfway read as
 * installed, the generation tools chose the local path, python failed inside
 * the driver and the sprint got a placeholder. Fetching here is also what lets
 * a sprint's first sprite be a draw instead of a 7 GB download inside the
 * inference timeout.
 *
 * Named files (`--files`) for models the driver loads by name (TripoSR);
 * otherwise the diffusers pipeline folder, which is exactly what
 * `from_pretrained` would have fetched.
 */
export const FETCH_WEIGHTS_SCRIPT = `import argparse, sys
p = argparse.ArgumentParser()
p.add_argument("--model", required=True)
p.add_argument("--files", default="")
a = p.parse_args()

names = [f for f in a.files.split(",") if f]
if names:
    from huggingface_hub import hf_hub_download
    for name in names:
        print("FETCHED", hf_hub_download(repo_id=a.model, filename=name), flush=True)
else:
    from diffusers import DiffusionPipeline
    print("FETCHED", DiffusionPipeline.download(a.model), flush=True)
`;

export const IMG2MESH_SCRIPT = `import argparse, sys
p = argparse.ArgumentParser()
p.add_argument("--weights", required=True)
p.add_argument("--image", required=True)
p.add_argument("--out", required=True)
a = p.parse_args()

import torch
from PIL import Image
from tsr.system import TSR

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = TSR.from_pretrained(a.weights, config_name="config.yaml", weight_name="model.ckpt")
model.to(device)

image = Image.open(a.image).convert("RGB")
with torch.no_grad():
    codes = model([image], device=device)
meshes = model.extract_mesh(codes, has_vertex_color=False, resolution=128)
meshes[0].export(a.out)
print("WROTE", a.out)
`;

// =============================================================================
// RUNNER
// =============================================================================

/**
 * Where the venv, scripts, weights and the `.installed-<model>` markers live.
 * Read at call time so a boot probe can point it at a throwaway directory and
 * prove that availability turns true with a marker and false without one
 * (Codex review 2026-09-07: the liveness probe accepted false === false).
 */
function ROOT_DIR(): string {
  return process.env["STRADA_ASSETS_LOCAL_ROOT"] ?? join(homedir(), ".strada", "assets-local");
}
const VENV = (): string => join(ROOT_DIR(), "venv");
const SCRIPTS = (): string => join(ROOT_DIR(), "scripts");
const WEIGHTS = (): string => join(ROOT_DIR(), "weights");
/**
 * Written once the venv has been MEASURED to import rembg + onnxruntime.
 * Holds the venv identity it was measured on: a rebuilt or broken venv
 * (different identity) is probed again instead of trusted (Codex
 * 2026-09-17: the marker was never invalidated).
 */
const RMBG_READY = (): string => join(ROOT_DIR(), ".rmbg-ready");
/** The import the txt2img driver performs under --rmbg; probed with the same names. */
export const RMBG_IMPORT_PROBE = "import rembg, onnxruntime";
/**
 * Bound on the in-place rembg/onnxruntime repair. Codex review 2026-09-17:
 * the repair ran under the process-wide inference lock with pip's 30-minute
 * budget, so one missing package on a slow or offline network held every
 * generation — keepBackground batches included — for up to ~34 minutes
 * with no progress line. Ten minutes covers the two wheels on any working
 * connection; past that the answer is "unavailable", not a hung sprint.
 */
export const RMBG_REPAIR_TIMEOUT_MS = 600_000;

/**
 * Where huggingface_hub caches one repo's files under HF_HOME=weights/:
 * `weights/hub/models--<org>--<name>/` (blobs + snapshots).
 */
export function hfWeightsDir(weightsRef: string): string {
  return join(WEIGHTS(), "hub", `models--${weightsRef.split("/").join("--")}`);
}

/** Every file under `dir`, depth-bounded, resolving symlinks for the sizes. */
function filesUnder(dir: string, depth = 8): Array<{ rel: string; size: number }> {
  if (depth < 0) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ rel: string; size: number }> = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // isDirectory() is false for a symlink to one, and the HF cache is built
    // out of symlinks: stat (not lstat) is what follows them.
    let isDir = entry.isDirectory();
    let size = 0;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = st.size;
      } catch {
        continue; // a dangling link is not a weight file
      }
    } else {
      try { size = statSync(full).size; } catch { continue; }
    }
    if (isDir) {
      for (const nested of filesUnder(full, depth - 1)) {
        out.push({ rel: `${entry.name}/${nested.rel}`, size: nested.size });
      }
    } else {
      out.push({ rel: entry.name, size });
    }
  }
  return out;
}

/**
 * Are this model's weights actually on disk? (item 2.15)
 *
 * The check `isModelInstalled` used to be was "a marker file exists", which a
 * never-downloaded, half-downloaded or deleted model satisfies just as well as
 * a working one. Here:
 *   - the model's HF cache directory must exist,
 *   - it must carry no `*.incomplete` blob — that is a download huggingface_hub
 *     stopped partway, and the driver would load nothing,
 *   - the file(s) the driver loads BY NAME (spec.weightFiles) must be present
 *     and non-empty; without named files, at least one non-empty file must be
 *     cached (a pipeline folder of zero-byte placeholders is not weights).
 */
/**
 * The snapshot directory of the revision the driver will actually load, or
 * null when the cache names none.
 *
 * The Hugging Face cache keeps one directory per revision under
 * `snapshots/<sha>`, whose files are symlinks into `blobs/`, and `refs/main`
 * holds the sha that "main" currently means. Checking the whole cache instead
 * accepted a metadata-only leftover and let required files be collected from
 * DIFFERENT revisions (Codex 2026-09-17 round 9 #25).
 */
function hfSnapshotDir(spec: LocalModelSpec): string | null {
  const root = hfWeightsDir(spec.weightsRef);
  const snapshots = join(root, "snapshots");
  if (!existsSync(snapshots)) {
    // A cache laid down by something other than huggingface_hub (or a test
    // fixture): the root itself is the revision.
    return existsSync(root) ? root : null;
  }
  const ref = spec.weightsRevision ?? "main";
  try {
    const sha = readFileSync(join(root, "refs", ref), "utf-8").trim();
    if (sha && existsSync(join(snapshots, sha))) return join(snapshots, sha);
  } catch {
    // no ref file: fall through to the newest snapshot below
  }
  try {
    const dirs = readdirSync(snapshots, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(snapshots, e.name));
    if (dirs.length === 1) return dirs[0]!;
    // Several revisions and no usable ref: nothing names which one the driver
    // would load, so do not claim an installation.
    return null;
  } catch {
    return null;
  }
}

/** A file in a snapshot whose blob is still downloading is not there yet. */
function blobIsComplete(file: string): boolean {
  try {
    const target = realpathSync(file);
    if (existsSync(`${target}.incomplete`)) return false;
    return statSync(target).size > 0;
  } catch {
    // Not a link, or the target is gone: judge the path itself.
    try {
      return statSync(file).size > 0 && !existsSync(`${file}.incomplete`);
    } catch {
      return false;
    }
  }
}

/** Files that describe a model without being one. */
const WEIGHT_METADATA_RE = /\.(?:json|txt|md|ya?ml|py)$/iu;

/**
 * Whether the weights the driver loads are on disk, COMPLETE, and all from one
 * revision.
 *
 * Two ways this used to lie (round 9 #25): a cache holding only
 * `model_index.json` or `refs/main` read as installed, and a perfectly usable
 * revision read as NOT installed because some abandoned download had left an
 * unrelated `.incomplete` blob elsewhere in the cache.
 */
export function modelWeightsPresent(spec: LocalModelSpec): boolean {
  const snapshot = hfSnapshotDir(spec);
  if (snapshot === null) return false;
  const files = filesUnder(snapshot);
  const named = spec.weightFiles ?? [];
  if (named.length > 0) {
    // Every named file, in THIS revision, with its blob finished.
    return named.every((name) => {
      const match = files.find((f) => f.rel === name || f.rel.endsWith(`/${name}`));
      return match !== undefined && blobIsComplete(join(snapshot, match.rel));
    });
  }
  // Nothing named: at least one file that is a MODEL rather than a description
  // of one, with its blob finished.
  return files.some((f) => !f.rel.endsWith(".incomplete") && !WEIGHT_METADATA_RE.test(f.rel) && blobIsComplete(join(snapshot, f.rel)));
}


/**
 * The local artifacts an install left behind, beyond the weights: a
 * repo-shipped model (TripoSR) runs from the clone under `src/<id>`, which the
 * driver imports through PYTHONPATH. A deleted clone is not an installation
 * however intact the marker is.
 */
function installArtifactsPresent(spec: LocalModelSpec): boolean {
  if (spec.installMethod !== "repo") return true;
  const repoDir = join(ROOT_DIR(), "src", spec.id);
  return existsSync(repoDir) && filesUnder(repoDir, 2).length > 0;
}

/**
 * What identifies THIS venv: the interpreter link and pyvenv.cfg as they were
 * created. A rebuilt venv gets new ones; the same venv keeps them. "" when
 * there is no venv. (lstat: the interpreter is a symlink to the system
 * python, whose own mtime never changes when a venv is recreated.)
 */
export function venvIdentity(): string {
  try {
    const py = lstatSync(venvPython());
    let cfg = "";
    try { cfg = String(statSync(join(VENV(), "pyvenv.cfg")).mtimeMs); } catch { /* no cfg in a test venv */ }
    return `${py.mtimeMs}:${py.ino}:${cfg}`;
  } catch {
    return "";
  }
}

/**
 * A repair that failed is not retried on the next call (Codex 2026-09-17:
 * "once" was once per CALL — import fails, pip exits 0, import still fails,
 * and every sprite paid probe → pip → probe again). Keyed by the venv path
 * and bound to the venv's identity: a rebuilt venv is tried afresh.
 */
const failedRepairs = new Map<string, { identity: string; detail: string }>();

export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultSpawn: SpawnImpl = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, env: opts.env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const anyErr = err as NodeJS.ErrnoException & { code?: unknown; signal?: string; killed?: boolean };
        if (typeof anyErr.code === "number") {
          resolvePromise({ code: anyErr.code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        // A timeout (SIGTERM, code null), a missing interpreter (ENOENT) or
        // an overflowed buffer is a FAILED inference, not an exception for
        // the tool to leak (review 2026-09-07: a killed batch threw out of
        // the tool and left every job's .meta behind).
        const why = anyErr.killed || anyErr.signal
          ? `killed by ${anyErr.signal ?? "timeout"} after ${opts.timeoutMs} ms`
          : anyErr.message;
        resolvePromise({ code: -1, stdout: String(stdout), stderr: `${String(stderr)}\n${why}`.trim() });
        return;
      }
      resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

function venvPython(): string {
  return join(VENV(), "bin", "python3");
}

export class LocalModelRunner {
  constructor(private readonly spawn: SpawnImpl = defaultSpawn) {}

  /**
   * One inference at a time, process-wide. Measured 2026-09-07 15:38: an
   * agent issued two unity_generate_sprite calls in the same second; each
   * spawned its own SD1.5 process, two 4 GB pipelines shared the GPU, and
   * both drew slower than one after the other would have. Calls queue here
   * in arrival order; a batch already loads once for many.
   */
  private static inferenceQueue: Promise<unknown> = Promise.resolve();

  private async inference<T>(run: () => Promise<T>): Promise<T> {
    const turn = LocalModelRunner.inferenceQueue.then(run, run);
    LocalModelRunner.inferenceQueue = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Dependency preflight/repair runs on ITS OWN queue, never the inference
   * lock: two --rmbg callers repair once between them, while a keepBackground
   * batch or a mesh lift is free to run meanwhile (Codex review 2026-09-17).
   */
  private static preflightQueue: Promise<unknown> = Promise.resolve();

  private async preflight<T>(run: () => Promise<T>): Promise<T> {
    const turn = LocalModelRunner.preflightQueue.then(run, run);
    LocalModelRunner.preflightQueue = turn.catch(() => undefined);
    return turn;
  }

  venvReady(): boolean {
    return existsSync(venvPython());
  }

  /**
   * Can this model actually run right now? (item 2.15)
   *
   * "The marker exists" was the whole test, so a model whose weights were
   * never downloaded, were deleted, or stopped halfway reported installed:
   * the generation tools then chose the local path, python died inside the
   * driver, and the run produced a placeholder that blamed nothing. The
   * measurement is now the venv, a marker with content, the install's own
   * local artifacts (a repo-shipped model's clone) and the weights on disk.
   *
   * An id that is not in the catalogue is not installed — there is no spec to
   * measure against, and nothing can run it.
   */
  isModelInstalled(modelId: string): boolean {
    if (!this.venvReady()) return false;
    const markerPath = join(ROOT_DIR(), `.installed-${modelId}`);
    let marked = false;
    try {
      marked = statSync(markerPath).size > 0;
    } catch {
      return false;
    }
    if (!marked) return false;
    const spec = getModelSpec(modelId);
    if (!spec) return false;
    return installArtifactsPresent(spec) && modelWeightsPresent(spec);
  }

  /** Create the venv and install a model (idempotent). */
  async install(spec: LocalModelSpec, onProgress?: (line: string) => void): Promise<{ ok: boolean; detail: string }> {
    try {
      mkdirSync(SCRIPTS(), { recursive: true });
      mkdirSync(WEIGHTS(), { recursive: true });
      this.writeScripts();
      this.forgetBackgroundRemoval();

      if (!this.venvReady()) {
        onProgress?.("creating venv…");
        const made = await this.spawn("python3", ["-m", "venv", VENV()], { timeoutMs: 120_000 });
        if (made.code !== 0) return { ok: false, detail: `venv creation failed: ${made.stderr.slice(0, 300)}` };
      }

      const env = this.envWithWeights();
      const pipUp = await this.spawn(venvPython(), ["-m", "pip", "install", "--upgrade", "pip"], { timeoutMs: 300_000, env });
      if (pipUp.code !== 0) return { ok: false, detail: `pip upgrade failed: ${pipUp.stderr.slice(0, 300)}` };

      if (spec.installMethod === "repo") {
        return this.installFromRepo(spec, env, onProgress);
      }

      onProgress?.(`installing ${spec.pipPackages.length} pip packages (this is the long step)…`);
      const install = await this.spawn(
        venvPython(),
        ["-m", "pip", "install", ...spec.pipPackages],
        { timeoutMs: 1_800_000, env },
      );
      if (install.code !== 0) return { ok: false, detail: `pip install failed: ${install.stderr.slice(-500)}` };

      const weights = await this.fetchWeights(spec, env, onProgress);
      if (!weights.ok) return weights;

      writeFileSync(join(ROOT_DIR(), `.installed-${spec.id}`), new Date().toISOString() + "\n");
      return { ok: true, detail: `${spec.label} installed.` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Clone-install a repo-shipped model (TripoSR: no pip package at root). */
  private async installFromRepo(
    spec: LocalModelSpec,
    env: NodeJS.ProcessEnv,
    onProgress?: (line: string) => void,
  ): Promise<{ ok: boolean; detail: string }> {
    const repoDir = join(ROOT_DIR(), "src", spec.id);
    if (!existsSync(repoDir)) {
      onProgress?.(`cloning ${spec.repoUrl}…`);
      const clone = await this.spawn(
        "git",
        ["clone", "--depth", "1", spec.repoUrl ?? "", repoDir],
        { timeoutMs: 600_000, env },
      );
      if (clone.code !== 0) return { ok: false, detail: `git clone failed: ${clone.stderr.slice(0, 300)}` };
    }
    const reqFile = join(repoDir, spec.repoRequirements ?? "requirements.txt");
    // TripoSR's requirements.txt deliberately does NOT pin torch — the repo
    // README tells you to install it first for your platform (measured:
    // inference died with 'No module named torch' right after a "successful"
    // install). Install it explicitly before the requirements.
    const torchProbe = await this.spawn(venvPython(), ["-c", "import torch"], { timeoutMs: 30_000, env });
    if (torchProbe.code !== 0) {
      onProgress?.("installing torch (the long step)…");
      const torch = await this.spawn(
        venvPython(),
        ["-m", "pip", "install", "torch", "torchvision"],
        { timeoutMs: 1_800_000, env },
      );
      if (torch.code !== 0) return { ok: false, detail: `torch install failed: ${torch.stderr.slice(-400)}` };
    }
    // Native deps that fail to build on modern Apple toolchains (measured
    // 2026-08-27: xatlas's bundled pybind11 trips new CMake minimums;
    // torchmcubes likewise). They are swapped for wheel-only equivalents:
    // skimage's marching_cubes replaces torchmcubes; xatlas (texture baking
    // only) is dropped and its import guarded by the compat patch below.
    const SKIP_NATIVE = ["torchmcubes", "xatlas"];
    const compatReq = join(repoDir, "requirements-compat.txt");
    if (!existsSync(compatReq)) {
      const lines = readFileSync(reqFile, "utf8").split("\n");
      const kept = lines.filter((l) => !SKIP_NATIVE.some((s) => l.toLowerCase().includes(s)));
      kept.push("scikit-image");
      kept.push("onnxruntime"); // rembg's undeclared runtime dep (measured: ModuleNotFoundError)
      writeFileSync(compatReq, kept.join("\n"), "utf8");
      this.applyTriposrCompatPatch(repoDir);
    }
    onProgress?.("installing repo requirements (torch is the long step)…");
    const install = await this.spawn(
      venvPython(),
      ["-m", "pip", "install", "-r", compatReq],
      { timeoutMs: 1_800_000, env },
    );
    if (install.code !== 0) return { ok: false, detail: `repo requirements failed: ${install.stderr.slice(-500)}` };

    const weights = await this.fetchWeights(spec, env, onProgress);
    if (!weights.ok) return weights;

    writeFileSync(join(ROOT_DIR(), `.installed-${spec.id}`), new Date().toISOString() + "\n");
    return { ok: true, detail: `${spec.label} installed (from source).` };
  }

  /**
   * Download the weights into the HF cache as part of the install, so a
   * finished install is a model that can draw offline (item 2.15). The
   * download's exit code is the verdict here — the same authority pip gets —
   * while `isModelInstalled` independently measures the bytes on disk, so a
   * later deletion or a partial cache is caught even if this step once
   * reported success.
   */
  private async fetchWeights(
    spec: LocalModelSpec,
    env: NodeJS.ProcessEnv,
    onProgress?: (line: string) => void,
  ): Promise<{ ok: boolean; detail: string }> {
    this.writeScripts();
    onProgress?.(`downloading ${spec.label} weights (~${spec.diskGb} GB, resumable)…`);
    const args = [join(SCRIPTS(), "fetch_weights.py"), "--model", spec.weightsRef];
    if (spec.weightFiles && spec.weightFiles.length > 0) args.push("--files", spec.weightFiles.join(","));
    const run = await this.spawn(venvPython(), args, { timeoutMs: 3_600_000, env });
    if (run.code !== 0) {
      return { ok: false, detail: `weights download failed: ${(run.stderr || run.stdout).slice(-400)}` };
    }
    return { ok: true, detail: `${spec.label} weights cached.` };
  }

  /** text → PNG. Returns the written path on success. */
  async textToImage(
    spec: LocalModelSpec,
    prompt: string,
    outPath: string,
    opts: { negative?: string; size?: number; steps?: number; removeBackground?: boolean; seed?: number; onProgress?: (line: string) => void } = {},
  ): Promise<{ ok: boolean; detail: string }> {
    if (!this.isModelInstalled(spec.id)) {
      return { ok: false, detail: `${spec.label} is not installed — run assets-local-setup first.` };
    }
    this.writeScripts();
    const family = spec.id === "flux-schnell" ? "flux" : spec.id === "sdxl" ? "sdxl" : "sd15";
    const args = [
      join(SCRIPTS(), "txt2img.py"),
      "--model", spec.weightsRef,
      "--family", family,
      "--prompt", prompt,
      "--negative", opts.negative ?? "",
      "--out", outPath,
      "--steps", String(opts.steps ?? 0),
      "--size", String(opts.size ?? 512),
      "--rmbg", opts.removeBackground ? "1" : "0",
      "--seed", String(opts.seed ?? -1),
    ];
    const env = this.envWithWeights();
    if (opts.removeBackground) {
      // BEFORE the inference lock — see preflight().
      const rmbg = await this.preflight(() => this.ensureBackgroundRemoval(env, opts.onProgress));
      if (!rmbg.ok) return { ok: false, detail: rmbg.detail };
    }
    const run = await this.inference(() => this.spawn(venvPython(), args, { timeoutMs: 1_200_000, env }));
    if (run.code !== 0 || !existsSync(outPath)) {
      return { ok: false, detail: `inference failed: ${(run.stderr || run.stdout).slice(-400)}` };
    }
    return { ok: true, detail: /^KEPT-BG /m.test(run.stdout) ? `${outPath} (background kept: the cut-out was empty)` : outPath };
  }

  /**
   * Many prompts, one pipeline load. Each job is judged by its own file on
   * disk afterwards, so a batch that died halfway reports exactly which
   * sprites exist — never "the batch failed" over a directory of real files.
   */
  async textToImageBatch(
    spec: LocalModelSpec,
    jobs: ReadonlyArray<{ prompt: string; out: string; negative?: string; seed?: number }>,
    opts: { size?: number; steps?: number; removeBackground?: boolean; onProgress?: (line: string) => void } = {},
  ): Promise<{ ok: boolean; detail: string; written: string[]; missing: string[]; keptBackground: string[] }> {
    if (!this.isModelInstalled(spec.id)) {
      return { ok: false, detail: `${spec.label} is not installed — run assets-local-setup first.`, written: [], missing: jobs.map((j) => j.out), keptBackground: [] };
    }
    if (jobs.length === 0) return { ok: true, detail: "no jobs", written: [], missing: [], keptBackground: [] };
    this.writeScripts();
    const family = spec.id === "flux-schnell" ? "flux" : spec.id === "sdxl" ? "sdxl" : "sd15";
    // A UNIQUE name, exclusively created. Two batches starting in the same
    // process and the same millisecond wrote the same manifest: both
    // subprocesses read the second one's jobs, the first batch's images were
    // never drawn, and cleanup deleted a file the other call was still using
    // (Codex 2026-09-11 N#12).
    const jobsPath = join(tmpdir(), `strada-txt2img-${process.pid}-${randomUUID()}.json`);
    writeFileSync(jobsPath, JSON.stringify(jobs.map((j) => ({ prompt: j.prompt, negative: j.negative ?? "", out: j.out, seed: j.seed ?? -1 }))), "utf8");
    try {
      const args = [
        join(SCRIPTS(), "txt2img.py"),
        "--model", spec.weightsRef,
        "--family", family,
        "--jobs", jobsPath,
        "--steps", String(opts.steps ?? 0),
        "--size", String(opts.size ?? 512),
        "--rmbg", opts.removeBackground ? "1" : "0",
      ];
      // Only files this run produced count as written (review 2026-09-07:
      // a batch that drew nothing over three earlier PNGs reported "3 of 3
      // written" because the outputs existed).
      const before = new Map<string, number>();
      for (const j of jobs) {
        try { before.set(j.out, statSync(j.out).mtimeMs); } catch { /* absent */ }
      }
      // Budget scales with the batch: one sprite is ~45-60 s at 512² on MPS.
      const env = this.envWithWeights();
      if (opts.removeBackground) {
        // BEFORE the inference lock — see preflight().
        const rmbg = await this.preflight(() => this.ensureBackgroundRemoval(env, opts.onProgress));
        if (!rmbg.ok) return { ok: false, detail: rmbg.detail, written: [], missing: jobs.map((j) => j.out), keptBackground: [] };
      }
      const run = await this.inference(() => this.spawn(venvPython(), args, { timeoutMs: Math.min(3_600_000, 300_000 + 120_000 * jobs.length), env }));
      const producedNow = (o: string): boolean => {
        try {
          const m = statSync(o).mtimeMs;
          const prior = before.get(o);
          return prior === undefined || m !== prior;
        } catch {
          return false;
        }
      };
      const written = jobs.map((j) => j.out).filter(producedNow);
      const missing = jobs.map((j) => j.out).filter((o) => !producedNow(o));
      const keptBackground = (run.stdout.match(/^KEPT-BG (.+?) coverage=/gm) ?? []).map((l) => l.replace(/^KEPT-BG /, "").replace(/ coverage=$/, ""));
      const ok = run.code === 0 && missing.length === 0;
      return {
        ok,
        detail: ok ? `${written.length} written` : `${written.length} of ${jobs.length} written; ${(run.stderr || run.stdout).slice(-400)}`,
        written,
        missing,
        keptBackground,
      };
    } finally {
      try { rmSync(jobsPath, { force: true }); } catch { /* temp */ }
    }
  }

  /** image → OBJ mesh (TripoSR family). Returns the written path on success. */
  async imageToMesh(
    spec: LocalModelSpec,
    imagePath: string,
    outPath: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!this.isModelInstalled(spec.id)) {
      return { ok: false, detail: `${spec.label} is not installed — run assets-local-setup first.` };
    }
    this.writeScripts();
    // INTO A STAGING PATH, never over the target. The subprocess was trusted
    // to have produced geometry because it exited 0 and the target path
    // existed — so a file that already held `NOT AN OBJ AT ALL`, or an old
    // placeholder, was reported as a freshly generated mesh while the
    // inference wrote nothing (Codex 2026-09-12 AE#10).
    // THE EXTENSION IS THE FORMAT. `Hero.obj.staging` makes the exporter
    // infer a "staging" format and throw, which would have failed every real
    // local mesh run (Codex 2026-09-13 AF#10). The staging name keeps the
    // target's extension.
    const dot = outPath.lastIndexOf(".");
    const staged = dot > outPath.lastIndexOf("/") ? `${outPath.slice(0, dot)}.staging${outPath.slice(dot)}` : `${outPath}.staging`;
    try { rmSync(staged, { force: true }); } catch { /* nothing to clear */ }
    const args = [
      join(SCRIPTS(), "img2mesh.py"),
      "--weights", spec.weightsRef,
      "--image", imagePath,
      "--out", staged,
    ];
    // Through the same process-wide lock as the draws: two lifts, or a lift
    // beside a draw, overlapped on one GPU (review 2026-09-07).
    const run = await this.inference(() => this.spawn(venvPython(), args, {
      timeoutMs: 1_200_000,
      env: spec.installMethod === "repo" ? this.envForRepo(spec) : this.envWithWeights(),
    }));
    if (run.code !== 0 || !existsSync(staged)) {
      try { rmSync(staged, { force: true }); } catch { /* best effort */ }
      return { ok: false, detail: `inference failed: ${(run.stderr || run.stdout).slice(-400)}` };
    }
    // …AND IT MUST BE GEOMETRY. An exit code says the process ended, not that
    // it produced a mesh (AE#10).
    const usable = meshBytesAreUsable(outPath, readFileSync(staged));
    if (!usable.ok) {
      try { rmSync(staged, { force: true }); } catch { /* best effort */ }
      return { ok: false, detail: `inference produced no usable geometry: ${usable.why}` };
    }
    renameSync(staged, outPath);
    return { ok: true, detail: outPath };
  }

  /**
   * The venv can run `--rmbg`, or the reason it cannot — never a crash into
   * a placeholder. Audit A3 / D55: text-to-image installs before 2026-09-17
   * carried no rembg/onnxruntime (they came in only with TripoSR's
   * requirements), so an image-only install died at `from rembg import
   * remove` on its first sprite. The check is the real import; a marker
   * bearing install that lacks the packages is repaired in place (one pip
   * install), and when even that fails the answer names the fix.
   */
  async ensureBackgroundRemoval(
    env: NodeJS.ProcessEnv = this.envWithWeights(),
    onProgress?: (line: string) => void,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const identity = venvIdentity();
    if (identity !== "" && this.readRmbgMarker() === identity) return { ok: true };
    const remembered = failedRepairs.get(VENV());
    if (remembered !== undefined && remembered.identity === venvIdentity()) {
      return { ok: false, detail: `${remembered.detail} (repair already attempted for this venv; not retried until it is reinstalled)` };
    }
    const progress = (line: string): void => {
      onProgress?.(line);
      getLoggerSafe().info(`assets-local: ${line}`);
    };
    const probe = (): Promise<{ code: number; stdout: string; stderr: string }> =>
      this.spawn(venvPython(), ["-c", RMBG_IMPORT_PROBE], { timeoutMs: 120_000, env });
    progress(`checking the venv for ${BACKGROUND_REMOVAL_PACKAGES.join("/")} (background removal)…`);
    let check = await probe();
    if (check.code !== 0) {
      progress(`installing ${BACKGROUND_REMOVAL_PACKAGES.join(" ")} into the venv (bounded to ${Math.round(RMBG_REPAIR_TIMEOUT_MS / 60_000)} min)…`);
      const install = await this.spawn(
        venvPython(),
        ["-m", "pip", "install", ...BACKGROUND_REMOVAL_PACKAGES],
        { timeoutMs: RMBG_REPAIR_TIMEOUT_MS, env },
      );
      check = install.code === 0 ? await probe() : install;
      if (check.code !== 0) {
        const detail =
          `background removal unavailable — the venv cannot import ${BACKGROUND_REMOVAL_PACKAGES.join("/")} and ` +
          `installing them failed (${(check.stderr || check.stdout).slice(-300).trim() || "no output"}). ` +
          "Reinstall the model with `strada assets-local-setup --model <id>`, or pass keepBackground: true.";
        failedRepairs.set(VENV(), { identity: venvIdentity(), detail });
        return { ok: false, detail };
      }
    }
    try { writeFileSync(RMBG_READY(), venvIdentity() + "\n"); } catch { /* marker is a cache */ }
    return { ok: true };
  }

  private readRmbgMarker(): string {
    try { return readFileSync(RMBG_READY(), "utf8").trim(); } catch { return ""; }
  }

  /**
   * install() is about to create or change the venv: what was measured on
   * the old one (ready marker, remembered failure) no longer applies.
   */
  private forgetBackgroundRemoval(): void {
    try { rmSync(RMBG_READY(), { force: true }); } catch { /* cache */ }
    failedRepairs.delete(VENV());
  }

  private envWithWeights(): NodeJS.ProcessEnv {
    return { ...process.env, HF_HOME: WEIGHTS() };
  }

  private envForRepo(spec: LocalModelSpec): NodeJS.ProcessEnv {
    return { ...this.envWithWeights(), PYTHONPATH: join(ROOT_DIR(), "src", spec.id) };
  }

  /**
   * Wheel-only shims for TripoSR's two native deps (see SKIP_NATIVE above):
   * a skimage-backed marching_cubes at the same import site, and a guarded
   * xatlas import (texture baking stays unavailable, geometry export works).
   */
  private applyTriposrCompatPatch(repoDir: string): void {
    const shimPath = join(repoDir, "tsr", "_compat_mcb.py");
    if (!existsSync(shimPath)) {
      writeFileSync(
        shimPath,
        `"""Wheel-only marching_cubes shim (skimage backend), matching the
torchmcubes signature: (density[torch.Tensor, NxNxN], level) -> (verts, faces)."""
import numpy as np
import torch
from skimage.measure import marching_cubes as _sk_mc


def marching_cubes(density, level: float = 0.0):
    arr = density.detach().cpu().numpy() if isinstance(density, torch.Tensor) else np.asarray(density)
    verts, faces, _normals, _values = _sk_mc(arr, level=level)
    device = density.device if isinstance(density, torch.Tensor) else "cpu"
    return (
        torch.from_numpy(verts.astype(np.float32)).to(device),
        torch.from_numpy(faces.astype(np.int64)).to(device),
    )
`,
        "utf8",
      );
    }

    const isoPath = join(repoDir, "tsr", "models", "isosurface.py");
    if (existsSync(isoPath)) {
      const src = readFileSync(isoPath, "utf8");
      if (src.includes("from torchmcubes import marching_cubes")) {
        writeFileSync(
          isoPath,
          src.replace("from torchmcubes import marching_cubes", "from tsr._compat_mcb import marching_cubes"),
          "utf8",
        );
      }
    }

    const bakePath = join(repoDir, "tsr", "bake_texture.py");
    if (existsSync(bakePath)) {
      const src = readFileSync(bakePath, "utf8");
      if (src.startsWith("import xatlas") || src.includes("\nimport xatlas")) {
        writeFileSync(
          bakePath,
          src.replace(/^import xatlas$/m, "try:\n    import xatlas\nexcept ImportError:  # texture baking unavailable without xatlas\n    xatlas = None"),
          "utf8",
        );
      }
    }
  }

  private writeScripts(): void {
    // Rewrite on CONTENT drift, not just absence: write-once meant an upgrade
    // never refreshed an installed machine's scripts, so fixes baked into the
    // embedded source (e.g. fp32-on-MPS black images) never reached it.
    const refresh = (path: string, content: string): void => {
      try {
        if (existsSync(path) && readFileSync(path, "utf8") === content) return;
      } catch {
        // Unreadable → rewrite below.
      }
      writeFileSync(path, content, "utf8");
    };
    mkdirSync(SCRIPTS(), { recursive: true });
    refresh(join(SCRIPTS(), "txt2img.py"), TXT2IMG_SCRIPT);
    refresh(join(SCRIPTS(), "img2mesh.py"), IMG2MESH_SCRIPT);
    refresh(join(SCRIPTS(), "fetch_weights.py"), FETCH_WEIGHTS_SCRIPT);
  }
}

export function localAssetsRoot(): string {
  return ROOT_DIR();
}

/**
 * Is this what a mesh file looks like?
 *
 * The acceptance test for a local image-to-3D run was "the process exited 0
 * and the path exists" — and the path already existed, holding whatever was
 * there before: invalid bytes, an old placeholder, a previous mesh. Every one
 * of them was reported as newly generated (Codex 2026-09-12 AE#10).
 */
export function meshBytesAreUsable(path: string, bytes: Buffer): { ok: true } | { ok: false; why: string } {
  if (bytes.length === 0) return { ok: false, why: "the file is empty" };
  const lower = path.toLowerCase();
  if (lower.endsWith(".glb")) {
    return bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "glTF"
      ? { ok: true }
      : { ok: false, why: "the bytes are not a glTF binary" };
  }
  if (lower.endsWith(".fbx")) {
    return bytes.subarray(0, 18).toString("ascii").startsWith("Kaydara")
      ? { ok: true }
      : { ok: false, why: "the bytes are not an FBX" };
  }
  // OBJ: vertices AND faces. A vertex cloud draws nothing in Unity.
  // THREE COORDINATES, and a leading decimal point is a number: `v .1 .2 .3`
  // is a vertex and was read as "no vertex data", while `f rubbish` counted as
  // a face (Codex 2026-09-13 AF#10).
  const text = bytes.subarray(0, 2_000_000).toString("utf8");
  const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
  const vertices = new RegExp(String.raw`^v\s+${NUMBER}\s+${NUMBER}\s+${NUMBER}`, "m").test(text);
  // A face names vertices: indices, optionally with texture/normal parts.
  const faces = /^f\s+-?\d+(?:\/\d*(?:\/\d*)?)?(?:\s+-?\d+(?:\/\d*(?:\/\d*)?)?){2,}/m.test(text);
  if (!vertices || !faces) {
    return { ok: false, why: `the file holds ${vertices ? "vertices but no faces" : "no vertex data"}` };
  }
  return { ok: true };
}
