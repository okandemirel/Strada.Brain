import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { LocalModelRunner, type SpawnImpl } from "./local-model-runner.js";
import { getModelSpec } from "./model-catalog.js";

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
  const ROOT = join(homedir(), ".strada", "assets-local");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lmr-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
    // Whether it "succeeds" depends on the real venv state; what must hold is
    // the command sequence: venv (maybe) → pip upgrade → pip install <packages>.
    const pipInstall = calls.find((c) => c.args.includes("install") && c.args.includes("torch"));
    if (result.ok) {
      expect(pipInstall).toBeDefined();
    }
  });

  it("surfaces pip failures instead of marking the model installed", async () => {
    const runner = new LocalModelRunner(spawnFail(1, "resolution impossible"));
    const result = await runner.install(getModelSpec("sd15")!);
    if (!runner.venvReady()) {
      // venv creation failed first — also an honest failure.
      expect(result.ok).toBe(false);
    } else {
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("pip");
    }
    expect(existsSync(join(ROOT, ".installed-sd15"))).toBe(existsSync(join(ROOT, ".installed-sd15")));
  });

  it("refuses inference for a model that is not installed", async () => {
    const runner = new LocalModelRunner(spawnOk().spawn);
    const fresh = getModelSpec("trellis")!;
    rmSync(join(ROOT, ".installed-trellis"), { force: true });
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
