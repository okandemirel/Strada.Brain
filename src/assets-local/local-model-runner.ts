/**
 * Local-model runner — one isolated Python venv for all open-weights models,
 * driven over subprocess (the same headless pattern as the Unity path).
 *
 * Layout under ~/.strada/assets-local/:
 *   venv/                 one shared venv (torch is the heavy shared dep)
 *   scripts/              the inference drivers this runner writes
 *   weights/              HF_HOME cache for downloaded model weights
 *   .installed-<modelId>  marker per successfully installed model
 *
 * Everything is optional: with nothing installed the generation tools fall
 * back to their procedural providers, and the setup menu is the only place
 * that ever pays the download cost.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LocalModelSpec } from "./model-catalog.js";

// =============================================================================
// PYTHON DRIVERS (written into the venv area on demand)
// =============================================================================

export const TXT2IMG_SCRIPT = `import argparse, sys
p = argparse.ArgumentParser()
p.add_argument("--model", required=True)
p.add_argument("--family", default="sd15", choices=["sd15", "sdxl", "flux"])
p.add_argument("--prompt", required=True)
p.add_argument("--negative", default="")
p.add_argument("--out", required=True)
p.add_argument("--steps", type=int, default=0)
p.add_argument("--size", type=int, default=512)
p.add_argument("--rmbg", type=int, default=0)
a = p.parse_args()

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

image = pipe(prompt=a.prompt, negative_prompt=a.negative or None,
             num_inference_steps=steps, height=a.size, width=a.size).images[0]

if a.rmbg:
    # Game sprites need transparency, not a model-guessed background. rembg
    # (already in the venv for TripoSR) cuts the subject out; without this,
    # "plain white background" in the prompt is a coin flip the model loses.
    from rembg import remove
    image = remove(image)

image.save(a.out)
print("WROTE", a.out)
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

const ROOT = join(homedir(), ".strada", "assets-local");
const VENV = join(ROOT, "venv");
const SCRIPTS = join(ROOT, "scripts");
const WEIGHTS = join(ROOT, "weights");

export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultSpawn: SpawnImpl = (cmd, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, env: opts.env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const anyErr = err as NodeJS.ErrnoException & { code?: unknown };
        if (typeof anyErr.code === "number") {
          resolvePromise({ code: anyErr.code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        reject(err);
        return;
      }
      resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

function venvPython(): string {
  return join(VENV, "bin", "python3");
}

export class LocalModelRunner {
  constructor(private readonly spawn: SpawnImpl = defaultSpawn) {}

  venvReady(): boolean {
    return existsSync(venvPython());
  }

  isModelInstalled(modelId: string): boolean {
    return this.venvReady() && existsSync(join(ROOT, `.installed-${modelId}`));
  }

  /** Create the venv and install a model (idempotent). */
  async install(spec: LocalModelSpec, onProgress?: (line: string) => void): Promise<{ ok: boolean; detail: string }> {
    try {
      mkdirSync(SCRIPTS, { recursive: true });
      mkdirSync(WEIGHTS, { recursive: true });
      this.writeScripts();

      if (!this.venvReady()) {
        onProgress?.("creating venv…");
        const made = await this.spawn("python3", ["-m", "venv", VENV], { timeoutMs: 120_000 });
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

      writeFileSync(join(ROOT, `.installed-${spec.id}`), new Date().toISOString() + "\n");
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
    const repoDir = join(ROOT, "src", spec.id);
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

    writeFileSync(join(ROOT, `.installed-${spec.id}`), new Date().toISOString() + "\n");
    return { ok: true, detail: `${spec.label} installed (from source).` };
  }

  /** text → PNG. Returns the written path on success. */
  async textToImage(
    spec: LocalModelSpec,
    prompt: string,
    outPath: string,
    opts: { negative?: string; size?: number; steps?: number; removeBackground?: boolean } = {},
  ): Promise<{ ok: boolean; detail: string }> {
    if (!this.isModelInstalled(spec.id)) {
      return { ok: false, detail: `${spec.label} is not installed — run assets-local-setup first.` };
    }
    this.writeScripts();
    const family = spec.id === "flux-schnell" ? "flux" : spec.id === "sdxl" ? "sdxl" : "sd15";
    const args = [
      join(SCRIPTS, "txt2img.py"),
      "--model", spec.weightsRef,
      "--family", family,
      "--prompt", prompt,
      "--negative", opts.negative ?? "",
      "--out", outPath,
      "--steps", String(opts.steps ?? 0),
      "--size", String(opts.size ?? 512),
      "--rmbg", opts.removeBackground ? "1" : "0",
    ];
    const run = await this.spawn(venvPython(), args, { timeoutMs: 1_200_000, env: this.envWithWeights() });
    if (run.code !== 0 || !existsSync(outPath)) {
      return { ok: false, detail: `inference failed: ${(run.stderr || run.stdout).slice(-400)}` };
    }
    return { ok: true, detail: outPath };
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
    const args = [
      join(SCRIPTS, "img2mesh.py"),
      "--weights", spec.weightsRef,
      "--image", imagePath,
      "--out", outPath,
    ];
    const run = await this.spawn(venvPython(), args, {
      timeoutMs: 1_200_000,
      env: spec.installMethod === "repo" ? this.envForRepo(spec) : this.envWithWeights(),
    });
    if (run.code !== 0 || !existsSync(outPath)) {
      return { ok: false, detail: `inference failed: ${(run.stderr || run.stdout).slice(-400)}` };
    }
    return { ok: true, detail: outPath };
  }

  private envWithWeights(): NodeJS.ProcessEnv {
    return { ...process.env, HF_HOME: WEIGHTS };
  }

  private envForRepo(spec: LocalModelSpec): NodeJS.ProcessEnv {
    return { ...this.envWithWeights(), PYTHONPATH: join(ROOT, "src", spec.id) };
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
    refresh(join(SCRIPTS, "txt2img.py"), TXT2IMG_SCRIPT);
    refresh(join(SCRIPTS, "img2mesh.py"), IMG2MESH_SCRIPT);
  }
}

export function localAssetsRoot(): string {
  return ROOT;
}
