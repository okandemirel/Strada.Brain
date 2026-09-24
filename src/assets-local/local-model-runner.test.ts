import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  LocalModelRunner,
  RMBG_IMPORT_PROBE,
  RMBG_REPAIR_TIMEOUT_MS,
  hfWeightsDir,
  modelSubprocessEnv,
  modelWeightsPresent,
  type SpawnImpl,
} from "./local-model-runner.js";
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

  it("reports a repo install that throws as a failed install instead of rejecting", async () => {
    // spawnOk "clones" nothing, so reading the repo's requirements file throws
    // inside installFromRepo; install() must still answer { ok: false }.
    const runner = new LocalModelRunner(spawnOk().spawn);
    const result = await runner.install(getModelSpec("triposr")!);
    expect(result.ok).toBe(false);
    expect(existsSync(marker("triposr"))).toBe(false);
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
    const fresh = getModelSpec("triposr")!;
    // The isolated root has no marker; nothing is deleted from anywhere.
    const result = await runner.imageToMesh(fresh, join(dir, "in.png"), join(dir, "out.obj"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not installed");
  });

  it("no model subprocess (venv, pip, git clone, python) sees this process's secrets (CMP-10)", async () => {
    const planted: Record<string, string> = {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      TELEGRAM_BOT_TOKEN: "123:secret",
      DISCORD_BOT_TOKEN: "discord-secret",
      GITHUB_TOKEN: "ghp_secret",
      // The shell tool's operator passthrough is for builds, not for model code.
      SHELL_EXEC_ENV_PASSTHROUGH: "GITHUB_TOKEN",
      HF_TOKEN: "hf_needed_for_gated_weights",
      PIP_INDEX_URL: "https://pypi.example/simple",
    };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    const seen: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const spawn: SpawnImpl = async (cmd, args, opts) => {
      seen.push({ cmd, args, env: opts.env });
      if (cmd === "git" && args[0] === "clone") {
        // What a clone leaves behind, so the install carries on to pip.
        const repoDir = args[args.length - 1]!;
        mkdirSync(join(repoDir, "tsr"), { recursive: true });
        writeFileSync(join(repoDir, "requirements.txt"), "numpy\n");
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    try {
      const runner = new LocalModelRunner(spawn);
      await runner.install(getModelSpec("sd15")!);
      await runner.install(getModelSpec("triposr")!); // the repo path: git clone, then pip
      expect(seen.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(true);
      expect(seen.some((c) => c.args.includes("venv"))).toBe(true);
      expect(seen.some((c) => c.args.includes("-r"))).toBe(true); // the unpinned requirements
      for (const call of seen) {
        const what = `${call.cmd} ${call.args.slice(0, 3).join(" ")}`;
        // An absent env is NOT safe: execFile would inherit everything.
        expect(call.env, what).toBeDefined();
        for (const secret of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "GITHUB_TOKEN", "SHELL_EXEC_ENV_PASSTHROUGH"]) {
          expect(call.env?.[secret], `${what}: ${secret}`).toBeUndefined();
        }
        expect(call.env?.["HOME"], what).toBe(fakeHome);
        expect(call.env?.["HF_HOME"], what).toBe(join(dir, "weights"));
        expect(call.env?.["HF_TOKEN"], what).toBe("hf_needed_for_gated_weights");
        expect(call.env?.["PIP_INDEX_URL"], what).toBe("https://pypi.example/simple");
        if (process.env["PATH"] !== undefined) expect(call.env?.["PATH"], what).toBe(process.env["PATH"]);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("modelSubprocessEnv (CMP-10)", () => {
  it("keeps the basics a subprocess needs and withholds everything secret-looking", () => {
    const env = modelSubprocessEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        HTTPS_PROXY: "http://proxy:3128",
        SSL_CERT_FILE: "/etc/ca.pem",
        PYTORCH_ENABLE_MPS_FALLBACK: "1",
        OPENAI_API_KEY: "sk-secret",
        SLACK_BOT_TOKEN: "xoxb-secret",
        NODE_OPTIONS: "--require /tmp/x.js",
      },
      { HF_HOME: "/w" },
      "linux",
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin", HOME: "/home/u", TMPDIR: "/tmp", LANG: "C.UTF-8", HTTPS_PROXY: "http://proxy:3128",
      SSL_CERT_FILE: "/etc/ca.pem", PYTORCH_ENABLE_MPS_FALLBACK: "1", HF_HOME: "/w",
    });
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["SLACK_BOT_TOKEN"]).toBeUndefined();
    expect(env["NODE_OPTIONS"]).toBeUndefined();
  });

  it("matches the Windows basics the way Windows spells them", () => {
    const env = modelSubprocessEnv(
      { Path: "C:\\Windows", SYSTEMROOT: "C:\\Windows", ComSpec: "cmd.exe", USERPROFILE: "C:\\Users\\u", TEMP: "C:\\t", OPENAI_API_KEY: "sk" },
      {},
      "win32",
    );
    expect(env).toMatchObject({ Path: "C:\\Windows", SYSTEMROOT: "C:\\Windows", ComSpec: "cmd.exe", USERPROFILE: "C:\\Users\\u", TEMP: "C:\\t" });
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });
});

/**
 * Codex round AE#10, reproduced: `Hero.obj` already held `NOT AN OBJ AT ALL`
 * and the inference subprocess exited 0 without writing anything. The runner
 * checked only the exit code and the target path's existence, so the old
 * bytes were reported as a newly generated mesh.
 */
describe("a mesh must be newly produced geometry (Codex 2026-09-12 AE#10)", () => {
  // A hand-built spec: this suite stubs isModelInstalled, so the id need not be
  // a catalogue row (trellis was removed in item 2.15).
  const spec = { id: "mesh-model", label: "mesh-model", kind: "image-to-mesh", weightsRef: "org/mesh-model", installMethod: "hub" } as never;
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

  /**
   * An EXISTING complete install: venv python, the model marker, the cloned
   * source for a repo-shipped model and the cached weights — everything
   * isModelInstalled measures (item 2.15) — but no .rmbg-ready, which is what
   * these tests are about.
   */
  function existingInstall(modelId = "sd15"): void {
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(join(dir, "venv", "bin", "python3"), "");
    writeFileSync(join(dir, `.installed-${modelId}`), "2026-09-01\n");
    const spec = getModelSpec(modelId)!;
    if (spec.installMethod === "repo") {
      mkdirSync(join(dir, "src", modelId, "tsr"), { recursive: true });
      writeFileSync(join(dir, "src", modelId, "tsr", "system.py"), "# TSR\n");
    }
    for (const f of spec.weightFiles ?? ["unet/diffusion_pytorch_model.safetensors"]) {
      const path = join(hfWeightsDir(spec.weightsRef), "snapshots", "rev1", f);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "weight-bytes");
    }
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

// =============================================================================
// ITEM 2.15 — "installed" must mean the weights are on disk, not that a marker
// file exists. A deleted or half-downloaded model read as installed, the tool
// picked the local path, the inference died inside python and the sprint got a
// placeholder with no idea why.
// =============================================================================

describe("isModelInstalled measures the weights, not just the marker (item 2.15)", () => {
  let dir: string;
  let prevRoot: string | undefined;
  let prevHome: string | undefined;
  let fakeHome: string;

  const venv = (): void => {
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(join(dir, "venv", "bin", "python3"), "#!/bin/sh\n");
  };
  const marker = (id: string, body = "2026-09-17\n"): void => {
    writeFileSync(join(dir, `.installed-${id}`), body);
  };
  /** A file inside the HF cache directory for this model's weights ref. */
  const weightFile = (id: string, rel: string, body: string): void => {
    const spec = getModelSpec(id)!;
    const path = join(hfWeightsDir(spec.weightsRef), rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  /** What a complete install of this model looks like on disk. */
  const fullyInstall = (id: string): void => {
    venv();
    marker(id);
    const spec = getModelSpec(id)!;
    if (spec.installMethod === "repo") {
      mkdirSync(join(dir, "src", id, "tsr"), { recursive: true });
      writeFileSync(join(dir, "src", id, "tsr", "system.py"), "# TSR\n");
    }
    for (const f of spec.weightFiles ?? ["unet/diffusion_pytorch_model.safetensors"]) {
      weightFile(id, join("snapshots", "rev1", f), "weight-bytes");
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lmr-weights-"));
    fakeHome = mkdtempSync(join(tmpdir(), "lmr-weights-home-"));
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

  it("GUARD: a complete install (venv + marker + weights) is installed", () => {
    fullyInstall("sd15");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(true);
  });

  it("a marker with no weights anywhere is NOT an installation", () => {
    venv();
    marker("sd15");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(false);
  });

  it("weights that are all zero bytes are NOT an installation", () => {
    venv();
    marker("sd15");
    weightFile("sd15", join("snapshots", "rev1", "unet", "diffusion_pytorch_model.safetensors"), "");
    expect(modelWeightsPresent(getModelSpec("sd15")!)).toBe(false);
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(false);
  });

  it("an interrupted download of a file the driver loads is NOT an installation; an unrelated one is not its business (round 9 #25)", () => {
    fullyInstall("sdxl");
    const runner = new LocalModelRunner(spawnOk().spawn);
    // An abandoned download somewhere else in the cache says nothing about
    // this revision, and used to make a usable model read as missing.
    weightFile("sdxl", join("blobs", "abc123.incomplete"), "half a tensor");
    expect(runner.isModelInstalled("sdxl")).toBe(true);
    // The file the driver actually loads, still downloading, is not there yet.
    weightFile("sdxl", join("snapshots", "rev1", "unet", "diffusion_pytorch_model.safetensors.incomplete"), "half a tensor");
    expect(runner.isModelInstalled("sdxl")).toBe(false);
  });

  it("a metadata-only cache is not an installation (round 9 #25)", () => {
    venv();
    marker("sd15");
    // model_index.json, refs/main and nothing to run: this read as installed.
    weightFile("sd15", join("snapshots", "rev1", "model_index.json"), '{"_class_name":"StableDiffusionPipeline"}');
    weightFile("sd15", join("refs", "main"), "rev1");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(false);
    // One real weight file in that revision and it is.
    weightFile("sd15", join("snapshots", "rev1", "unet", "diffusion_pytorch_model.safetensors"), "weight-bytes");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(true);
  });

  it("verifies the revision refs/main names, not files collected from several (round 9 #25)", () => {
    venv();
    marker("triposr");
    mkdirSync(join(dir, "src", "triposr", "tsr"), { recursive: true });
    writeFileSync(join(dir, "src", "triposr", "tsr", "system.py"), "# TSR\n");
    // Each named file present, but in a DIFFERENT revision: no single
    // revision the driver could load is complete.
    weightFile("triposr", join("snapshots", "revA", "config.yaml"), "cfg");
    weightFile("triposr", join("snapshots", "revB", "model.ckpt"), "ckpt");
    weightFile("triposr", join("refs", "main"), "revA");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("triposr")).toBe(false);
    // Complete the revision main names and it is installed, whatever else the
    // cache still holds (guard).
    weightFile("triposr", join("snapshots", "revA", "model.ckpt"), "ckpt");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("triposr")).toBe(true);
  });

  it("will not guess between revisions when nothing names one (guard)", () => {
    venv();
    marker("sd15");
    weightFile("sd15", join("snapshots", "revA", "unet", "diffusion_pytorch_model.safetensors"), "weight-bytes");
    weightFile("sd15", join("snapshots", "revB", "unet", "diffusion_pytorch_model.safetensors"), "weight-bytes");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(false);
    weightFile("sd15", join("refs", "main"), "revB");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(true);
  });

  it("deleting the weights after install turns installed back to false", () => {
    fullyInstall("sd15");
    const runner = new LocalModelRunner(spawnOk().spawn);
    expect(runner.isModelInstalled("sd15")).toBe(true);
    rmSync(hfWeightsDir(getModelSpec("sd15")!.weightsRef), { recursive: true, force: true });
    expect(runner.isModelInstalled("sd15")).toBe(false);
  });

  it("a repo-shipped model needs the weight file the driver loads BY NAME", () => {
    // TripoSR's driver asks for model.ckpt + config.yaml. A cache holding only
    // the config is not a usable install.
    venv();
    marker("triposr");
    mkdirSync(join(dir, "src", "triposr", "tsr"), { recursive: true });
    writeFileSync(join(dir, "src", "triposr", "tsr", "system.py"), "# TSR\n");
    weightFile("triposr", join("snapshots", "rev1", "config.yaml"), "cfg");
    const runner = new LocalModelRunner(spawnOk().spawn);
    expect(runner.isModelInstalled("triposr")).toBe(false);
    weightFile("triposr", join("snapshots", "rev1", "model.ckpt"), "ckpt-bytes");
    expect(runner.isModelInstalled("triposr")).toBe(true);
  });

  it("a repo-shipped model needs its cloned source too", () => {
    fullyInstall("triposr");
    const runner = new LocalModelRunner(spawnOk().spawn);
    expect(runner.isModelInstalled("triposr")).toBe(true);
    rmSync(join(dir, "src", "triposr"), { recursive: true, force: true });
    expect(runner.isModelInstalled("triposr")).toBe(false);
  });

  it("an empty marker file is not an installation", () => {
    fullyInstall("sd15");
    writeFileSync(join(dir, ".installed-sd15"), "");
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(false);
  });

  it("GUARD: the venv is still required — weights alone are not an installation", () => {
    fullyInstall("sd15");
    rmSync(join(dir, "venv"), { recursive: true, force: true });
    expect(new LocalModelRunner(spawnOk().spawn).isModelInstalled("sd15")).toBe(false);
  });

  it("install fetches the weights, so a finished install can be a ready one", async () => {
    const { spawn, calls } = spawnOk();
    const result = await new LocalModelRunner(spawn).install(getModelSpec("sd15")!);
    expect(result.ok).toBe(true);
    const fetch = calls.find((c) => c.args.some((a) => a.endsWith("fetch_weights.py")));
    expect(fetch, "install never fetched the weights").toBeDefined();
    expect(fetch!.args).toContain(getModelSpec("sd15")!.weightsRef);
  });

  it("a failed weights download is an honest failure, not a marker", async () => {
    // Everything up to the download works; the download itself does not.
    const spawn: SpawnImpl = async (_cmd, args) =>
      args.some((a) => a.endsWith("fetch_weights.py"))
        ? { code: 1, stdout: "", stderr: "OSError: connection reset" }
        : { code: 0, stdout: "ok", stderr: "" };
    const result = await new LocalModelRunner(spawn).install(getModelSpec("sd15")!);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/weights/i);
    expect(existsSync(join(dir, ".installed-sd15"))).toBe(false);
  });
});
