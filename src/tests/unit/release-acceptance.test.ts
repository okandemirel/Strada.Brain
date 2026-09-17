import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Release acceptance matrix (plan 6.13).
 *
 * The runner's scenarios need a built dist/, three daemon boots and an archive,
 * so what is unit-tested here is the part that decides what the run MEANS: the
 * scenario table, the summary, the printed report and the exit code. Those carry
 * the honesty rule — a scenario nobody ran must never be summarized or exited as
 * a pass — and that rule is exactly what a future edit could quietly break.
 *
 * The module is a .mjs script loaded through a non-literal specifier so the type
 * checker does not try to resolve a JavaScript file that has no declarations.
 */
interface AcceptanceScenario {
  id: string;
  title: string;
  runnableHere: boolean;
  scope?: string;
  whyNot?: string;
}

interface AcceptanceResult {
  id: string;
  title: string;
  runnableHere: boolean;
  state: "proven" | "failed" | "not-run";
  scope?: string;
  whyNot?: string;
  reason?: string;
  steps?: Array<{ name: string; state: string; detail?: string }>;
}

interface AcceptanceModule {
  ACCEPTANCE_SCENARIOS: AcceptanceScenario[];
  parseAcceptanceArgs: (argv: string[]) => {
    only: string[] | null;
    json: string | null;
    keep: boolean;
    bootTimeoutS: number;
    port: number;
  };
  summarizeAcceptance: (results: AcceptanceResult[]) => {
    proven: string[];
    failed: string[];
    notRun: string[];
    notProvableHere: string[];
    verdict: string;
  };
  exitCodeForAcceptance: (results: AcceptanceResult[]) => number;
  formatAcceptanceReport: (results: AcceptanceResult[]) => string;
  previousVersion: (version: string) => string;
  compareVersions: (a: string, b: string) => number;
}

const modulePath = pathToFileURL(
  path.join(process.cwd(), "scripts", "ci", "release-acceptance.mjs"),
).href;
const acceptance = (await import(modulePath)) as AcceptanceModule;

const result = (
  id: string,
  state: AcceptanceResult["state"],
  runnableHere = true,
): AcceptanceResult => ({
  id,
  title: id,
  runnableHere,
  state,
  scope: "scope text",
  whyNot: "why not text",
});

describe("release acceptance matrix", () => {
  it("declares the three scenarios a release must prove, plus the ones this host cannot", () => {
    const byId = new Map(acceptance.ACCEPTANCE_SCENARIOS.map((scenario) => [scenario.id, scenario]));

    for (const id of ["clean-install", "upgrade", "restore"]) {
      expect(byId.get(id)?.runnableHere, `${id} is runnable here`).toBe(true);
      // A scenario has to say what it measured; a bare "passed" is the defect.
      expect(byId.get(id)?.scope, `${id} declares its scope`).toBeTruthy();
    }
    for (const id of ["registry-install", "docker-image"]) {
      expect(byId.get(id)?.runnableHere, `${id} is not runnable here`).toBe(false);
      expect(byId.get(id)?.whyNot, `${id} says why not`).toBeTruthy();
    }
  });

  it("names the limits of each runnable scenario in its own scope text", () => {
    const scope = (id: string): string =>
      acceptance.ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === id)?.scope ?? "";

    expect(scope("clean-install")).toContain("registry resolution is NOT exercised");
    expect(scope("upgrade")).toContain("auto-updater's own download/restart path is NOT exercised");
    expect(scope("restore")).toContain("remote sync (rclone/S3) is NOT exercised");
  });

  it("counts a proven run and exits 0", () => {
    const results = [
      result("clean-install", "proven"),
      result("upgrade", "proven"),
      result("restore", "proven"),
      result("registry-install", "not-run", false),
      result("docker-image", "not-run", false),
    ];
    const summary = acceptance.summarizeAcceptance(results);

    expect(summary.proven).toEqual(["clean-install", "upgrade", "restore"]);
    expect(summary.notRun).toEqual([]);
    expect(summary.notProvableHere).toEqual(["registry-install", "docker-image"]);
    expect(summary.verdict).toContain("PROVEN: 3/3");
    expect(acceptance.exitCodeForAcceptance(results)).toBe(0);
  });

  it("never treats a runnable scenario that did not run as a pass", () => {
    const results = [
      result("clean-install", "proven"),
      result("upgrade", "not-run"),
      result("restore", "proven"),
      result("docker-image", "not-run", false),
    ];
    const summary = acceptance.summarizeAcceptance(results);

    expect(summary.notRun).toEqual(["upgrade"]);
    expect(summary.proven).not.toContain("upgrade");
    expect(summary.verdict).toContain("NOT PROVEN");
    // 3, not 0: the release is unproven, not accepted.
    expect(acceptance.exitCodeForAcceptance(results)).toBe(3);
  });

  it("exits 1 when a scenario failed, even if the others are proven", () => {
    const results = [
      result("clean-install", "proven"),
      result("upgrade", "proven"),
      result("restore", "failed"),
    ];
    expect(acceptance.summarizeAcceptance(results).verdict).toContain("FAILED: restore");
    expect(acceptance.exitCodeForAcceptance(results)).toBe(1);
  });

  it("does not let a host-unrunnable scenario hold the exit code hostage", () => {
    // docker-image can never run here; if it counted, the gate would be stuck at
    // 3 forever and nobody would read it.
    const results = [
      result("clean-install", "proven"),
      result("upgrade", "proven"),
      result("restore", "proven"),
      result("docker-image", "not-run", false),
    ];
    expect(acceptance.exitCodeForAcceptance(results)).toBe(0);
  });

  it("prints NOT RUN rows with their reason and never labels them PROVEN", () => {
    const report = acceptance.formatAcceptanceReport([
      result("clean-install", "proven"),
      { ...result("upgrade", "not-run"), reason: "the older install created no databases" },
      result("docker-image", "not-run", false),
    ]);

    expect(report).toContain("NOT RUN");
    expect(report).toContain("reason: the older install created no databases");
    expect(report).toContain("Not provable on this host");
    const upgradeLine = report.split("\n").find((line) => line.startsWith("upgrade"));
    expect(upgradeLine).toContain("NOT RUN");
    expect(upgradeLine).not.toContain("PROVEN");
  });

  it("prints a not-measured step as NOT MEASURED rather than ok", () => {
    const report = acceptance.formatAcceptanceReport([
      {
        ...result("clean-install", "proven"),
        steps: [
          { name: "boots against a fresh home", state: "ok" },
          { name: "registry resolution", state: "not-measured", detail: "node_modules symlinked" },
        ],
      },
    ]);

    expect(report).toContain("[ok] boots against a fresh home");
    expect(report).toContain("[NOT MEASURED] registry resolution — node_modules symlinked");
  });

  it("parses the flags and rejects an unknown scenario id", () => {
    const flags = acceptance.parseAcceptanceArgs([
      "--only", "restore,upgrade", "--json", "out/report.json", "--keep", "--port", "4100",
    ]);
    expect(flags.only).toEqual(["restore", "upgrade"]);
    expect(flags.keep).toBe(true);
    expect(flags.port).toBe(4100);
    expect(flags.json?.endsWith(path.join("out", "report.json"))).toBe(true);

    expect(() => acceptance.parseAcceptanceArgs(["--only", "nope"])).toThrow(/Unknown scenario/u);
    expect(() => acceptance.parseAcceptanceArgs(["--json"])).toThrow(/Missing value/u);
  });

  it("derives the older version an upgrade starts from", () => {
    expect(acceptance.previousVersion("4.2.922")).toBe("4.2.921");
    expect(acceptance.previousVersion("4.3.0")).toBe("4.2.0");
    expect(acceptance.previousVersion("5.0.0")).toBe("4.0.0");
    expect(acceptance.compareVersions("4.2.922", "4.2.921")).toBe(1);
    expect(acceptance.compareVersions("4.2.921", "4.2.921")).toBe(0);
  });
});

/**
 * Wiring, asserted over the script and workflow TEXT.
 *
 * This host has no Docker and no second machine, and a GitHub workflow cannot be
 * executed here at all — so the CI half of this item is asserted over
 * `.github/workflows/ci.yml` rather than run, and this suite says so instead of
 * implying the pipeline was observed. What IS executed locally is the runner
 * itself (three scenarios, three daemon boots, a real backup and restore).
 */
describe("release acceptance wiring (asserted over text, not executed)", () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.join(process.cwd(), relative), "utf8");

  it("npm exposes the runner and the restore driver", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["accept:release"]).toBe("node scripts/ci/release-acceptance.mjs");
    expect(pkg.scripts["restore:db"]).toBe("node scripts/restore.mjs");
  });

  it("CI runs the acceptance matrix after the build and keeps its report", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("npm run accept:release");
    expect(ci.indexOf("npm run accept:release")).toBeGreaterThan(ci.indexOf("run: npm run build"));
    expect(ci).toContain("release-acceptance.json");
  });

  it("the boot smoke accepts the overrides the runner drives it with", () => {
    // Three scenarios boot three different file sets against two homes; if these
    // overrides disappear the runner silently boots this checkout's dist/ instead
    // of the installation under test.
    const smoke = read("scripts/ci/boot-smoke.mjs");
    for (const variable of ["BOOT_SMOKE_ENTRY", "BOOT_SMOKE_INSTALL_ROOT", "BOOT_SMOKE_HOME"]) {
      expect(smoke).toContain(variable);
    }
    // An overridden home must survive the smoke: the upgrade scenario reads it.
    expect(smoke).toContain("An overridden home");
  });
});
