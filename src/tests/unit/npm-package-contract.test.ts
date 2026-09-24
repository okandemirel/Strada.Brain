/**
 * What the npm tarball may contain (OPS-10).
 *
 * `.npmignore` listed dist/tests/ and dist/test-helpers.*, but a root
 * .npmignore does not override package.json `files`, so test code (importing
 * the devDependency vitest) shipped. The build also copied EVERY non-.ts file
 * under src/ — tracked or not — into dist/, and never cleaned dist/, so a stray
 * `.env`, a scratch file, or the output of a deleted source could be published.
 *
 * The pack case runs `npm pack --dry-run --json` against the repository's own
 * package.json over a synthetic tree: offline, no build, and it asks npm itself
 * which paths the `files` rules keep.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function touch(root: string, rel: string, content = "x"): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface BuildPackageModule {
  copyRuntimeAssets(srcDir: string, outDir: string, tracked?: Set<string> | null): number;
}

async function loadBuildPackage(): Promise<BuildPackageModule> {
  return import(pathToFileURL(path.join(repoRoot, "scripts", "build-package.mjs")).href) as Promise<BuildPackageModule>;
}

describe.skipIf(process.platform === "win32")("npm pack contents", () => {
  it("keeps runtime files and drops test code and dotfiles", () => {
    const root = tempRoot("strada-pack-");
    // The repository's own packing rules; lifecycle scripts left out, because
    // `npm pack` runs `prepare` and there is nothing here to build.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const { name, version, main, bin, files } = pkg;
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version, main, bin, files }), "utf8");
    const shipped = [
      "dist/index.js",
      "dist/vault/schema.sql",
      "dist/skills/bundled/hello-world/SKILL.md",
      "dist/dashboard/templates/dashboard.js",
      "scripts/source-launcher.mjs",
    ];
    const excluded = [
      "dist/tests/helpers/mock-provider.js",
      "dist/test-helpers.js",
      "dist/test-helpers.d.ts",
      "dist/dashboard/test-support/mock-http.js",
      "dist/channels/slack/__tests__/app.test.js",
      "dist/foo/.env",
    ];
    for (const rel of [...shipped, ...excluded]) touch(root, rel);

    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const [pack] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(pack!.files.map((file) => file.path));
    for (const rel of shipped) expect(packed.has(rel), `${rel} missing from the tarball`).toBe(true);
    for (const rel of excluded) expect(packed.has(rel), `${rel} is in the tarball`).toBe(false);
  });

  it("does not rely on a root .npmignore, which `files` overrides", () => {
    expect(existsSync(path.join(repoRoot, ".npmignore"))).toBe(false);
  });
});

describe("build-package runtime assets", () => {
  function makeSrc(): string {
    const src = path.join(tempRoot("strada-assets-"), "src");
    for (const rel of [
      "skills/bundled/demo/SKILL.md",
      "vault/schema.sql",
      "dashboard/templates/page.html",
      "dashboard/templates/page.js",
      "agents/providers/sources.json",
      "vault/store.ts",
      "stray/.env",
      "stray/local.sqlite",
      "stray/notes.txt",
      ".hidden/leak.json",
      "tests/fixtures/data.json",
      "channels/slack/__tests__/fixture.json",
    ]) touch(src, rel);
    return src;
  }

  it("copies only allowlisted runtime assets, never dotfiles or test fixtures", async () => {
    const { copyRuntimeAssets } = await loadBuildPackage();
    const src = makeSrc();
    const out = path.join(path.dirname(src), "dist");
    copyRuntimeAssets(src, out, null);
    const has = (rel: string) => existsSync(path.join(out, rel));
    for (const rel of [
      "skills/bundled/demo/SKILL.md",
      "vault/schema.sql",
      "dashboard/templates/page.html",
      "dashboard/templates/page.js",
      "agents/providers/sources.json",
    ]) expect(has(rel), rel).toBe(true);
    for (const rel of [
      "vault/store.ts",
      "stray/.env",
      "stray/local.sqlite",
      "stray/notes.txt",
      ".hidden/leak.json",
      "tests/fixtures/data.json",
      "channels/slack/__tests__/fixture.json",
    ]) expect(has(rel), rel).toBe(false);
  });

  it("in a git checkout, copies only what git tracks", async () => {
    const { copyRuntimeAssets } = await loadBuildPackage();
    const src = makeSrc();
    const out = path.join(path.dirname(src), "dist");
    const tracked = new Set([path.join(src, "vault", "schema.sql")]);
    expect(copyRuntimeAssets(src, out, tracked)).toBe(1);
    expect(existsSync(path.join(out, "vault", "schema.sql"))).toBe(true);
    expect(existsSync(path.join(out, "skills", "bundled", "demo", "SKILL.md"))).toBe(false);
  });

  it("starts every backend build from an empty dist/ (tsc never deletes stale output)", () => {
    const source = readFileSync(path.join(repoRoot, "scripts", "build-package.mjs"), "utf8");
    const clean = source.indexOf("rmSync(DIST_DIR, { recursive: true, force: true })");
    const tsc = source.indexOf('run(resolveCommandBinary("tsc")');
    expect(clean, "dist/ is never removed before tsc").toBeGreaterThan(-1);
    expect(clean).toBeLessThan(tsc);
  });
});
