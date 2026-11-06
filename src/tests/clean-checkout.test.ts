/**
 * The detector of docs/contracts/clean-checkout.md: a test file that leaves a
 * runtime entry (`.strada…`) in the checkout it runs from fails, naming it.
 *
 * The check lives in vitest.worker-setup.ts and judges the real checkout, so
 * it cannot be shown failing from inside this run: that would leave the entry
 * in the checkout every other worker is watching. A child vitest runs instead,
 * in a temp directory that stands in for the checkout, with this repository's
 * own global and worker setup.
 *
 * The watch lists two roots: the working directory, which a relative default
 * resolves against, and the install root the worker setup sits in, which a
 * vault or lock is built from. In this repository they are one directory, so
 * a child run from it could not tell one half of the watch from the other.
 * The stand-in separates them: the worker setup and the files it imports are
 * copied into a temp install root, and the child runs one directory below it.
 */
import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newRuntimeEntries, runtimeEntriesIn } from "./helpers/checkout-runtime-entries.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The worker setup and every file of this repository it imports, copied byte for byte. */
const WORKER_SETUP = [
  "vitest.worker-setup.ts",
  "src/tests/helpers/decoy-home.ts",
  "src/tests/helpers/checkout-runtime-entries.ts",
];

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
  // The same defect through the other root: a vault built from the install
  // root lands beside the source, wherever the run stands.
  "leaks-at-install-root.test.ts": `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const installRoot = join(process.cwd(), "..");
it("builds its vault from the install root", () => {
  mkdirSync(join(installRoot, ".strada", "vault"), { recursive: true });
  writeFileSync(join(installRoot, ".strada", "vault", "index.db"), "");
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
import { join } from "node:path";
const lock = join(process.cwd(), "..", ".strada", "probe.lock");
afterAll(() => rmSync(lock));
it("writes a lock it removes again", () => {
  writeFileSync(lock, "");
});
`,
};

interface FileResult {
  name: string;
  status: string;
  message: string;
}

/**
 * Copies the worker setup into `installRoot`, runs the fixtures in `workDir`
 * under it, and returns one result per file. The copy imports vitest through
 * a link to this repository's node_modules.
 */
function runFixtures(installRoot: string, workDir: string): FileResult[] {
  for (const file of WORKER_SETUP) {
    mkdirSync(dirname(join(installRoot, file)), { recursive: true });
    copyFileSync(join(repoRoot, file), join(installRoot, file));
  }
  symlinkSync(join(repoRoot, "node_modules"), join(installRoot, "node_modules"), "junction");
  mkdirSync(workDir);
  for (const [name, source] of Object.entries(FIXTURES)) writeFileSync(join(workDir, name), source);
  const config = join(workDir, "vitest.config.mjs");
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
        setupFiles: [join(installRoot, "vitest.worker-setup.ts")],
      },
    })};\n`,
  );
  const report = join(workDir, "report.json");
  // A worker's own markers would tell the child it is a worker too.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  const run = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", config, "--root", workDir,
      "--reporter=json", `--outputFile=${report}`],
    { cwd: workDir, env, encoding: "utf8", timeout: 110_000 },
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
  it("fails, naming the path it wrote under either root, while the files that keep to their own folder pass", () => {
    const installRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "clean-checkout-")));
    const workDir = join(installRoot, "work");
    // Already there when the run starts, as a daemon's lock is in a live
    // checkout: no file wrote it, so no file is blamed for it.
    mkdirSync(join(installRoot, ".strada"));
    writeFileSync(join(installRoot, ".strada", "runtime.lock"), "");

    const results = runFixtures(installRoot, workDir);

    const messages = results.map((r) => `${r.name}: ${r.message}`).join("\n");
    expect(Object.fromEntries(results.map((r) => [r.name, r.status])), messages).toEqual({
      "leaks.test.ts": "failed",
      "leaks-at-install-root.test.ts": "failed",
      "own-folder.test.ts": "passed",
      "tidies-up.test.ts": "passed",
    });
    const messageOf = (name: string): string => results.find((r) => r.name === name)!.message;
    expect(messageOf("leaks.test.ts")).toContain(
      `left ${join(workDir, ".strada-memory/probe.db")} in the checkout it runs from`,
    );
    expect(messageOf("leaks-at-install-root.test.ts")).toContain(
      `left ${join(installRoot, ".strada/vault/index.db")} in the checkout it runs from`,
    );
    expect(messageOf("leaks.test.ts")).toContain("docs/contracts/clean-checkout.md");
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
