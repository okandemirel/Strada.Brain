/**
 * The detector of docs/contracts/clean-checkout.md: a test file that leaves a
 * runtime entry (`.strada…`) in the checkout it runs from fails, naming it.
 *
 * The check lives in vitest.worker-setup.ts and judges the real checkout, so
 * it cannot be shown failing from inside this run: that would leave the entry
 * in the checkout every other worker is watching. A child vitest runs instead,
 * in a temp directory that stands in for the checkout, with this repository's
 * own global and worker setup.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newRuntimeEntries, runtimeEntriesIn } from "./helpers/checkout-runtime-entries.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const FIXTURES: Record<string, string> = {
  // The defect: a database opened at a relative default, which resolves
  // against the working directory.
  "leaks.test.ts": `
import { mkdirSync, writeFileSync } from "node:fs";
it("opens a database at a relative default", () => {
  mkdirSync(".strada-memory", { recursive: true });
  writeFileSync(".strada-memory/probe.db", "");
});
`,
  "own-folder.test.ts": `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("opens a database in its own temp folder", () => {
  writeFileSync(join(mkdtempSync(join(tmpdir(), "own-")), "probe.db"), "");
});
`,
  // A file's own afterAll runs before the check, so what it removes is gone.
  "tidies-up.test.ts": `
import { rmSync, writeFileSync } from "node:fs";
afterAll(() => rmSync(".strada/probe.lock"));
it("writes a lock it removes again", () => {
  writeFileSync(".strada/probe.lock", "");
});
`,
};

interface FileResult {
  name: string;
  status: string;
  message: string;
}

/** Runs the fixtures in `checkout` under the real setup files; one result per file. */
function runFixtures(checkout: string): FileResult[] {
  for (const [name, source] of Object.entries(FIXTURES)) writeFileSync(join(checkout, name), source);
  const config = join(checkout, "vitest.config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      test: {
        globals: true,
        pool: "forks",
        // One file at a time: a leak is blamed on the file that wrote it only.
        fileParallelism: false,
        include: ["*.test.ts"],
        globalSetup: [join(repoRoot, "vitest.global-setup.ts")],
        setupFiles: [join(repoRoot, "vitest.worker-setup.ts")],
      },
    })};\n`,
  );
  const report = join(checkout, "report.json");
  // A worker's own markers would tell the child it is a worker too.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  const run = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", config, "--root", checkout,
      "--reporter=json", `--outputFile=${report}`],
    { cwd: checkout, env, encoding: "utf8", timeout: 110_000 },
  );
  let parsed: { testResults: FileResult[] };
  try {
    parsed = JSON.parse(readFileSync(report, "utf8")) as { testResults: FileResult[] };
  } catch {
    throw new Error(`the child vitest wrote no report (exit ${run.status}, ${run.signal ?? "no signal"}): ${run.stderr}`);
  }
  return parsed.testResults.map((r) => ({ name: basename(r.name), status: r.status, message: r.message }));
}

describe("a test file that leaves a runtime entry in the checkout (docs/contracts/clean-checkout.md)", () => {
  it("fails, naming the path it wrote, while the files that keep to their own folder pass", () => {
    const checkout = realpathSync.native(mkdtempSync(join(tmpdir(), "clean-checkout-")));
    // Already there when the run starts, as a daemon's lock is in a live
    // checkout: no file wrote it, so no file is blamed for it.
    mkdirSync(join(checkout, ".strada"));
    writeFileSync(join(checkout, ".strada", "runtime.lock"), "");

    const results = runFixtures(checkout);

    const messages = results.map((r) => `${r.name}: ${r.message}`).join("\n");
    expect(Object.fromEntries(results.map((r) => [r.name, r.status])), messages).toEqual({
      "leaks.test.ts": "failed",
      "own-folder.test.ts": "passed",
      "tidies-up.test.ts": "passed",
    });
    const leak = results.find((r) => r.name === "leaks.test.ts")!.message;
    expect(leak).toContain(`left ${join(checkout, ".strada-memory/probe.db")} in the checkout it runs from`);
    expect(leak).toContain("docs/contracts/clean-checkout.md");
  }, 120_000);
});

describe("runtime entries", () => {
  it("are the .strada… entries at the top of a directory and everything inside them", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-entries-"));
    mkdirSync(join(dir, ".strada", "vault"), { recursive: true });
    writeFileSync(join(dir, ".strada", "vault", "index.db"), "");
    writeFileSync(join(dir, ".strada-update.lock"), "");
    mkdirSync(join(dir, "src", ".strada"), { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "");
    expect([...runtimeEntriesIn(dir)].sort()).toEqual([
      ".strada",
      ".strada-update.lock",
      ".strada/vault",
      ".strada/vault/index.db",
    ]);
    expect(runtimeEntriesIn(join(dir, "missing")).size).toBe(0);
  });

  it("that are new are named by their deepest path, and an entry already there is not new", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-entries-"));
    mkdirSync(join(dir, ".strada"));
    const before = runtimeEntriesIn(dir);
    mkdirSync(join(dir, ".strada-memory"));
    writeFileSync(join(dir, ".strada-memory", "model-intelligence.db"), "");
    writeFileSync(join(dir, ".strada-memory", "dynamic-profiles.db"), "");
    mkdirSync(join(dir, ".strada", "locks"));
    expect(newRuntimeEntries(dir, before)).toEqual([
      ".strada-memory/dynamic-profiles.db",
      ".strada-memory/model-intelligence.db",
      ".strada/locks",
    ]);
    expect(newRuntimeEntries(dir, runtimeEntriesIn(dir))).toEqual([]);
  });
});
