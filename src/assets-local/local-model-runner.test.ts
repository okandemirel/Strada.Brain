import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { LocalModelRunner, RMBG_IMPORT_PROBE, RMBG_REPAIR_TIMEOUT_MS, type SpawnImpl } from "./local-model-runner.js";
import { getModelSpec, LOCAL_MODEL_CATALOG } from "./model-catalog.js";

function spawnOk(): { spawn: SpawnImpl; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn: SpawnImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "ok", stderr: "" };
  };
  return { spawn, calls };
}

function spawnFail(code = 1, stderr = "boom"): SpawnImpl {
  return async () => ({ code, stdout: "", stderr });
}

describe("LocalModelRunner", () => {
  let dir: string;
  // NEVER the real ~/.strada/assets-local: until 2026-09-17 these tests wrote
  // scripts and .installed-* markers into the user's real installation and
  // one of them deleted the real .installed-trellis marker on every full
  // suite run (audit 15 D1–D4). The runner reads the root at call time.
  const marker = (id: string): string => join(dir, `.installed-${id}`);
  // A throwaway HOME so "nothing outside the root was touched" is a real
  // assertion (Codex 2026-09-17: the sentinel check was vacuous), and the
  // previous override is restored rather than deleted (an inherited
  // STRADA_ASSETS_LOCAL_ROOT must survive the suite).
  let fakeHome: string;
  let prevRoot: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lmr-test-"));
    fakeHome = mkdtempSync(join(tmpdir(), "lmr-home-"));
    prevRoot = process.env["STRADA_ASSETS_LOCAL_ROOT"];
    prevHome = process.env["HOME"];
    process.env["STRADA_ASSETS_LOCAL_ROOT"] = dir;
    process.env["HOME"] = fakeHome;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env["STRADA_ASSETS_LOCAL_ROOT"];
    else process.env["STRADA_ASSETS_LOCAL_ROOT"] = prevRoot;
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("reports not-installed for a model id with no marker", () => {
    const runner = new LocalModelRunner(spawnOk().spawn);
    expect(runner.isModelInstalled("definitely-not-a-model")).toBe(false);
  });

  it("installs a pip model by creating the venv and running pip", async () => {
    const { spawn, calls } = spawnOk();
    const runner = new LocalModelRunner(spawn);
    const spec = getModelSpec("sd15")!;
    const result = await runner.install(spec);
    // In an isolated root the venv never exists, so the sequence is fixed:
    // venv → pip upgrade → pip install <packages> → marker. Every step is
    // asserted; a conditional `if (result.ok)` passed with zero assertions.
    expect(result.ok).toBe(true);
    const pipInstall = calls.find((c) => c.args.includes("install") && c.args.includes("torch"));
    expect(pipInstall).toBeDefined();
    expect(calls.some((c) => c.args.includes("venv"))).toBe(true);
    expect(existsSync(marker("sd15"))).toBe(true);
    // …and nothing was written under the (fake) home directory.
    expect(readdirSync(fakeHome)).toEqual([]);
  });

  it("writes markers under STRADA_ASSETS_LOCAL_ROOT, never under the home directory (2026-09-17)", async () => {
    const runner = new LocalModelRunner(spawnOk().spawn);
    await runner.install(getModelSpec("sd15")!);
    expect(existsSync(marker("sd15"))).toBe(true);
    expect(existsSync(join(dir, "scripts"))).toBe(true);
    expect(existsSync(join(homedir(), ".strada"))).toBe(false);
    expect(readdirSync(fakeHome)).toEqual([]);
  });

  it("surfaces pip failures instead of marking the model installed", async () => {
    // A venv that already exists takes the pip path, so the failure is pip's.
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(join(dir, "venv", "bin", "python3"), "#!/bin/sh\n");
    const runner = new LocalModelRunner(spawnFail(1, "resolution impossible"));
    expect(runner.venvReady()).toBe(true);
    expect(existsSync(marker("sd15"))).toBe(false);
    const result = await runner.install(getModelSpec("sd15")!);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("pip");
    // The marker must not appear (the old assertion compared a value to itself).
    expect(existsSync(marker("sd15"))).toBe(false);
  });

  it("a failed venv creation is an honest failure too", async () => {
    const runner = new LocalModelRunner(spawnFail(1, "no python3"));
    const result = await runner.install(getModelSpec("sd15")!);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("venv");
    expect(existsSync(marker("sd15"))).toBe(false);
  });

  it("refuses inference for a model that is not installed", async () => {
    const runner = new LocalModelRunner(spawnOk().spawn);
    const fresh = getModelSpec("trellis")!;
    // The isolated root has no marker; nothing is deleted from anywhere.
    const result = await runner.imageToMesh(fresh, join(dir, "in.png"), join(dir, "out.obj"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not installed");
  });
});

/**
 * Codex round AE#10, reproduced: `Hero.obj` already held `NOT AN OBJ AT ALL`
 * and the inference subprocess exited 0 without writing anything. The runner
 * checked only the exit code and the target path's existence, so the old
 * bytes were reported as a newly generated mesh.
 */
describe("a mesh must be newly produced geometry (Codex 2026-09-12 AE#10)", () => {
  const spec = { id: "trellis", label: "trellis", kind: "image-to-mesh", weightsRef: "w", installMethod: "hub" } as never;
  const OBJ = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

  const runnerWith = (spawn: SpawnImpl): LocalModelRunner => {
    const runner = new LocalModelRunner(spawn);
    (runner as unknown as { isModelInstalled: () => boolean }).isModelInstalled = () => true;
    (runner as unknown as { writeScripts: () => void }).writeScripts = () => {};
    return runner;
  };

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lmr-mesh-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("refuses when the inference wrote nothing, whatever was already there", async () => {
    const out = join(dir, "Hero.obj");
    writeFileSync(out, "NOT AN OBJ AT ALL");
    const runner = runnerWith(async () => ({ code: 0, stdout: "done", stderr: "" }));
    const result = await runner.imageToMesh(spec, join(dir, "in.png"), out);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("inference failed");
    // The old bytes are untouched — and still not a mesh anybody produced.
    expect(readFileSync(out, "utf8")).toBe("NOT AN OBJ AT ALL");
  });

  it("refuses bytes that are not geometry, and keeps the target untouched", async () => {
    const out = join(dir, "Hero.obj");
    writeFileSync(out, OBJ);
    const runner = runnerWith(async (_cmd, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, "# an empty scene\n");
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await runner.imageToMesh(spec, join(dir, "in.png"), out);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no usable geometry");
    expect(readFileSync(out, "utf8")).toBe(OBJ);
    expect(existsSync(out.replace(/\.obj$/, ".staging.obj"))).toBe(false);
  });

  it("refuses a vertex cloud and an empty file, and knows a glTF from a lie", async () => {
    // A mesh with no faces draws nothing in Unity, and an empty file is not
    // a mesh at all — both exited 0 and both were accepted.
    for (const [bytes, why] of [
      ["v 0 0 0\nv 1 0 0\nv 0 1 0\n", "vertices but no faces"],
      ["", "empty"],
      // `f rubbish` is not a face, and a file of it is not a mesh.
      ["v 0 0 0\nv 1 0 0\nv 0 1 0\nf rubbish\n", "vertices but no faces"],
    ] as const) {
      const out = join(dir, `Cloud-${why.length}.obj`);
      const runner = runnerWith(async (_cmd, args) => {
        writeFileSync(args[args.indexOf("--out") + 1]!, bytes);
        return { code: 0, stdout: "", stderr: "" };
      });
      const result = await runner.imageToMesh(spec, join(dir, "in.png"), out);
      expect(result.ok, why).toBe(false);
      expect(result.detail, why).toContain(why === "empty" ? "empty" : "vertices but no faces");
      expect(existsSync(out), why).toBe(false);
    }
    // …and a .glb is judged by its own magic, not by OBJ rules.
    const glb = join(dir, "Hero.glb");
    const good = runnerWith(async (_cmd, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, Buffer.concat([Buffer.from("glTF", "ascii"), Buffer.alloc(64, 1)]));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect((await good.imageToMesh(spec, join(dir, "in.png"), glb)).ok).toBe(true);
    const bad = runnerWith(async (_cmd, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, Buffer.alloc(64, 1));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect((await bad.imageToMesh(spec, join(dir, "Other.glb"), join(dir, "Other.glb"))).ok).toBe(false);
  });

  it("accepts an OBJ written the way exporters write them", async () => {
    // Leading-decimal coordinates and face indices with texture/normal parts
    // are ordinary OBJ, and both were being refused (Codex 2026-09-13 AF#10).
    const out = join(dir, "Decimals.obj");
    const runner = runnerWith(async (_cmd, args) => {
      writeFileSync(args[args.indexOf("--out") + 1]!, "v .1 .2 .3\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n");
      return { code: 0, stdout: "", stderr: "" };
    });
    expect((await runner.imageToMesh(spec, join(dir, "in.png"), out)).ok).toBe(true);
  });

  it("accepts a mesh the run actually produced", async () => {
    const out = join(dir, "Hero.obj");
    writeFileSync(out, "NOT AN OBJ AT ALL");
    const runner = runnerWith(async (_cmd, args) => {
      // The subprocess writes to the path IT was given, never to the target —
      // and that path keeps the target's EXTENSION, because the exporter
      // infers the format from it (Codex 2026-09-13 AF#10).
      const target = args[args.indexOf("--out") + 1]!;
      expect(target).not.toBe(out);
      expect(target.endsWith(".obj")).toBe(true);
      writeFileSync(target, OBJ);
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await runner.imageToMesh(spec, join(dir, "in.png"), out);
    expect(result.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(OBJ);
    expect(existsSync(out.replace(/\.obj$/, ".staging.obj"))).toBe(false);
  });
});

describe("inference runs one at a time", () => {
  // Measured 2026-09-07 15:38: two sprite calls in the same second, two
  // SD1.5 processes on one GPU.
  it("queues a second textToImage until the first spawn resolves", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const spawn: SpawnImpl = async (_cmd, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      order.push(`start ${out}`);
      if (out.endsWith("a.png")) await gate;
      order.push(`end ${out}`);
      return { code: 1, stdout: "", stderr: "stub" }; // failure is fine — ordering is the point
    };
    const runner = new LocalModelRunner(spawn);
    (runner as unknown as { isModelInstalled: () => boolean }).isModelInstalled = () => true;
    (runner as unknown as { writeScripts: () => void }).writeScripts = () => {};
    const spec = { id: "sd15", label: "sd15", kind: "text-to-image", weightsRef: "w", installMethod: "hub" } as never;
    const a = runner.textToImage(spec, "p", "/tmp/a.png");
    const b = runner.textToImage(spec, "p", "/tmp/b.png");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start /tmp/a.png"]); // b has not started
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start /tmp/a.png", "end /tmp/a.png", "start /tmp/b.png", "end /tmp/b.png"]);
  });

  // Review 2026-09-07: three runner defects, each reproduced first.
  it("imageToMesh goes through the same inference lock as the draws", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const spawn: SpawnImpl = async (_cmd, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      order.push(`start ${out}`);
      // The runner generates into a staging path beside the target (AE#10).
      if (out.startsWith("/tmp/a.staging")) await gate;
      order.push(`end ${out}`);
      return { code: 1, stdout: "", stderr: "stub" };
    };
    const runner = new LocalModelRunner(spawn);
    (runner as unknown as { isModelInstalled: () => boolean }).isModelInstalled = () => true;
    (runner as unknown as { writeScripts: () => void }).writeScripts = () => {};
    const spec = { id: "triposr", label: "TripoSR", kind: "image-to-3d", weightsRef: "w", installMethod: "hub" } as never;
    const a = runner.imageToMesh(spec, "/tmp/a.png", "/tmp/a.obj");
    const b = runner.imageToMesh(spec, "/tmp/b.png", "/tmp/b.obj");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start /tmp/a.staging.obj"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual([
      "start /tmp/a.staging.obj", "end /tmp/a.staging.obj",
      "start /tmp/b.staging.obj", "end /tmp/b.staging.obj",
    ]);
  });

  it("a batch counts only files the run produced, not outputs that already existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmr-review-"));
    const previous = process.env["STRADA_ASSETS_LOCAL_ROOT"];
    process.env["STRADA_ASSETS_LOCAL_ROOT"] = dir;
    try {
      const out = join(dir, "old.png");
      writeFileSync(out, "old bytes");
      const stale = new Date(Date.now() - 60_000);
      const { utimesSync } = await import("node:fs");
      utimesSync(out, stale, stale);
      const runner = new LocalModelRunner(spawnFail(1, "python exited 1"));
      (runner as unknown as { isModelInstalled: () => boolean }).isModelInstalled = () => true;
      (runner as unknown as { writeScripts: () => void }).writeScripts = () => {};
      const spec = { id: "sd15", label: "sd15", kind: "text-to-image", weightsRef: "w", installMethod: "hub" } as never;
      const r = await runner.textToImageBatch(spec, [{ prompt: "p", out }]);
      expect(r.ok).toBe(false);
      expect(r.written).toEqual([]);
      expect(r.missing).toEqual([out]);
    } finally {
      if (previous === undefined) delete process.env["STRADA_ASSETS_LOCAL_ROOT"];
      else process.env["STRADA_ASSETS_LOCAL_ROOT"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeScripts creates the scripts directory it writes into", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lmr-review-"));
    const previous = process.env["STRADA_ASSETS_LOCAL_ROOT"];
    process.env["STRADA_ASSETS_LOCAL_ROOT"] = join(dir, "fresh-root");
    try {
      const runner = new LocalModelRunner(spawnOk().spawn);
      (runner as unknown as { writeScripts: () => void }).writeScripts();
      expect(existsSync(join(dir, "fresh-root", "scripts", "txt2img.py"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["STRADA_ASSETS_LOCAL_ROOT"];
      else process.env["STRADA_ASSETS_LOCAL_ROOT"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Audit A3 / D55: an image-only install (sd15/sdxl/flux) carried no rembg
 * and no onnxruntime — they came in only through TripoSR's requirements —
 * so the sprite default (`--rmbg 1`) died at `from rembg import remove` and
 * the tool fell back to a placeholder without saying why.
 */
describe("background removal is installed, or repaired, or refused by name (audit A3 / D55)", () => {
  let dir: string;
  let fakeHome: string;
  let prevRoot: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lmr-rmbg-"));
    fakeHome = mkdtempSync(join(tmpdir(), "lmr-rmbg-home-"));
    prevRoot = process.env["STRADA_ASSETS_LOCAL_ROOT"];
    prevHome = process.env["HOME"];
    process.env["STRADA_ASSETS_LOCAL_ROOT"] = dir;
    process.env["HOME"] = fakeHome;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env["STRADA_ASSETS_LOCAL_ROOT"];
    else process.env["STRADA_ASSETS_LOCAL_ROOT"] = prevRoot;
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  /** An EXISTING marker-bearing install: venv python present, model marker written, no .rmbg-ready. */
  function existingInstall(modelId = "sd15"): void {
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(join(dir, "venv", "bin", "python3"), "");
    writeFileSync(join(dir, `.installed-${modelId}`), "2026-09-01\n");
  }
  const isProbe = (args: string[]): boolean => args[0] === "-c" && args[1] === RMBG_IMPORT_PROBE;
  const isPip = (args: string[]): boolean => args.includes("pip") && args.includes("install") && args.includes("rembg") && args.includes("onnxruntime");
  const isInference = (args: string[]): boolean => String(args[0]).endsWith("txt2img.py");
  /** A venv where the import fails until pip "installs" it (or never, when repairable=false). */
  function scriptedVenv(repairable: boolean): { spawn: SpawnImpl; seq: string[] } {
    const seq: string[] = [];
    let installed = false;
    const spawn: SpawnImpl = async (_cmd, args) => {
      if (isProbe(args)) { seq.push("probe"); return installed ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'rembg'" }; }
      if (isPip(args)) { seq.push("pip"); installed = repairable; return repairable ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: No matching distribution found for onnxruntime" }; }
      if (isInference(args)) {
        seq.push("infer");
        const out = args[args.indexOf("--out") + 1];
        if (out) writeFileSync(out, "png");
        const jobs = args[args.indexOf("--jobs") + 1];
        if (args.includes("--jobs") && jobs) for (const j of JSON.parse(readFileSync(jobs, "utf8")) as Array<{ out: string }>) writeFileSync(j.out, "png");
        return { code: 0, stdout: "WROTE", stderr: "" };
      }
      seq.push(`other:${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    };
    return { spawn, seq };
  }

  it("every text-to-image install carries rembg and onnxruntime", async () => {
    for (const spec of LOCAL_MODEL_CATALOG.filter((m) => m.kind === "text-to-image")) {
      expect(spec.pipPackages, spec.id).toContain("rembg");
      expect(spec.pipPackages, spec.id).toContain("onnxruntime");
    }
    // …and install(sd15) actually hands them to pip.
    const { spawn, calls } = spawnOk();
    await new LocalModelRunner(spawn).install(getModelSpec("sd15")!);
    const pipInstall = calls.find((c) => c.args.includes("install") && c.args.includes("torch"));
    expect(pipInstall!.args).toContain("rembg");
    expect(pipInstall!.args).toContain("onnxruntime");
  });

  it("an existing install without rembg is REPAIRED before the first --rmbg draw: probe, pip, probe, then inference", async () => {
    existingInstall();
    const { spawn, seq } = scriptedVenv(true);
    const runner = new LocalModelRunner(spawn);
    const out = join(dir, "hero.png");
    const r = await runner.textToImage(getModelSpec("sd15")!, "a hero", out, { removeBackground: true });
    expect(r.ok).toBe(true);
    expect(seq).toEqual(["probe", "pip", "probe", "infer"]);
    expect(existsSync(join(dir, ".rmbg-ready"))).toBe(true);
    // The measurement is cached: the next draw goes straight to inference.
    seq.length = 0;
    await runner.textToImage(getModelSpec("sd15")!, "a hero", out, { removeBackground: true });
    expect(seq).toEqual(["infer"]);
    expect(readdirSync(fakeHome)).toEqual([]);
  });

  it("when the repair fails the answer says background removal is unavailable and names the fix — no inference, no placeholder", async () => {
    existingInstall();
    const { spawn, seq } = scriptedVenv(false);
    const r = await new LocalModelRunner(spawn).textToImage(getModelSpec("sd15")!, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/background removal unavailable/);
    expect(r.detail).toMatch(/assets-local-setup/);
    expect(r.detail).toMatch(/keepBackground/);
    expect(seq).toEqual(["probe", "pip"]);
    expect(seq).not.toContain("infer");
    expect(existsSync(join(dir, ".rmbg-ready"))).toBe(false);
  });

  it("a failed repair is remembered per venv: the next call (even from a new runner) spawns nothing, until the venv changes (Codex 2026-09-17)", async () => {
    existingInstall();
    const { spawn, seq } = scriptedVenv(false);
    const spec = getModelSpec("sd15")!;
    const first = await new LocalModelRunner(spawn).textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(first.ok).toBe(false);
    expect(seq).toEqual(["probe", "pip"]);
    const second = await new LocalModelRunner(spawn).textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(second.ok).toBe(false);
    expect(second.detail).toMatch(/background removal unavailable/);
    expect(second.detail).toMatch(/already attempted/);
    expect(seq).toEqual(["probe", "pip"]); // pip once across both calls
    // Guard: a rebuilt venv (a different interpreter link) is tried afresh.
    rmSync(join(dir, "venv", "bin", "python3"));
    writeFileSync(join(dir, "venv", "bin", "python3"), "rebuilt");
    const t = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "venv", "bin", "python3"), t, t);
    const third = await new LocalModelRunner(spawn).textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(third.ok).toBe(false);
    expect(seq).toEqual(["probe", "pip", "probe", "pip"]);
  });

  it("the ready marker is bound to the venv: a rebuilt venv is probed again, and install() clears it (Codex 2026-09-17)", async () => {
    existingInstall();
    const spec = getModelSpec("sd15")!;
    const { spawn, seq } = scriptedVenv(true);
    const runner = new LocalModelRunner(spawn);
    await runner.textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(seq).toEqual(["probe", "pip", "probe", "infer"]);
    seq.length = 0;
    // Same venv: the measurement stands.
    await runner.textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(seq).toEqual(["infer"]);
    // The venv is rebuilt (a new interpreter link): the marker no longer applies.
    rmSync(join(dir, "venv", "bin", "python3"));
    writeFileSync(join(dir, "venv", "bin", "python3"), "rebuilt");
    const t = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "venv", "bin", "python3"), t, t);
    seq.length = 0;
    await runner.textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(seq[0]).toBe("probe");
    expect(seq[seq.length - 1]).toBe("infer");
    // install() changes the venv's packages: the marker is cleared before it starts.
    expect(existsSync(join(dir, ".rmbg-ready"))).toBe(true);
    const { spawn: okSpawn } = spawnOk();
    await new LocalModelRunner(okSpawn).install(spec);
    expect(existsSync(join(dir, ".rmbg-ready"))).toBe(false);
    seq.length = 0;
    await runner.textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(seq[0]).toBe("probe");
    // …and install() also forgets a remembered failure for this venv
    // (the successful call above re-wrote the marker; clear it first).
    await new LocalModelRunner(okSpawn).install(spec);
    const failing = scriptedVenv(false);
    const before = await new LocalModelRunner(failing.spawn).textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(before.ok).toBe(false);
    await new LocalModelRunner(okSpawn).install(spec);
    failing.seq.length = 0;
    await new LocalModelRunner(failing.spawn).textToImage(spec, "a hero", join(dir, "hero.png"), { removeBackground: true });
    expect(failing.seq).toEqual(["probe", "pip"]);
  });

  it("the batch path refuses the same way, with every job reported missing", async () => {
    existingInstall();
    const { spawn, seq } = scriptedVenv(false);
    const jobs = [{ prompt: "a", out: join(dir, "a.png") }, { prompt: "b", out: join(dir, "b.png") }];
    const r = await new LocalModelRunner(spawn).textToImageBatch(getModelSpec("sd15")!, jobs, { removeBackground: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/background removal unavailable/);
    expect(r.missing).toEqual(jobs.map((j) => j.out));
    expect(seq).not.toContain("infer");
  });

  it("a hung pip repair does not hold the inference lock: a keepBackground batch runs meanwhile, and the repair gives up at the bound (Codex 2026-09-17)", async () => {
    existingInstall();
    vi.useFakeTimers();
    try {
      const seq: string[] = [];
      let pipTimeout = -1;
      const spawn: SpawnImpl = (_cmd, args, opts) => {
        if (isProbe(args)) { seq.push("probe"); return Promise.resolve({ code: 1, stdout: "", stderr: "No module named 'rembg'" }); }
        if (isPip(args)) {
          // pip never returns on its own: only the spawn's own timeout ends it.
          seq.push("pip");
          pipTimeout = opts.timeoutMs;
          return new Promise((resolve) => setTimeout(() => resolve({ code: -1, stdout: "", stderr: `killed by timeout after ${opts.timeoutMs} ms` }), opts.timeoutMs));
        }
        if (isInference(args)) {
          seq.push("infer");
          const jobs = args[args.indexOf("--jobs") + 1];
          if (args.includes("--jobs") && jobs) for (const j of JSON.parse(readFileSync(jobs, "utf8")) as Array<{ out: string }>) writeFileSync(j.out, "png");
          return Promise.resolve({ code: 0, stdout: "WROTE", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      };
      const runner = new LocalModelRunner(spawn);
      const progress: string[] = [];
      const rmbg = runner.textToImage(getModelSpec("sd15")!, "a hero", join(dir, "hero.png"), { removeBackground: true, onProgress: (l) => progress.push(l) });
      let batchDone = false;
      const batch = runner
        .textToImageBatch(getModelSpec("sd15")!, [{ prompt: "a", out: join(dir, "a.png") }], { removeBackground: false })
        .then((r) => { batchDone = true; return r; });
      // Only microtasks pass — the pip is still hanging — and the batch is done.
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
      expect([...seq].sort()).toEqual(["infer", "pip", "probe"]);
      expect(batchDone).toBe(true);
      expect((await batch).ok).toBe(true);
      expect(progress.some((l) => /installing rembg onnxruntime/.test(l))).toBe(true);
      // The repair is bounded: at the bound it gives up with the named fix.
      expect(pipTimeout).toBe(RMBG_REPAIR_TIMEOUT_MS);
      expect(pipTimeout).toBeLessThanOrEqual(600_000);
      await vi.advanceTimersByTimeAsync(RMBG_REPAIR_TIMEOUT_MS);
      const r = await rmbg;
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/background removal unavailable/);
      expect(r.detail).toMatch(/killed by timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("guard: keepBackground (removeBackground false) never probes or installs anything and runs with --rmbg 0", async () => {
    existingInstall();
    const { spawn, seq } = scriptedVenv(false);
    const calls: string[][] = [];
    const recording: SpawnImpl = (cmd, args, opts) => { calls.push(args); return spawn(cmd, args, opts); };
    const runner = new LocalModelRunner(recording);
    const one = await runner.textToImage(getModelSpec("sd15")!, "a hero", join(dir, "hero.png"), { removeBackground: false });
    expect(one.ok).toBe(true);
    const batch = await runner.textToImageBatch(getModelSpec("sd15")!, [{ prompt: "a", out: join(dir, "a.png") }], { removeBackground: false });
    expect(batch.ok).toBe(true);
    expect(seq).toEqual(["infer", "infer"]);
    for (const args of calls) expect(args[args.indexOf("--rmbg") + 1]).toBe("0");
  });
});
