/**
 * allowedPaths for Strada.MCP tools must follow the project the call runs
 * against.
 *
 * The MCP tool context takes `projectPath` per call but froze `allowedPaths` at
 * bootstrap from config.unityProjectPath. A task running inside a workspace
 * lease gets projectPath = <tmp>/strada-workspaces/task-<id>/, so MCP's file
 * tools resolved the write correctly inside the lease and then rejected it:
 * "Path is outside allowed paths".
 *
 * Measured on a greenfield run: every batched file_write failed this way.
 * Brain's own file_write does not consult allowedPaths, so some writes in the
 * same run landed and others did not — invisible until batch_execute started
 * reporting inner failures.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";

// The helper is module-private; exercise it through the shape it guards.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching a module-private helper
const loader = (await import("./strada-mcp-tool-loader.js")) as any;

/** Mirrors resolveAllowedPaths' contract; kept here so the test states it. */
function resolveAllowedPaths(configured: string[] | undefined, projectPath: string) {
  return loader.__testResolveAllowedPaths
    ? loader.__testResolveAllowedPaths(configured, projectPath)
    : undefined;
}

const PROJECT = join("/", "Users", "dev", "MyGame");
const LEASE = join("/", "tmp", "strada-workspaces", "task-abc");

describe("resolveAllowedPaths", () => {
  it("adds the lease path when the configured list does not cover it", () => {
    const result = resolveAllowedPaths([PROJECT], LEASE);
    expect(result).toEqual([PROJECT, LEASE]);
  });

  it("leaves the list untouched when it already covers the call", () => {
    // Normal operation: no lease, projectPath is the configured project.
    expect(resolveAllowedPaths([PROJECT], PROJECT)).toEqual([PROJECT]);
    expect(resolveAllowedPaths([PROJECT], join(PROJECT, "Assets"))).toEqual([PROJECT]);
  });

  it("keeps an unrestricted configuration unrestricted", () => {
    // An empty list means "no additional restriction" to MCP's isPathAllowed;
    // turning it into a one-entry list would silently start restricting.
    expect(resolveAllowedPaths([], LEASE)).toEqual([]);
    expect(resolveAllowedPaths(undefined, LEASE)).toBeUndefined();
  });

  it("preserves a deliberately narrowed configuration", () => {
    // A deployment that restricts below the project root keeps that
    // restriction; only the otherwise-unreachable lease is added.
    const narrowed = [join(PROJECT, "Assets", "Scripts")];
    expect(resolveAllowedPaths(narrowed, join(PROJECT, "Assets", "Scripts", "Sub"))).toEqual(narrowed);
    expect(resolveAllowedPaths(narrowed, LEASE)).toEqual([...narrowed, LEASE]);
  });
});
