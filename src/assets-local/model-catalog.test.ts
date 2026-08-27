import { describe, it, expect } from "vitest";
import {
  LOCAL_MODEL_CATALOG,
  supportedModels,
  defaultModelFor,
  getModelSpec,
  type DeviceCapability,
} from "./model-catalog.js";

const device16Mac: DeviceCapability = { totalRamGb: 16, appleSilicon: true };
const device32Mac: DeviceCapability = { totalRamGb: 32, appleSilicon: true };
const deviceLinux: DeviceCapability = { totalRamGb: 64, appleSilicon: false };

describe("model catalog device gating", () => {
  it("offers triposr + sd15 + sdxl on a 16GB Mac, and nothing CUDA/24GB", () => {
    const ids = supportedModels(device16Mac).map((m) => m.id);
    expect(ids).toContain("triposr");
    expect(ids).toContain("sd15");
    expect(ids).toContain("sdxl");
    expect(ids).not.toContain("trellis"); // CUDA-only
    expect(ids).not.toContain("hunyuan3d"); // CUDA-only
    expect(ids).not.toContain("flux-schnell"); // needs 24GB
  });

  it("still blocks CUDA-only models on a 32GB Mac but offers the 24GB flux", () => {
    const ids = supportedModels(device32Mac).map((m) => m.id);
    expect(ids).toContain("flux-schnell");
    expect(ids).not.toContain("trellis");
    expect(ids).not.toContain("hunyuan3d");
  });

  it("offers nothing off Apple Silicon (this catalog targets MPS)", () => {
    expect(supportedModels(deviceLinux)).toEqual([]);
  });

  it("picks the smallest supported model per kind as default", () => {
    expect(defaultModelFor("image-to-3d", device16Mac)?.id).toBe("triposr");
    expect(defaultModelFor("text-to-image", device16Mac)?.id).toBe("sd15");
    expect(defaultModelFor("text-to-image", device32Mac)?.id).toBe("sd15"); // still smallest first
  });

  it("documents why SDXL-Turbo is deliberately absent (non-commercial license)", () => {
    expect(getModelSpec("sdxl-turbo")).toBeUndefined();
    for (const m of LOCAL_MODEL_CATALOG) {
      expect(m.license).not.toContain("Non-Commercial");
    }
  });

  it("keeps every catalog entry license-clean for an open-source pipeline", () => {
    const allowed = ["MIT", "Apache-2.0", "OpenRAIL", "OpenRAIL++", "Tencent Hunyuan Community"];
    for (const m of LOCAL_MODEL_CATALOG) {
      expect(allowed, `${m.id} license ${m.license}`).toContain(m.license);
    }
  });
});
