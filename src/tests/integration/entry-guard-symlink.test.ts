import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Node runs an entry module from its realpath, so `import.meta.url` never keeps
 * a symlink, while process.argv[1] is the path as typed. The scripts' "am I the
 * entry point?" guards compared the two by spelling, so a script started by an
 * absolute path through a symlinked directory (macOS /var -> /private/var, a
 * ~/code link, an /opt/strada -> /opt/strada-4.2 install root) took itself for
 * an import and exited 0 having done nothing: backup.sh then reported "No
 * databases found", and the publish-lock gate passed. Each case runs a script
 * through a link with arguments that make it answer quickly and touch nothing.
 * The source launcher has its own cases in source-launcher.test.ts.
 *
 * POSIX only: a symlink on Windows needs a privilege.
 */
describe.skipIf(process.platform === "win32")("scripts started through a symlinked checkout", () => {
  let tempParent = "";
  let checkoutLink = "";
  let fixtureLink = "";

  beforeAll(() => {
    tempParent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "strada-entry-guard-")));
    checkoutLink = path.join(tempParent, "checkout-link");
    symlinkSync(process.cwd(), checkoutLink, "dir");
    // These two act on the root they live in (one builds it, one passes a clean
    // one silently), so they run from a copy whose package.json makes both fail
    // fast and say so.
    const fixture = path.join(tempParent, "fixture");
    mkdirSync(path.join(fixture, "scripts", "ci"), { recursive: true });
    for (const script of ["scripts/build-package.mjs", "scripts/ci/check-publish-lock.mjs"]) {
      copyFileSync(path.join(process.cwd(), script), path.join(fixture, script));
    }
    writeFileSync(
      path.join(fixture, "package.json"),
      `${JSON.stringify({ name: "entry-guard-fixture", version: "0.0.0", private: true, overrides: { uuid: "9.0.0" } })}\n`,
    );
    fixtureLink = path.join(tempParent, "fixture-link");
    symlinkSync(fixture, fixtureLink, "dir");
  });

  afterAll(() => {
    // The link points at the live checkout: drop it on its own before the rest.
    if (checkoutLink) unlinkSync(checkoutLink);
    rmSync(tempParent, { recursive: true, force: true });
  });

  const cases: Array<{ script: string; inFixture?: boolean; nodeArgs?: string[]; args: string[]; says: RegExp }> = [
    { script: "scripts/restore.mjs", args: [], says: /usage: restore\.mjs/ },
    { script: "src/core/database-backup.ts", nodeArgs: ["--import", "tsx"], args: [], says: /usage: database-backup/ },
    { script: "scripts/audit-env-coverage.mjs", args: [], says: /Env-Var Coverage Audit/ },
    { script: "scripts/ci/live-verify-weights.mjs", args: ["--not-a-flag"], says: /Unknown argument: --not-a-flag/ },
    { script: "scripts/ci/live-verify-providers.mjs", args: ["--not-a-flag"], says: /unexpected argument --not-a-flag/ },
    { script: "scripts/ci/release-acceptance.mjs", args: ["--not-a-flag"], says: /Missing value for --not-a-flag/ },
    { script: "scripts/eval/learning-eval.mjs", args: ["--help"], says: /learning ablation harness/ },
    { script: "scripts/eval/requirement-evidence-eval.mjs", args: ["--help"], says: /requirement–evidence map/ },
    { script: "scripts/ci/check-publish-lock.mjs", inFixture: true, args: [], says: /check-publish-lock: package\.json has overrides/ },
    { script: "scripts/build-package.mjs", inFixture: true, args: ["--portal-only"], says: /build:portal/ },
  ];

  for (const { script, inFixture, nodeArgs = [], args, says } of cases) {
    it(`${script} runs when started by a symlinked path`, () => {
      const result = spawnSync(
        process.execPath,
        [...nodeArgs, path.join(inFixture ? fixtureLink : checkoutLink, script), ...args],
        { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
      );
      const output = `${result.stdout}${result.stderr}`;
      // Was: exit 0 and no output at all.
      expect(output, `exit ${result.status}`).toMatch(says);
    }, 60_000);
  }

  it("no entry guard compares process.argv[1] by its spelling", () => {
    // pathToFileURL() and path.resolve() keep the symlinks import.meta.url has
    // lost, and so does argv[1] compared as it is.
    const lexicalGuard =
      /(?:pathToFileURL|resolve)\(\s*process\.argv\[1\]\s*\)|process\.argv\[1\]\s*===(?!\s*undefined\b)|===\s*process\.argv\[1\]/;
    const offenders: string[] = [];
    for (const dir of ["scripts", "src"]) {
      for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        if (!/\.(?:mjs|js|ts)$/.test(rel) || rel.endsWith(".test.ts")) continue;
        const file = path.join(dir, rel);
        if (lexicalGuard.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
