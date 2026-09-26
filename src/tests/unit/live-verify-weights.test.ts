/**
 * Live verify: local model weights (scripts/ci/live-verify-weights.mjs).
 *
 * The script's real run needs huggingface.co and a Python venv. What is tested
 * here is what decides what a run MEANS: the model choice, what the venv may
 * hold, the pin and adoption verdicts, the summary and exit code (a check that
 * did not run is never a pass), the private runner methods the script reaches
 * by name, the network guard, and — offline, against a cache laid out the way
 * huggingface_hub lays it out — the adoption process itself through the
 * compiled runner.
 *
 * The module is a .mjs script loaded through a non-literal specifier so the type
 * checker does not try to resolve a JavaScript file that has no declarations.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalModelRunner } from "../../assets-local/local-model-runner.js";
import { LOCAL_MODEL_CATALOG, type LocalModelSpec } from "../../assets-local/model-catalog.js";

type CheckState = "pass" | "fail" | "not-run";

interface Check {
  id: string;
  title: string;
  state: CheckState;
  detail?: string;
}

interface Lock {
  version: number;
  models: Record<string, { weightsRef: string; revision: string; recordedAt: string; origin?: string }>;
}

interface AdoptionReport {
  offline?: string;
  guardSelfTest?: Record<string, boolean>;
  attempts?: string[];
  outcome?: string;
  outcomeDetail?: string;
  readyAfter?: boolean;
  error?: string;
}

interface WeightsModule {
  WEIGHTS_CHECKS: Array<{ id: string; title: string }>;
  RUNNER_FETCH_METHODS: string[];
  smallestModel: (catalog: readonly Partial<LocalModelSpec>[]) => LocalModelSpec | undefined;
  fetchPackagesFor: (spec: Partial<LocalModelSpec>) => string[];
  evaluateDownloadPin: (lock: unknown, spec: LocalModelSpec) => { ok: boolean; detail: string; revision?: string };
  evaluateAdoption: (input: { spec: LocalModelSpec; downloaded: string; lock: unknown; child: AdoptionReport | undefined }) => { ok: boolean; detail: string };
  summarizeChecks: (checks: Check[]) => { passed: string[]; failed: string[]; notRun: string[]; verdict: string };
  exitCodeForChecks: (checks: Check[]) => number;
  formatWeightsReport: (checks: Check[], context?: { model?: string }) => string;
  formatWeightsStepSummary: (checks: Check[], context?: { model?: string }) => string;
  parseWeightsArgs: (argv: string[]) => { model: string | null; root: string | null; keep: boolean; phase: string | null };
  runnerFetch: (runnerClass: unknown) => unknown;
}

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "ci", "live-verify-weights.mjs");
const live = (await import(pathToFileURL(scriptPath).href)) as WeightsModule;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const spec = live.smallestModel(LOCAL_MODEL_CATALOG)!;

const checksIn = (states: CheckState[]): Check[] =>
  live.WEIGHTS_CHECKS.map((check, index) => ({ ...check, state: states[index]!, detail: `${check.id} detail` }));

const lockWith = (pin: Partial<Lock["models"][string]>): Lock => ({
  version: 1,
  models: { [spec.id]: { weightsRef: spec.weightsRef, revision: SHA, recordedAt: "2026-09-26T00:00:00.000Z", ...pin } },
});

const goodChild: AdoptionReport = {
  offline: "1",
  guardSelfTest: { fetch: true, "net.Socket.connect": true },
  attempts: [],
  outcome: "adopted",
  outcomeDetail: "from refs/main",
  readyAfter: true,
};

describe("live verify weights: what gets fetched, and into what", () => {
  it("picks the catalog model that costs least to fetch", () => {
    const least = Math.min(...LOCAL_MODEL_CATALOG.map((m) => m.diskGb));
    expect(spec.diskGb).toBe(least);
    // Ties go to less RAM, then catalog order.
    const tied = [
      { id: "a", diskGb: 5, minRamGb: 12 },
      { id: "b", diskGb: 5, minRamGb: 8 },
      { id: "c", diskGb: 5, minRamGb: 8 },
      { id: "d", diskGb: 9, minRamGb: 1 },
    ];
    expect(live.smallestModel(tied)?.id).toBe("b");
    expect(live.smallestModel([])).toBeUndefined();
  });

  it("installs only what the runner's fetch imports, never the inference stack", () => {
    for (const model of LOCAL_MODEL_CATALOG) {
      const packages = live.fetchPackagesFor(model);
      expect(packages.join(" "), model.id).not.toMatch(/torch|transformers|accelerate|rembg|onnxruntime/);
      if (model.weightFiles?.length) {
        // Named files go through hf_hub_download alone, on the hub client a real install resolves.
        expect(packages).toEqual(["huggingface_hub>=0.16.4,<1.0"]);
      } else {
        expect(packages).toEqual(["diffusers"]);
      }
    }
  });

  it("reaches the runner's private fetch by names that still exist on the class", () => {
    // Renaming fetchWeights/envWithWeights must fail here, not only in the manual run.
    expect(typeof live.runnerFetch(LocalModelRunner)).toBe("function");
    expect(() => live.runnerFetch(class Empty {})).toThrow(/fetchWeights\/envWithWeights/);
  });

  it("parses its flags, and refuses what it does not know", () => {
    expect(live.parseWeightsArgs(["--model", "sd15", "--keep"])).toMatchObject({ model: "sd15", keep: true, phase: null });
    expect(live.parseWeightsArgs(["--phase", "adopt"]).phase).toBe("adopt");
    expect(() => live.parseWeightsArgs(["--phase", "download"])).toThrow(/Unknown phase/);
    expect(() => live.parseWeightsArgs(["--model"])).toThrow(/Missing value/);
    expect(() => live.parseWeightsArgs(["--json", "x"])).toThrow(/Unknown argument/);
  });
});

describe("live verify weights: the pin and adoption verdicts", () => {
  it("accepts a download pin only as a full commit, from a download, for this repo", () => {
    expect(live.evaluateDownloadPin(lockWith({ origin: "download" }), spec)).toMatchObject({ ok: true, revision: SHA });
    expect(live.evaluateDownloadPin(lockWith({ origin: "download", revision: "main" }), spec).detail).toMatch(/not a 40-hex commit/);
    expect(live.evaluateDownloadPin(lockWith({ origin: "download", revision: SHA.slice(0, 12) }), spec).ok).toBe(false);
    expect(live.evaluateDownloadPin(lockWith({ origin: "disk" }), spec).detail).toMatch(/expected "download"/);
    expect(live.evaluateDownloadPin(lockWith({}), spec).ok).toBe(false);
    expect(live.evaluateDownloadPin(lockWith({ origin: "download", weightsRef: "someone/else" }), spec).detail).toMatch(/weightsRef/);
    expect(live.evaluateDownloadPin({ version: 1, models: {} }, spec).detail).toMatch(/no pin/);
    expect(live.evaluateDownloadPin({ version: 2, models: {} }, spec).ok).toBe(false);
  });

  it("accepts adoption only as the same commit, from disk, with no network or process attempt", () => {
    const adopt = (child: AdoptionReport | undefined, lock: unknown = lockWith({ origin: "disk" })) =>
      live.evaluateAdoption({ spec, downloaded: SHA, lock, child });
    expect(adopt(goodChild)).toMatchObject({ ok: true });
    expect(adopt(goodChild).detail).toContain("0 network/process attempts");
    const failures: Array<[AdoptionReport | undefined, unknown, RegExp]> = [
      [undefined, lockWith({ origin: "disk" }), /reported no result/],
      [{ ...goodChild, attempts: ["dns.lookup"] }, lockWith({ origin: "disk" }), /tried network or process access: dns\.lookup/],
      [{ ...goodChild, guardSelfTest: { fetch: false } }, lockWith({ origin: "disk" }), /guard let through: fetch/],
      [{ ...goodChild, guardSelfTest: {} }, lockWith({ origin: "disk" }), /self-test did not run/],
      [{ ...goodChild, offline: undefined }, lockWith({ origin: "disk" }), /HF_HUB_OFFLINE/],
      [{ ...goodChild, outcome: "ambiguous", outcomeDetail: "2 complete snapshots" }, lockWith({ origin: "disk" }), /"ambiguous" \(2 complete snapshots\)/],
      [goodChild, lockWith({ origin: "disk", revision: "f".repeat(40) }), /not the downloaded/],
      [goodChild, lockWith({ origin: "download" }), /expected "disk"/],
      [goodChild, { version: 1, models: {} }, /no pin after adoption/],
      [{ ...goodChild, readyAfter: false }, lockWith({ origin: "disk" }), /readiness check failed after adoption/],
    ];
    for (const [child, lock, reason] of failures) {
      const verdict = adopt(child, lock);
      expect(verdict.ok, String(reason)).toBe(false);
      expect(verdict.detail).toMatch(reason);
    }
  });
});

describe("live verify weights: summary and exit code", () => {
  it("passes only when all six checks passed", () => {
    const checks = checksIn(["pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(live.summarizeChecks(checks).verdict).toBe("PASS: 6/6 checks");
    expect(live.exitCodeForChecks(checks)).toBe(0);
    expect(live.formatWeightsStepSummary(checks, { model: "triposr" })).toContain("### Live verify: local weights — PASS: 6/6 checks");
  });

  it("fails on a failed check and names the checks that never ran after it", () => {
    const checks = checksIn(["pass", "pass", "fail", "not-run", "not-run", "not-run"]);
    const summary = live.summarizeChecks(checks);
    expect(summary.verdict).toBe("FAILED: download (not run after it: pin, readiness, adoption)");
    expect(live.exitCodeForChecks(checks)).toBe(1);
    expect(live.formatWeightsReport(checks)).toContain("Verdict: FAILED: download");
  });

  it("never reports an unrun check as a pass, even with no failure", () => {
    const checks = checksIn(["pass", "pass", "pass", "pass", "pass", "not-run"]);
    expect(live.exitCodeForChecks(checks)).toBe(3);
    expect(live.summarizeChecks(checks).verdict).toBe("NOT RUN: adoption");
    expect(live.formatWeightsStepSummary(checks)).not.toMatch(/PASS: \d/);
  });

  it("keeps a detail with a pipe from breaking the summary table", () => {
    const checks = checksIn(["fail", "not-run", "not-run", "not-run", "not-run", "not-run"]);
    checks[0]!.detail = "a | b\nc";
    expect(live.formatWeightsStepSummary(checks)).toContain("| a \\| b c |");
  });
});

/* ------------------------------------------------------------------------- *
 * Subprocesses: the guard, and the adoption phase through dist/.
 * ------------------------------------------------------------------------- */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("live verify weights: the network guard", () => {
  it("blocks and records every network and process route, including an ESM import of child_process", () => {
    // In its own process: the guard replaces globals for good.
    const code = [
      `const m = await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
      "const guard = m.installNetworkGuard();",
      "const selfTest = await guard.selfTest();",
      "const after = [];",
      "try { await fetch('http://127.0.0.1:9/'); } catch (e) { after.push(e.message); }",
      "try { (await import('node:child_process')).execFileSync('true'); } catch (e) { after.push(e.message); }",
      "console.log(JSON.stringify({ selfTest, attempts: guard.attempts, after }));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout.trim().split("\n").pop()!) as { selfTest: Record<string, boolean>; attempts: string[]; after: string[] };
    expect(Object.keys(report.selfTest).length).toBeGreaterThanOrEqual(5);
    expect(Object.values(report.selfTest).every(Boolean), JSON.stringify(report.selfTest)).toBe(true);
    // The self-test's own probes are not counted; what came after is.
    expect(report.attempts).toEqual(["fetch", "child_process.execFileSync"]);
    expect(report.after.every((message) => message.startsWith("blocked by the live-verify network guard"))).toBe(true);
  });
});

describe("live verify weights: offline adoption through the compiled runner", () => {
  it("re-pins the cached commit from disk under HF_HUB_OFFLINE=1, with no network or process attempt", () => {
    const runnerJs = path.join(repoRoot, "dist", "assets-local", "local-model-runner.js");
    // FAILS rather than skips without dist/, like the backup.sh test: CI builds
    // before it tests, and a skip would hide a reordered workflow.
    expect(fs.existsSync(runnerJs), `${runnerJs} is missing: run \`npm run build\` before this test`).toBe(true);

    // An install whose weights were cached before the lock existed: the
    // snapshot huggingface_hub writes, refs/main naming it, no models.lock.json.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "strada-live-weights-test-"));
    temps.push(root);
    const repo = path.join(root, "weights", "hub", `models--${spec.weightsRef.split("/").join("--")}`);
    const snapshot = path.join(repo, "snapshots", SHA);
    for (const name of spec.weightFiles ?? ["unet/diffusion_pytorch_model.safetensors"]) {
      fs.mkdirSync(path.dirname(path.join(snapshot, name)), { recursive: true });
      fs.writeFileSync(path.join(snapshot, name), "weights\n");
    }
    fs.mkdirSync(path.join(repo, "refs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "refs", "main"), SHA);

    const run = spawnSync(process.execPath, [scriptPath, "--phase", "adopt", "--model", spec.id], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, STRADA_ASSETS_LOCAL_ROOT: root, HF_HUB_OFFLINE: "1" },
    });
    expect(run.status, run.stderr).toBe(0);
    const line = run.stdout.split("\n").find((entry) => entry.startsWith("LIVE_VERIFY_ADOPT_RESULT "));
    expect(line, run.stdout + run.stderr).toBeDefined();
    const child = JSON.parse(line!.slice("LIVE_VERIFY_ADOPT_RESULT ".length)) as AdoptionReport;
    const lock = JSON.parse(fs.readFileSync(path.join(root, "models.lock.json"), "utf8")) as Lock;
    const verdict = live.evaluateAdoption({ spec, downloaded: SHA, lock, child });
    expect(verdict, JSON.stringify(child)).toMatchObject({ ok: true });
    expect(lock.models[spec.id]).toMatchObject({ revision: SHA, origin: "disk", weightsRef: spec.weightsRef });
  });
});
