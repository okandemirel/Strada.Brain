/**
 * A project root reached through a symlink names each of its files two ways.
 * Every macOS lease is one: os.tmpdir() is /var/folders/…, /var is a symlink
 * to /private/var, and pwd, git rev-parse, build errors and validatePath's
 * own fullPath print the real form. validatePath judged an already-canonical
 * path against the lexical root, so it refused /private/var/…/<lease>/Assets/X.cs
 * as "outside the project directory (/var/…/<lease>)" — the directory the
 * agent was in (audit security-config#1).
 *
 * The root here goes through a symlink made for the test, so this is measured
 * on every POSIX machine, not only where tmpdir happens to be one. A guard
 * that gets more permissive has to be shown to still guard: the second block
 * is what must stay refused.
 */
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { normalizeToolPathInput, projectRelativeTarget, validatePath } from "./path-guard.js";

const base = mkdtempSync(join(tmpdir(), "guard-real-form-"));
const realParent = join(base, "real");
mkdirSync(join(realParent, "proj", "Assets", "Scripts"), { recursive: true });
mkdirSync(join(realParent, "proj", ".ssh"));
mkdirSync(join(realParent, "proj-evil"));
mkdirSync(join(base, "outside"));
writeFileSync(join(realParent, "proj", "Assets", "Scripts", "Old.cs"), "");
writeFileSync(join(realParent, "proj", ".env"), "KEY=1\n");
symlinkSync(realParent, join(base, "link"), "junction");
// In-project symlinks: one leaving the project, one onto a blocked directory.
symlinkSync(join(base, "outside"), join(realParent, "proj", "Assets", "out"), "junction");
symlinkSync(join(realParent, "proj", ".ssh"), join(realParent, "proj", "Assets", "keys"), "junction");
mkdirSync(join(realParent, "proj", "Assets", "Vendor"));
symlinkSync(join(realParent, "proj", "Assets", "Vendor"), join(realParent, "proj", "Assets", "node_modules"), "junction");

/** The root as the lease manager hands it over: lexical, through the symlink. */
const root = join(base, "link", "proj");
/** The same directory as pwd, git and the compiler print it. */
const real = realpathSync(join(realParent, "proj"));
const realBase = realpathSync(base);
const allow = { allowMissingParents: true };

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("a path written in the root's real form is inside the project", () => {
  it("accepts an existing file", async () => {
    const result = await validatePath(root, join(real, "Assets", "Scripts", "Old.cs"));
    expect(result.error).toBeUndefined();
    expect(result.fullPath).toBe(join(real, "Assets", "Scripts", "Old.cs"));
  });

  it("accepts a new file in an existing directory", async () => {
    const result = await validatePath(root, join(real, "Assets", "Scripts", "New.cs"));
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("accepts a new file below directories that do not exist yet, when the caller allows that", async () => {
    const result = await validatePath(root, join(real, "Assets", "Scripts", "Deep", "Er", "New.cs"), allow);
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("accepts the root itself", async () => {
    expect((await validatePath(root, real)).valid).toBe(true);
  });

  it("still accepts the lexical and the relative spelling", async () => {
    expect((await validatePath(root, join(root, "Assets", "Scripts", "Old.cs"))).valid).toBe(true);
    expect((await validatePath(root, join(root, "Assets", "Scripts", "New.cs"))).valid).toBe(true);
    expect((await validatePath(root, "Assets/Scripts/Old.cs")).valid).toBe(true);
  });

  it("maps a real-form absolute path to a project-relative one for the tools that normalize first", () => {
    expect(normalizeToolPathInput(root, join(real, "Assets", "Scripts", "Old.cs")))
      .toEqual({ ok: true, relativePath: join("Assets", "Scripts", "Old.cs") });
    expect(normalizeToolPathInput(root, real)).toEqual({ ok: true, relativePath: "." });
  });
});

describe("what judging the real form must not let through", () => {
  it("refuses a sibling that shares the real root's prefix, and a real-form path outside", async () => {
    for (const outside of [
      join(realBase, "real", "proj-evil", "x.cs"),
      join(realBase, "outside", "x.cs"),
      `${real}/../outside.cs`,
    ]) {
      const result = await validatePath(root, outside, allow);
      expect(result.valid, outside).toBe(false);
      expect(result.error, outside).toMatch(/outside the project/);
    }
    expect(normalizeToolPathInput(root, join(realBase, "real", "proj-evil", "x.cs")).ok).toBe(false);
    expect(normalizeToolPathInput(root, join(realBase, "outside", "x.cs")).ok).toBe(false);
  });

  it("refuses a new file through an in-project symlink that leaves the project", async () => {
    expect((await validatePath(root, "Assets/out/new.cs")).valid).toBe(false);
    expect((await validatePath(root, "Assets/out/a/b/new.cs", allow)).valid).toBe(false);
    expect((await validatePath(root, join(real, "Assets", "out", "new.cs"))).valid).toBe(false);
  });

  it("keeps the blocklist on the real form", async () => {
    const env = await validatePath(root, join(real, ".env"));
    expect(env.valid).toBe(false);
    expect(env.error).toBe("Access to sensitive files is not permitted");
  });

  it("refuses a new file whose real location is a blocked directory, however it is spelled", async () => {
    // Assets/keys -> <proj>/.ssh: the spelled path names no secret, the file
    // would land in .ssh/. The old code tested only the spelling for a new file.
    for (const [path, options] of [
      ["Assets/keys/new_key", {}],
      ["Assets/keys/sub/new_key", allow],
    ] as const) {
      const result = await validatePath(root, path, options);
      expect(result.valid, path).toBe(false);
      expect(result.error, path).toBe("Access to sensitive files is not permitted");
    }
  });

  it("still refuses a new file whose spelling is blocked, wherever it lands", async () => {
    // Assets/node_modules -> Assets/Vendor: the real form names no secret, but
    // the spelling was refused before the real form was judged and still is.
    for (const [path, options] of [
      ["Assets/node_modules/new.js", {}],
      ["Assets/node_modules/pkg/new.js", allow],
    ] as const) {
      const result = await validatePath(root, path, options);
      expect(result.valid, path).toBe(false);
      expect(result.error, path).toBe("Access to sensitive files is not permitted");
    }
  });
});

// macOS's default volume ignores letter case; realpath(3) returns the case on
// disk while the JS realpathSync keeps the case it was given.
const caseInsensitive = existsSync(join(realParent, "PROJ"));

describe.skipIf(!caseInsensitive)("a root spelled in another letter case", () => {
  const otherCase = join(base, "link", "PROJ");

  it("projectRelativeTarget names the file validatePath lands on, so the layout wall judges it", async () => {
    for (const name of ["Old.cs", "New.cs"]) {
      const spelled = join(otherCase, "Assets", "Scripts", name);
      const result = await validatePath(root, spelled);
      expect(result.valid, spelled).toBe(true);
      expect(projectRelativeTarget(root, spelled), spelled).toBe(`Assets/Scripts/${name}`);
    }
  });
});
