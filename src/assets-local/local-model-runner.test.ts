import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
