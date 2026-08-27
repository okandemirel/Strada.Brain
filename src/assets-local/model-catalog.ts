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
  /** HF repo or URL the runner pulls weights from at first run. */
  readonly weightsRef: string;
  /** Relative speed on Apple Silicon (menu hint). */
  readonly speedHint: "fast" | "medium" | "slow";
  /**
   * Requires CUDA-only kernels (custom ops compiled for NVIDIA). TRELLIS and
   * Hunyuan3D ship CUDA-tuned ops that do not run on Apple Silicon's MPS —
   * they stay on the menu for CUDA machines but are never offered on Mac.
   */
  readonly requiresCuda?: boolean;
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
    speedHint: "fast",
    installMethod: "repo",
    repoUrl: "https://github.com/VAST-AI-Research/TripoSR.git",
    repoRequirements: "requirements.txt",
  },
  {
    id: "trellis",
    kind: "image-to-3d",
    label: "TRELLIS — higher-quality image to 3D",
    blurb: "Better geometry and texture than TripoSR, heavier and slower.",
    license: "MIT",
    minRamGb: 16,
    diskGb: 12,
    pipPackages: ["torch", "torchvision", "trellis"],
    weightsRef: "microsoft/TRELLIS-image-large",
    speedHint: "slow",
    requiresCuda: true,
  },
  {
    id: "hunyuan3d",
    kind: "image-to-3d",
    label: "Hunyuan3D 2 — text/image to textured 3D",
    blurb: "The open-weights ceiling: textured meshes with PBR maps.",
    license: "Tencent Hunyuan Community",
    minRamGb: 24,
    diskGb: 20,
    pipPackages: ["torch", "torchvision", "hunyuan3d"],
    weightsRef: "tencent/Hunyuan3D-2",
    speedHint: "slow",
    requiresCuda: true,
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
    pipPackages: ["torch", "diffusers", "transformers", "accelerate", "safetensors"],
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
    pipPackages: ["torch", "diffusers", "transformers", "accelerate", "safetensors"],
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
    pipPackages: ["torch", "diffusers", "transformers", "accelerate", "safetensors", "sentencepiece"],
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
 */
export function supportedModels(device: DeviceCapability = probeDevice()): LocalModelSpec[] {
  return LOCAL_MODEL_CATALOG
    .filter((m) => device.totalRamGb >= m.minRamGb)
    // CUDA-only models are never offered on Apple Silicon; on non-Apple
    // machines nothing is offered at all (this catalog targets MPS).
    .filter((m) => (device.appleSilicon && !m.requiresCuda) || (!device.appleSilicon && false))
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
