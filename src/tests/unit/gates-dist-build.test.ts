/**
 * The "build dist/" gate (scripts/ci/dist-build.mjs, run by scripts/ci/gates.mjs).
 *
 * A fresh worktree has no dist/, and the tests that run the compiled output
 * came up red in the gates for that reason alone: the agent saw "dist/… is
 * missing" and spent its turn on the environment. What is tested here: which
 * tests count as readers of the build, when dist/ is missing, stale or fresh,
 * that the gate builds when a selected reader needs it and otherwise skips
 * with the reason, that a failed build is a red gate, that vitest's own
 * `related` choice decides which readers are selected, and that gates.mjs
 * runs this gate before its vitest gates.
 *
 * The module is a .mjs script loaded through a non-literal specifier so the type
 * checker does not try to resolve a JavaScript file that has no declarations.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Gate {
  name: string;
  why: string;
  skip?: boolean;
  run?: () => boolean;
}

type Related = (root: string, changed: string[], candidates: string[]) => Promise<string[]>;

interface DistBuildModule {
  NAME: string;
  READS_BUILD: RegExp;
  testsThatReadBuild(root: string): string[];
  distFreshness(root: string): { state: "missing" | "stale" | "fresh"; why: string };
  vitestRelated: Related;
  distBuildGate(options: { root: string; detectors: string[]; changedSrc: string[]; npm: string; related?: Related }): Promise<Gate>;
}

const repoRoot = process.cwd();
const modulePath = path.join(repoRoot, "scripts", "ci", "dist-build.mjs");
const distBuild = (await import(pathToFileURL(modulePath).href)) as DistBuildModule;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** A reader's failure message, assembled so this file does not read as a reader itself. */
const READER_MESSAGE = ["run \\`npm run build\\`", "before this test"].join(" ");
const READER = "src/reads-build.test.ts";
/** An hour ago, in seconds: every fixture file starts here, and dist/ is dated against it. */
const T0 = Math.floor(Date.now() / 1000) - 3600;

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string, mtime = T0): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  fs.utimesSync(file, mtime, mtime);
}

/**
 * A project with one source file, one test that reads the build, one that does
 * not, and a build script: `ok` writes dist/app.js with the portal opt-out it
 * was given, `broken` fails the way tsc does.
 */
function fixture(build: "ok" | "broken"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strada-dist-build-"));
  temps.push(root);
  write(root, "package.json", JSON.stringify({ name: "dist-build-fixture", private: true, scripts: { build: "node build.mjs" } }));
  write(
    root,
    "build.mjs",
    build === "ok"
      ? 'import fs from "node:fs";\nfs.mkdirSync("dist", { recursive: true });\n' +
          'fs.writeFileSync("dist/app.js", `portal opt-out: ${process.env.STRADA_ALLOW_PORTAL_BUILD_FAILURE}`);\n'
      : 'console.error("src/app.ts(1,14): error TS2322: invented type error");\nprocess.exit(2);\n',
  );
  write(root, "src/app.ts", "export const app = 1;\n");
  write(root, READER, `expect(fs.existsSync(entry), \`\${entry} is missing: ${READER_MESSAGE}\`).toBe(true);\n`);
  write(root, "src/plain.test.ts", 'it("reads no build", () => {});\n');
  return root;
}

const relatedReturns = (files: string[]): Related => vi.fn(async () => files);

describe("which tests read the build", () => {
  it("finds the tests in this repo that fail asking for npm run build, and not this one", () => {
    const readers = distBuild.testsThatReadBuild(repoRoot);
    expect(readers).toEqual(
      expect.arrayContaining([
        "src/tests/unit/live-verify-providers.test.ts",
        "src/tests/unit/live-verify-weights.test.ts",
        "src/tests/unit/restore-script.test.ts",
      ]),
    );
    expect(readers).not.toContain("src/tests/unit/gates-dist-build.test.ts");
    // Each one in fact names a path in dist/: the marker is not a stray phrase.
    for (const file of readers) {
      expect(fs.readFileSync(path.join(repoRoot, file), "utf8"), file).toMatch(/"dist"|dist\//);
    }
  });

  it("counts the test with the message, not its neighbour", () => {
    expect(distBuild.testsThatReadBuild(fixture("ok"))).toEqual([READER]);
  });
});

describe("dist/ against src/", () => {
  it("is missing when there is no dist/", () => {
    expect(distBuild.distFreshness(fixture("ok"))).toEqual({ state: "missing", why: "dist/ is missing" });
  });

  it("is fresh when it was built after the newest source", () => {
    const root = fixture("ok");
    write(root, "dist/app.js", "built", T0 + 10);
    expect(distBuild.distFreshness(root).state).toBe("fresh");
  });

  it("is stale when a source changed after the build, and names that source", () => {
    const root = fixture("ok");
    write(root, "dist/app.js", "built", T0 + 10);
    write(root, "src/app.ts", "export const app = 2;\n", T0 + 20);
    expect(distBuild.distFreshness(root)).toEqual({ state: "stale", why: "src/app.ts changed after dist/ was built" });
  });

  it("is stale when tsconfig.json changed after the build", () => {
    const root = fixture("ok");
    write(root, "dist/app.js", "built", T0 + 10);
    write(root, "tsconfig.json", "{}\n", T0 + 20);
    expect(distBuild.distFreshness(root).state).toBe("stale");
  });

  it("dates the build by its oldest output, so a file left from an earlier build makes it stale", () => {
    const root = fixture("ok");
    write(root, "dist/old.js", "left from an earlier build", T0 - 10);
    write(root, "dist/app.js", "built", T0 + 10);
    expect(distBuild.distFreshness(root).state).toBe("stale");
  });

  it("stays fresh when only a test file changed: tests are not built into dist/", () => {
    const root = fixture("ok");
    write(root, "dist/app.js", "built", T0 + 10);
    write(root, "src/plain.test.ts", 'it("still reads no build", () => {});\n', T0 + 20);
    expect(distBuild.distFreshness(root).state).toBe("fresh");
  });
});

describe("the gate", () => {
  it("builds when a selected test reads dist/ and dist/ is missing, as CI's backend-only builds do", async () => {
    const root = fixture("ok");
    const related = relatedReturns([READER]);
    const gate = await distBuild.distBuildGate({ root, detectors: [], changedSrc: ["src/app.ts"], npm, related });
    expect(related).toHaveBeenCalledWith(root, ["src/app.ts"], [READER]);
    expect(gate.name).toBe(distBuild.NAME);
    expect(gate.skip).toBeUndefined();
    expect(gate.why).toBe(`dist/ is missing, and ${READER} reads it`);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(gate.run?.()).toBe(true);
    expect(fs.readFileSync(path.join(root, "dist", "app.js"), "utf8")).toBe("portal opt-out: 1");
    expect(log.mock.calls.flat().join("\n")).toMatch(/built dist\/ with npm run build in \d+s \(backend and web portal\)/);
  }, 60_000);

  it("rebuilds a stale dist/ and says which source made it stale", async () => {
    const root = fixture("ok");
    write(root, "dist/app.js", "built", T0 + 10);
    write(root, "src/app.ts", "export const app = 2;\n", T0 + 20);
    const gate = await distBuild.distBuildGate({ root, detectors: [], changedSrc: ["src/app.ts"], npm, related: relatedReturns([READER]) });
    expect(gate.why).toBe(`src/app.ts changed after dist/ was built, and ${READER} reads it`);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(gate.run?.()).toBe(true);
    expect(fs.readFileSync(path.join(root, "dist", "app.js"), "utf8")).toBe("portal opt-out: 1");
  }, 60_000);

  it("skips a dist/ that is up to date, and says so", async () => {
    const root = fixture("ok");
    write(root, "dist/app.js", "built", T0 + 10);
    const gate = await distBuild.distBuildGate({ root, detectors: [], changedSrc: ["src/app.ts"], npm, related: relatedReturns([READER]) });
    expect(gate).toEqual({
      name: distBuild.NAME,
      why: `dist/ is up to date (built after the newest src/ change); ${READER} reads it`,
      skip: true,
    });
  });

  it("skips when no selected test reads dist/, even with no dist/ at all", async () => {
    const root = fixture("ok");
    const gate = await distBuild.distBuildGate({ root, detectors: [], changedSrc: ["src/app.ts"], npm, related: relatedReturns([]) });
    expect(gate).toEqual({ name: distBuild.NAME, why: "no selected test reads dist/ (1 test file(s) in the repo do)", skip: true });
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });

  it("builds for a contract detector that reads dist/ without asking vitest", async () => {
    const root = fixture("ok");
    const related = relatedReturns([]);
    const gate = await distBuild.distBuildGate({ root, detectors: [READER], changedSrc: [], npm, related });
    expect(related).not.toHaveBeenCalled();
    expect(gate.run).toBeTypeOf("function");
  });

  it("assumes every reader is selected when vitest cannot say, rather than skip the build", async () => {
    const root = fixture("ok");
    const related: Related = async () => {
      throw new Error("config failed to load");
    };
    const gate = await distBuild.distBuildGate({ root, detectors: [], changedSrc: ["src/app.ts"], npm, related });
    expect(gate.run).toBeTypeOf("function");
    expect(gate.why).toContain("vitest could not say which are related, so all are assumed: config failed to load");
  });

  it("turns red on a failed build and shows the build's own output", async () => {
    const root = fixture("broken");
    const gate = await distBuild.distBuildGate({ root, detectors: [], changedSrc: ["src/app.ts"], npm, related: relatedReturns([READER]) });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(gate.run?.()).toBe(false);
    expect(out.mock.calls.flat().join("")).toContain("invented type error");
    expect(log.mock.calls.flat().join("\n")).toMatch(/npm run build FAILED \(exit 2\)/);
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  }, 60_000);
});

describe("vitest decides which readers are selected", () => {
  it("selects the reader that imports a changed module and leaves the one that does not", () => {
    // In a child process: a vitest instance inside this test worker is not the
    // setting gates.mjs runs it in. live-verify-providers.test.ts imports
    // provider-registry.ts directly; restore-script.test.ts does not.
    const script =
      `const m = await import(${JSON.stringify(pathToFileURL(modulePath).href)});\n` +
      "console.log(JSON.stringify(await m.vitestRelated(process.cwd(), ['src/agents/providers/provider-registry.ts'], " +
      "['src/tests/unit/live-verify-providers.test.ts', 'src/tests/unit/restore-script.test.ts'])));";
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: repoRoot, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split("\n").pop() ?? "null")).toEqual(["src/tests/unit/live-verify-providers.test.ts"]);
  }, 60_000);

  it("selects nothing from no candidates: to vitest an empty filter means every test file", async () => {
    await expect(distBuild.vitestRelated(repoRoot, ["src/agents/providers/provider-registry.ts"], [])).resolves.toEqual([]);
  });
});

describe("gates.mjs", () => {
  it("runs the build gate before its vitest gates and judges it by what its run() returns", () => {
    const source = fs.readFileSync(path.join(repoRoot, "scripts", "ci", "gates.mjs"), "utf8");
    const gateAt = source.indexOf("await distBuildGate(");
    expect(gateAt, "gates.mjs does not run distBuildGate").toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(source.indexOf('name: "contract detectors"'));
    expect(gateAt).toBeLessThan(source.indexOf('name: "related tests"'));
    expect(source).toMatch(/gate\.run\s*\?\s*gate\.run\(\)/);
  });
});
