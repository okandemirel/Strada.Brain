/**
 * Local asset-generation model catalog — the menu of open-weights models a
 * user can install, gated by what their device can actually run.
 *
 * Product decision (2026-08-27): open-source users must never NEED a paid
 * API. The catalog lists free, openly-licensed models with their measured
 * requirements; setup offers only what the device supports (plus every
 * smaller model), and the procedural generators stay the always-works floor.
 *
 * License note, deliberate: SDXL-Turbo is NOT in the catalog — Stability
 * ships it under a non-commercial license, which does not belong in an
 * open-source pipeline. SDXL 1.0 base is OpenRAIL++-M (commercial use
 * allowed with restrictions), FLUX.1-schnell is Apache-2.0, TripoSR is MIT,
 * SD 1.5 is OpenRAIL.
 *
 * Item 2.15 (2026-09-17): TRELLIS and Hunyuan3D were removed. They were
 * flagged `requiresCuda`, nothing in this codebase ever probed for CUDA, the
 * device filter could not offer them on any platform, and the runner's only
 * image-to-3d driver is TripoSR's. A menu entry nothing can install or run is
 * a promise the product cannot keep.
 */

import { totalmem } from "node:os";

// =============================================================================
// TYPES
// =============================================================================

export type LocalModelKind = "image-to-3d" | "text-to-image";

export interface LocalModelSpec {
  readonly id: string;
  readonly kind: LocalModelKind;
  readonly label: string;
  /** One-line "what it's good at" for the setup menu. */
  readonly blurb: string;
  /** SPDX-style license tag shown to the user. */
  readonly license: string;
  /** Minimum free RAM (GB) measured to load + run without swapping. */
  readonly minRamGb: number;
  /** Disk the venv packages + weights take (GB, informational). */
  readonly diskGb: number;
  /** pip requirements installed into the model venv. */
  readonly pipPackages: readonly string[];
  /**
   * "repo" = the model ships as a source repo, not a pip package (TripoSR has
   * no pyproject.toml at root — measured on install 2026-08-27). The runner
   * clones it and installs its requirements.txt instead.
   */
  readonly installMethod?: "pip" | "repo";
  readonly repoUrl?: string;
  /** Path to the requirements file inside the cloned repo. */
  readonly repoRequirements?: string;
  /** HF repo the runner pulls weights from at INSTALL time (item 2.15). */
  readonly weightsRef: string;
  /** Relative speed on Apple Silicon (menu hint). */
  readonly speedHint: "fast" | "medium" | "slow";
  /**
   * The weight file(s) the inference driver loads BY NAME, when it loads named
   * files rather than a whole pipeline folder (TripoSR:
   * `TSR.from_pretrained(..., config_name="config.yaml", weight_name="model.ckpt")`).
   * The runner fetches exactly these at install time and requires them on disk
   * before it will call the model installed (item 2.15). Absent = the model
   * ships as a diffusers pipeline folder and the whole folder is fetched.
   */
  readonly weightFiles?: readonly string[];
}

export interface DeviceCapability {
  readonly totalRamGb: number;
  /** Apple Silicon (MPS) — the local-inference path this catalog targets. */
  readonly appleSilicon: boolean;
}

export function probeDevice(): DeviceCapability {
  return {
    totalRamGb: Math.round(totalmem() / 1024 ** 3),
    appleSilicon: process.platform === "darwin" && process.arch === "arm64",
  };
}

// =============================================================================
// CATALOG
// =============================================================================

/**
 * What every text-to-image install needs so `--rmbg` (the sprite default)
 * can run: rembg cuts the subject out, onnxruntime is its undeclared runtime
 * dependency (measured: ModuleNotFoundError). Audit A3 / D55: an image-only
 * install carried neither, so the first sprite draw died at
 * `from rembg import remove` and the tool fell back to a placeholder.
 */
export const BACKGROUND_REMOVAL_PACKAGES: readonly string[] = ["rembg", "onnxruntime"];

export const LOCAL_MODEL_CATALOG: readonly LocalModelSpec[] = [
  // ---- 3D (image → mesh) ----
  {
    id: "triposr",
    kind: "image-to-3d",
    label: "TripoSR — image to 3D mesh",
    blurb: "Seconds per mesh from a single image; the casual-prop workhorse.",
    license: "MIT",
    minRamGb: 8,
    diskGb: 5,
    pipPackages: [],
    weightsRef: "stabilityai/TripoSR",
    // Exactly what img2mesh.py asks TSR.from_pretrained for.
    weightFiles: ["config.yaml", "model.ckpt"],
    speedHint: "fast",
    installMethod: "repo",
    repoUrl: "https://github.com/VAST-AI-Research/TripoSR.git",
    repoRequirements: "requirements.txt",
  },
  // ---- 2D (text → image) ----
  {
    id: "sd15",
    kind: "text-to-image",
    label: "Stable Diffusion 1.5 — light sprite/art generator",
    blurb: "Fast on small machines; pixel-art LoRAs galore.",
    license: "OpenRAIL",
    minRamGb: 8,
    diskGb: 6,
    pipPackages: ["torch", "diffusers", "transformers", "accelerate", "safetensors", ...BACKGROUND_REMOVAL_PACKAGES],
    weightsRef: "stable-diffusion-v1-5/stable-diffusion-v1-5",
    speedHint: "fast",
  },
  {
    id: "sdxl",
    kind: "text-to-image",
    label: "SDXL 1.0 — sharper 2D art",
    blurb: "Cleaner shapes and color than SD1.5, about 3× the cost per image.",
    license: "OpenRAIL++",
    minRamGb: 12,
    diskGb: 9,
    pipPackages: ["torch", "diffusers", "transformers", "accelerate", "safetensors", ...BACKGROUND_REMOVAL_PACKAGES],
    weightsRef: "stabilityai/stable-diffusion-xl-base-1.0",
    speedHint: "medium",
  },
  {
    id: "flux-schnell",
    kind: "text-to-image",
    label: "FLUX.1 schnell — best free 2D quality",
    blurb: "Apache-2.0 flagship; the best license-clean art you can run locally.",
    license: "Apache-2.0",
    minRamGb: 24,
    diskGb: 24,
    pipPackages: ["torch", "diffusers", "transformers", "accelerate", "safetensors", "sentencepiece", ...BACKGROUND_REMOVAL_PACKAGES],
    weightsRef: "black-forest-labs/FLUX.1-schnell",
    speedHint: "slow",
  },
];

export function getModelSpec(id: string): LocalModelSpec | undefined {
  return LOCAL_MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * What this device may install: every model whose RAM bar clears, smallest
 * first. Apple Silicon is required for all of them (the MPS backend); on
 * anything else the menu is empty and the cloud/procedural tiers take over.
 *
 * Item 2.15: this filter used to also exclude `requiresCuda` rows on Apple
 * Silicon while offering nothing whatsoever off it — so the two CUDA-only
 * entries (TRELLIS, Hunyuan3D) could not be reached on ANY device, no code
 * ever probed for CUDA, and the only image-to-3d driver the runner ships
 * loads TripoSR's `tsr.system`. They were removed rather than given a
 * probe: an honest menu lists what this runner can actually drive.
 */
export function supportedModels(device: DeviceCapability = probeDevice()): LocalModelSpec[] {
  if (!device.appleSilicon) return [];
  return LOCAL_MODEL_CATALOG
    .filter((m) => device.totalRamGb >= m.minRamGb)
    .sort((a, b) => a.minRamGb - b.minRamGb);
}

/** The catalog annotated for the setup menu. */
export function catalogForDevice(device: DeviceCapability = probeDevice()): Array<LocalModelSpec & { supported: boolean }> {
  const supported = new Set(supportedModels(device).map((m) => m.id));
  return LOCAL_MODEL_CATALOG.map((m) => ({ ...m, supported: supported.has(m.id) }));
}

/** Default picks per kind: the smallest supported model of that kind. */
export function defaultModelFor(kind: LocalModelKind, device: DeviceCapability = probeDevice()): LocalModelSpec | undefined {
  return supportedModels(device).find((m) => m.kind === kind);
}

/**
 * The model a generation tool actually runs for a kind: the first supported
 * model of that kind (smallest first) that `isInstalled` reports installed.
 * Only when NONE is installed does this fall back to the smallest supported
 * one, so the "not installed" message still names a model the device can run.
 *
 * Audit A2 / D54 (Codex #13): AUTO selection asked `defaultModelFor` and then
 * checked whether THAT one was installed — a machine with only sdxl installed
 * answered "no local model" and every AUTO sprite went procedural, while
 * 9 GB of installed weights sat idle.
 */
export function installedModelFor(
  kind: LocalModelKind,
  isInstalled: (modelId: string) => boolean,
  device: DeviceCapability = probeDevice(),
): LocalModelSpec | undefined {
  const candidates = supportedModels(device).filter((m) => m.kind === kind);
  return candidates.find((m) => isInstalled(m.id)) ?? candidates[0];
}
