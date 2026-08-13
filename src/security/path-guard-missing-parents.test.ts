/**
 * validatePath's allowMissingParents option.
 *
 * The guard walks up from a non-existent target to the deepest ancestor that
 * does exist, realpath's it, and confirms it sits inside the project root —
 * then threw that result away and returned "Parent directory does not exist"
 * regardless. The loop's own comment says the path "is valid (just missing
 * parent)"; the code disagreed with the comment.
 *
 * Measured cost: file_write could not create a file in a directory that did not
 * already exist. An agent asked to lay out a layered set of C# scripts made 42
 * write attempts, 38 were refused, and it ended up cramming 21 types into the
 * single file that happened to live in an existing directory.
 *
 * The option is opt-in so read paths keep their existing semantics, and these
 * tests exist mainly to prove the containment checks still hold — a guard that
 * gets more permissive has to be shown to still guard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePath } from "./path-guard.js";

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "guard-"));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(project, "Assets", "Scripts"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const allow = { allowMissingParents: true };

describe("allowMissingParents", () => {
  it("accepts a target several directories below an existing one", async () => {
    const result = await validatePath(project, "Assets/Scripts/PixelFlow/Core/Models/GameState.cs", allow);
    expect(result.valid).toBe(true);
    expect(result.fullPath).toBe(join(project, "Assets/Scripts/PixelFlow/Core/Models/GameState.cs"));
  });

  it("still rejects it without the option", async () => {
    // Read paths must keep the old behaviour — this is opt-in, not a loosening
    // of the guard for everyone.
    const result = await validatePath(project, "Assets/Scripts/New/Deep/File.cs");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Parent directory does not exist");
  });
});

describe("containment still holds with the option on", () => {
  it("rejects walking up out of the project", async () => {
    const result = await validatePath(project, "../../etc/pwned.txt", allow);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/outside the project/);
  });

  it("rejects a sibling directory", async () => {
    const result = await validatePath(project, "../outside/pwned.txt", allow);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/outside the project/);
  });

  it("rejects a deep path through a symlink that escapes", async () => {
    // The dangerous case for this change: every component below the symlink is
    // missing, so a naive "just allow missing parents" would skip the check
    // that catches it. The walk realpath's the symlink and rejects.
    symlinkSync(outside, join(project, "escape"));
    const result = await validatePath(project, "escape/new/deep/pwned.txt", allow);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/outside the project/);
  });

  it("rejects a path that climbs out mid-way", async () => {
    const result = await validatePath(project, "Assets/../../../pwned.txt", allow);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/outside the project/);
  });

  it("still rejects null bytes", async () => {
    const result = await validatePath(project, "Assets/bad\0.cs", allow);
    expect(result.valid).toBe(false);
  });
});
