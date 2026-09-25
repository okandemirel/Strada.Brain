/**
 * FND-22: `strada preset set` rewrites the .env that holds every API key.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPresetCommands } from "./preset-cli.js";
import { loadConfig } from "./config.js";

let dir: string | undefined;
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

async function presetSet(envPath: string, name: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerPresetCommands(program, { envPath });
  // The runtime's cwd is its config root; run there so the default path agrees.
  process.chdir(join(envPath, ".."));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await program.parseAsync(["node", "strada", "preset", "set", name]);
}

describe("preset set (FND-22)", () => {
  it("replaces SYSTEM_PRESET and keeps every other line", async () => {
    dir = mkdtempSync(join(tmpdir(), "preset-cli-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "# keys\nANTHROPIC_API_KEY=sk-test\nSYSTEM_PRESET=free\nOTHER=1\n");

    await presetSet(envPath, "budget");

    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("SYSTEM_PRESET=budget");
    expect(content).not.toContain("SYSTEM_PRESET=free");
    expect(content).toContain("# keys\nANTHROPIC_API_KEY=sk-test\n");
    expect(content).toContain("OTHER=1");
    // Written via a temp file that is renamed into place: nothing left over.
    expect(readdirSync(dir).filter((f) => f !== ".env")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("leaves the .env readable by its owner only", async () => {
    dir = mkdtempSync(join(tmpdir(), "preset-cli-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-test\n");
    chmodSync(envPath, 0o644);

    await presetSet(envPath, "balanced");

    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(envPath, "utf8")).toContain("SYSTEM_PRESET=balanced");
  });
});

describe("SYSTEM_PRESET validation (FND-22)", () => {
  it("rejects a prototype key instead of loading a preset of undefined fields", () => {
    dir = mkdtempSync(join(tmpdir(), "preset-cli-"));
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test-key-123", UNITY_PROJECT_PATH: dir!, SYSTEM_PRESET: "toString" }))
      .toThrow(/Invalid SYSTEM_PRESET/);
  });
});
