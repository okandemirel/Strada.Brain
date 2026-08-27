/**
 * `strada assets-local-setup` — the menu of free, open-weights generation
 * models, gated by what this device can run (product decision 2026-08-27:
 * nobody should ever NEED a paid API; the supported models here are the free
 * tier, the cloud providers stay an optional ceiling).
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  catalogForDevice,
  getModelSpec,
  probeDevice,
  supportedModels,
} from "../assets-local/model-catalog.js";
import { LocalModelRunner } from "../assets-local/local-model-runner.js";

export interface AssetsLocalSetupOptions {
  model?: string;
  allSupported?: boolean;
  /** Test seam: skip the interactive prompt. */
  nonInteractive?: boolean;
}

export async function runAssetsLocalSetup(options: AssetsLocalSetupOptions = {}): Promise<number> {
  const device = probeDevice();
  const runner = new LocalModelRunner();
  const catalog = catalogForDevice(device);

  console.log(`Device: ${device.totalRamGb} GB RAM, ${device.appleSilicon ? "Apple Silicon (MPS)" : "not Apple Silicon"}`);
  if (!device.appleSilicon) {
    console.log("Local generation on this catalog targets Apple Silicon (MPS). The procedural generators and owned packages still work everywhere.");
    return 1;
  }
  console.log("");
  console.log("Model catalog (free, open-weights):");
  for (const m of catalog) {
    const mark = m.supported ? "✓" : "✗";
    const installed = runner.isModelInstalled(m.id) ? " [installed]" : "";
    const why = m.supported ? "" : m.requiresCuda ? "  (needs CUDA)" : `  (needs ≥${m.minRamGb} GB RAM)`;
    console.log(`  ${mark} ${m.id.padEnd(13)} ${m.kind.padEnd(13)} ${m.license.padEnd(14)} ${m.blurb}${why}${installed}`);
  }
  console.log("");

  const supported = supportedModels(device);
  if (supported.length === 0) {
    console.log("No model fits this device. The procedural generators remain your floor.");
    return 1;
  }

  let toInstall = options.allSupported ? supported.map((m) => m.id) : [];
  if (options.model) {
    const spec = getModelSpec(options.model);
    if (!spec) {
      console.error(`Unknown model '${options.model}'. Choose from: ${catalog.map((m) => m.id).join(", ")}`);
      return 1;
    }
    if (!supported.some((m) => m.id === spec.id)) {
      console.error(`'${spec.id}' is not supported on this device (needs ≥${spec.minRamGb} GB RAM${spec.requiresCuda ? " + CUDA" : ""}).`);
      return 1;
    }
    toInstall = [spec.id];
  }

  if (toInstall.length === 0) {
    if (options.nonInteractive) {
      console.log("Nothing to do. Pass --model <id> or --all-supported.");
      return 0;
    }
    console.log("Which model should be installed? (smallest first is usually right)");
    supported.forEach((m, i) => console.log(`  ${i + 1}) ${m.id} — ${m.blurb}`));
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`Pick 1-${supported.length} (or a model id, empty to skip): `)).trim();
    rl.close();
    if (!answer) {
      console.log("Skipped. The procedural generators remain your floor.");
      return 0;
    }
    const picked = /^\d+$/.test(answer) ? supported[Number(answer) - 1] : supported.find((m) => m.id === answer);
    if (!picked) {
      console.error(`'${answer}' is not on the supported list.`);
      return 1;
    }
    toInstall = [picked.id];
  }

  let failures = 0;
  for (const id of toInstall) {
    const spec = getModelSpec(id)!;
    console.log(`\nInstalling ${spec.label} (~${spec.diskGb} GB)…`);
    const result = await runner.install(spec, (line) => console.log(`  ${line}`));
    if (result.ok) {
      console.log(`  ✓ ${result.detail}`);
    } else {
      console.error(`  ✗ ${result.detail}`);
      failures += 1;
    }
  }
  return failures > 0 ? 1 : 0;
}
