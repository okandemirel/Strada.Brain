import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMemoryDbPath } from "./config.js";

/**
 * WHERE THE STORES LIVE WHEN AN OPERATOR NAMES A HOME. `MEMORY_DB_PATH`
 * defaults to a RELATIVE `.strada-memory`, so a run started with an explicit
 * STRADA_HOME wrote its campaigns, tasks, goals and learning into whatever
 * directory it was launched from. Measured 2026-10-14: a proof run pointed at
 * a fresh home put its campaign in `<cwd>/.strada-memory` and read nothing of
 * the home it was given.
 */
describe("resolveMemoryDbPath", () => {
  const cwd = "/work/checkout";

  it("puts the stores under an explicit home when the working directory holds none", () => {
    expect(resolveMemoryDbPath(undefined, { STRADA_HOME: "/srv/run-home" }, cwd)).toEqual({
      path: join("/srv/run-home", ".strada-memory"),
    });
  });

  it("keeps a store the working directory already holds, and says which it kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-legacy-"));
    mkdirSync(join(dir, ".strada-memory"));
    try {
      expect(resolveMemoryDbPath(undefined, { STRADA_HOME: "/srv/run-home" }, dir)).toEqual({
        path: join(dir, ".strada-memory"),
        legacyKept: join("/srv/run-home", ".strada-memory"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an installation with no home set exactly as it was", () => {
    expect(resolveMemoryDbPath(undefined, {}, cwd)).toEqual({ path: ".strada-memory" });
  });

  it("never overrides a path the operator named", () => {
    expect(resolveMemoryDbPath("/var/lib/strada/db", { STRADA_HOME: "/srv/run-home" }, cwd)).toEqual({
      path: "/var/lib/strada/db",
    });
    expect(resolveMemoryDbPath("state/db", { STRADA_HOME: "/srv/run-home" }, cwd)).toEqual({ path: "state/db" });
  });
});
