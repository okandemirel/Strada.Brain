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
    // Tencent Hunyuan Community left with the Hunyuan3D row (item 2.15): it is
    // not an open license and no row needs it any more.
    const allowed = ["MIT", "Apache-2.0", "OpenRAIL", "OpenRAIL++"];
    for (const m of LOCAL_MODEL_CATALOG) {
      expect(allowed, `${m.id} license ${m.license}`).toContain(m.license);
    }
  });
});

// =============================================================================
// ITEM 2.15 — no row may advertise a backend nothing probes for.
//
// The catalogue carried trellis and hunyuan3d with `requiresCuda: true`.
// Nothing in the codebase ever probed for CUDA: `supportedModels` excluded
// them on Apple Silicon and returned NOTHING at all off Apple Silicon, so the
// two rows could not be offered on ANY device — and the only image-to-3d
// driver the runner ships loads TripoSR's `tsr.system`, so neither model had
// an inference path even if it had been installed.
// =============================================================================

describe("the catalogue only advertises what this code can verify (item 2.15)", () => {
  it("carries no CUDA-gated row and no requiresCuda flag", () => {
    for (const m of LOCAL_MODEL_CATALOG) {
      expect(Object.keys(m), `${m.id} still carries a device flag nothing probes`).not.toContain("requiresCuda");
    }
    expect(getModelSpec("trellis")).toBeUndefined();
    expect(getModelSpec("hunyuan3d")).toBeUndefined();
  });

  it("every row is offerable on some real device (no dead menu entries)", () => {
    // The most capable machine this catalogue targets. A row that even this
    // device is never offered is advertising, not a menu entry.
    const biggestMac: DeviceCapability = { totalRamGb: 1024, appleSilicon: true };
    const offered = supportedModels(biggestMac).map((m) => m.id);
    for (const m of LOCAL_MODEL_CATALOG) {
      expect(offered, `${m.id} can never be offered on any device`).toContain(m.id);
    }
  });

  it("every row names the license of an open pipeline and a kind the runner can drive", () => {
    for (const m of LOCAL_MODEL_CATALOG) {
      expect(["image-to-3d", "text-to-image"]).toContain(m.kind);
      expect(m.weightsRef).toMatch(/^[^/]+\/[^/]+$/);
    }
  });
});
