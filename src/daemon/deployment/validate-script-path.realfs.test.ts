/**
 * validateScriptPath against a real filesystem: the script's real path used
 * to be compared with the root AS GIVEN, so a root reached through a symlink
 * (macOS /tmp is /private/tmp; on Windows an 8.3 short name spells the same
 * directory differently) turned every script inside it into a "traversal".
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateScriptPath } from "./validate-script-path.js";

describe("validateScriptPath with a root spelled through a symlink", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a script inside the root however the root is spelled", () => {
    const base = mkdtempSync(path.join(tmpdir(), "strada-script-root-"));
    dirs.push(base);
    const real = path.join(base, "project");
    mkdirSync(path.join(real, "scripts"), { recursive: true });
    const script = path.join(real, "scripts", "deploy.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    const alias = path.join(base, "alias");
    symlinkSync(real, alias, "junction");

    expect(validateScriptPath("scripts/deploy.sh", alias)).toBe(realpathSync(script));
  });

  it("still refuses a script whose real path leaves the root", () => {
    const base = mkdtempSync(path.join(tmpdir(), "strada-script-root-"));
    dirs.push(base);
    const root = path.join(base, "project");
    mkdirSync(root, { recursive: true });
    const outside = path.join(base, "outside.sh");
    writeFileSync(outside, "#!/bin/sh\nexit 0\n");
    chmodSync(outside, 0o755);
    symlinkSync(outside, path.join(root, "deploy.sh"));

    expect(() => validateScriptPath("deploy.sh", root)).toThrow(/traversal via symlink/);
  });
});
