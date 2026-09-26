/**
 * CI workflow contract (14F6 / D75, OPS-1, OPS-14, X-5).
 *
 * These tests were committed ahead of the workflow change they describe (the
 * OAuth app that pushed them lacked the `workflow` scope), which kept CI red
 * on every push. The workflow files now carry the change.
 *
 * Holes this closes:
 *   - CI type-checked, linted, tested and built, but never started what it
 *     built. `npm run smoke:boot` existed and nothing ran it, so a boot-time
 *     crash went green.
 *   - Version Bump triggered on `push` to main, independently of CI. A commit
 *     that failed every job still got a version bump, published as if it were a
 *     release candidate. The bump must depend on the CI run for that commit.
 *   - The first design of that dependency was itself unsafe (OPS-14): it
 *     checked out the branch TIP rather than the SHA CI tested, and nothing
 *     kept a pull request's CI run (a fork's branch can be named `main`) from
 *     triggering a write to this repository's main.
 *   - verify ran `npm test` before `npm run build`, and a test needs dist/.
 *
 * Asserted over the workflow YAML as text (no YAML parser is a dependency
 * here); the properties are which job runs what, and what triggers the bump.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (name: string): string =>
  readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");

const ci = read("ci.yml");
const bump = read("version-bump.yml");
const liveVerify = read("live-verify.yml");

/** The block of a top-level `jobs:` entry, by name. */
function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`);
  expect(start, `job ${job} is not defined`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("ci.yml", () => {
  it("has a smoke job that actually boots the build", () => {
    const smoke = jobBlock(ci, "smoke");
    expect(smoke).toMatch(/npm run build/);
    expect(smoke).toMatch(/npm run smoke:boot/);
  });

  it("gives the smoke job its own runner, so a boot failure is attributable", () => {
    expect(ci).toMatch(/\n {2}smoke:\n/);
    const smoke = jobBlock(ci, "smoke");
    expect(smoke).toMatch(/runs-on:/);
    expect(smoke).toMatch(/timeout-minutes:/);
  });

  it("is named CI — the version bump keys its workflow_run on that name", () => {
    expect(ci).toMatch(/^name: CI$/m);
  });

  it("verify builds before it tests: a test drives the compiled helper in dist/ (X-5)", () => {
    const verify = jobBlock(ci, "verify");
    const build = verify.indexOf("run: npm run build");
    expect(build, "verify has no Build step").toBeGreaterThan(-1);
    expect(build).toBeLessThan(verify.indexOf("run: npm test"));
  });

  it("coverage builds before it tests, for the same dist/ helper (X-5)", () => {
    const coverage = jobBlock(ci, "coverage");
    const build = coverage.indexOf("run: npm run build");
    expect(build, "coverage has no Build step").toBeGreaterThan(-1);
    expect(build).toBeLessThan(coverage.indexOf("run: npm run test:coverage"));
  });

  it("the smoke job boots the build before running release acceptance, and never boots a registry package", () => {
    const smoke = jobBlock(ci, "smoke");
    const build = smoke.indexOf("run: npm run build");
    expect(build).toBeLessThan(smoke.indexOf("npm run smoke:boot"));
    expect(build).toBeLessThan(smoke.indexOf("npm run accept:release"));
    // strada-brain is not published, so the name on the registry is not ours.
    expect(smoke).toMatch(/STRADA_ACCEPTANCE_NO_REGISTRY: "1"/);
    // "NOT PROVEN" (exit 3) is surfaced, not failed and not hidden.
    expect(smoke).toMatch(/"\$code" -eq 3/);
    expect(smoke).toMatch(/::warning title=Release acceptance NOT PROVEN::/);
  });

  it("the smoke job runs the CLI release smoke after release acceptance, with its own time limit", () => {
    // scripts/release/cli-release-smoke.mjs existed and CI never ran it, so its
    // scenarios (failover, routing, PAOR recovery) regressed unseen.
    const smoke = jobBlock(ci, "smoke");
    const step = smoke.indexOf("run: npm run smoke:cli:release");
    expect(step, "the smoke job does not run the CLI release smoke").toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(smoke.indexOf("run: npm run build"));
    expect(step).toBeGreaterThan(smoke.indexOf("npm run accept:release"));
    const stepBlock = smoke.slice(smoke.lastIndexOf("- name:", step), step);
    expect(stepBlock).toMatch(/timeout-minutes: \d+/);
    // Not allowed to fail: a red smoke is a red build.
    expect(stepBlock).not.toMatch(/continue-on-error/);
  });

  it("runs the whole test suite on Windows, after the build, and lets it fail the build", () => {
    // windows-verify ran only the launcher and setup tests, so the rest of the
    // suite had never run on Windows.
    const windows = jobBlock(ci, "windows-test");
    expect(windows).toMatch(/runs-on: windows-/);
    const test = windows.indexOf("run: npm test");
    expect(test, "windows-test does not run the suite").toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(windows.indexOf("run: npm run build"));
    expect(windows).not.toMatch(/continue-on-error/);
  });

  it("keeps every other job", () => {
    for (const job of ["verify", "windows-verify", "windows-test", "bench", "coverage"]) {
      expect(ci, job).toMatch(new RegExp(`\\n {2}${job}:\\n`));
    }
  });

  it("points the Strada.Core declaration tests at the checkout verify clones (OPS-11)", () => {
    const verify = jobBlock(ci, "verify");
    const clone = /git clone [^\n]*Strada\.Core\.git (\S+)/.exec(verify)?.[1];
    expect(clone, "verify no longer clones Strada.Core").toBeDefined();
    const testStep = verify.slice(verify.indexOf("- name: Test\n"));
    const corePath = /STRADA_CORE_PATH: (\S+)/.exec(testStep.slice(0, testStep.indexOf("run: npm test")))?.[1];
    expect(corePath, "the Test step does not set STRADA_CORE_PATH").toBe(clone);
  });

  it("never lets the latency gate pass without a baseline, and says when it is not gating (OPS-12)", () => {
    const bench = jobBlock(ci, "bench");
    // bench:check is `gate.mjs --check` without --require-baseline: exit 0,
    // nothing compared.
    expect(bench).not.toMatch(/npm run bench:check/);
    const checks = bench.split("\n").filter((line) => /gate\.mjs --check/.test(line));
    expect(checks.length, "bench never runs the gate").toBeGreaterThan(0);
    for (const line of checks) expect(line).toMatch(/--require-baseline/);
    expect(bench).toMatch(/::warning title=Latency gate NOT GATED::/);
  });
});

describe("version-bump.yml", () => {
  it("runs after the CI workflow instead of on every push", () => {
    expect(bump).toMatch(/on:\s*\n\s*workflow_run:/);
    expect(bump).toMatch(/workflows:\s*\["?CI"?\]/);
    expect(bump).toMatch(/types:\s*\[completed\]/);
    // A bare `push:` trigger is what made the bump independent of CI.
    expect(bump).not.toMatch(/^\s{2}push:/m);
  });

  it("bumps only when that CI run succeeded", () => {
    const job = jobBlock(bump, "bump");
    expect(job).toMatch(/github\.event\.workflow_run\.conclusion == 'success'/);
    // And still skips its own [skip ci] bump commit, or it loops forever.
    expect(job).toMatch(/workflow_run\.head_commit\.message, '\[skip ci\]'/);
  });

  it("bumps the commit CI verified, not whatever main points at now", () => {
    const job = jobBlock(bump, "bump");
    // head_sha is the commit the CI run tested; head_branch names a branch whose
    // tip may already be a commit CI never saw (OPS-14).
    expect(job).toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    expect(job).not.toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/);
  });

  it("acts only on a CI run for a push to this repository's main (OPS-14)", () => {
    const job = jobBlock(bump, "bump");
    // workflow_run runs with this repository's write token: a pull request's CI
    // run — a fork's branch can be called main — must never reach the push.
    expect(job).toMatch(/github\.event\.workflow_run\.event == 'push'/);
    expect(job).toMatch(/github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
    expect(job).toMatch(/github\.event\.workflow_run\.head_branch == 'main'/);
  });

  it("fast-forwards main from the verified commit, never force-pushes (OPS-14)", () => {
    const job = jobBlock(bump, "bump");
    expect(job).toMatch(/git push origin HEAD:main\s*$/m);
    expect(job).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+HEAD)/);
    // A main that moved past the verified commit is left to that commit's own run.
    expect(job).toMatch(/git rev-parse FETCH_HEAD/);
  });
});

/**
 * Live verify (manual): the real Hugging Face download and the real OpenCode
 * API. It holds a provider secret, so what it may be triggered by, what its
 * token may do and where that secret may appear are the contract.
 */
describe("live-verify.yml", () => {
  /** The steps of a job, each from its `- name:` to the next. */
  const steps = (job: string): string[] => jobBlock(liveVerify, job).split(/\n(?= {6}- )/).slice(1);

  it("runs only when started by hand: never on push, pull_request or any other event", () => {
    const on = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(liveVerify)?.[1];
    expect(on, "no on: block").toBeDefined();
    const triggers = [...on!.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
    expect(triggers).toEqual(["workflow_dispatch"]);
    expect(liveVerify).not.toMatch(/^\s*(push|pull_request|pull_request_target|workflow_run|workflow_call|schedule|repository_dispatch):/m);
  });

  it("holds a read-only token, and no job widens it", () => {
    expect(liveVerify).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(liveVerify.match(/permissions:/g)).toHaveLength(1);
    expect(liveVerify).not.toMatch(/:\s*write\b/);
  });

  it("gives each job its own time limit, and lets no step fail quietly", () => {
    for (const job of ["local-weights", "providers"]) {
      expect(jobBlock(liveVerify, job), job).toMatch(/\n {4}timeout-minutes: \d+\n/);
    }
    expect(liveVerify).not.toMatch(/continue-on-error/);
  });

  it("builds, then runs each verification script", () => {
    for (const [job, script] of [["local-weights", "live-verify-weights.mjs"], ["providers", "live-verify-providers.mjs"]] as const) {
      const block = jobBlock(liveVerify, job);
      const run = block.indexOf(`run: node scripts/ci/${script}`);
      expect(run, `${job} does not run ${script}`).toBeGreaterThan(-1);
      expect(block.indexOf("run: npm run build"), `${job} does not build first`).toBeGreaterThan(-1);
      expect(block.indexOf("run: npm run build")).toBeLessThan(run);
    }
  });

  it("uses one secret, OPENCODE_API_KEY, only in the env of the providers verify step", () => {
    const secrets = [...liveVerify.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(secrets).toEqual(["OPENCODE_API_KEY"]);
    expect(jobBlock(liveVerify, "local-weights")).not.toMatch(/secrets\./);
    const withSecret = steps("providers").filter((step) => step.includes("secrets."));
    expect(withSecret).toHaveLength(1);
    const step = withSecret[0]!;
    expect(step).toMatch(/run: node scripts\/ci\/live-verify-providers\.mjs/);
    // In the step's env mapping, not interpolated into a shell command.
    const env = /\n {8}env:\n((?: {10}.*\n| *#.*\n)*)/.exec(step)?.[1] ?? "";
    expect(env).toMatch(/^ {10}OPENCODE_API_KEY: \$\{\{ secrets\.OPENCODE_API_KEY \}\}$/m);
    for (const line of liveVerify.split("\n").filter((entry) => /\brun:/.test(entry))) {
      expect(line).not.toMatch(/secrets\.|\bprintenv\b|\benv\s*(\||$)|set -x/);
    }
    // Repository variables are for the non-secret overrides only.
    const vars = [...liveVerify.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((match) => match[1]).sort();
    expect(vars).toEqual(["OPENCODE_BASE_URL", "OPENCODE_DEFAULT_MODEL"]);
  });

  it("never mentions an Anthropic key: it is not used for live tests", () => {
    expect(liveVerify).not.toMatch(/anthropic/i);
  });
});

