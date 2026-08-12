/**
 * Characterization tests for the plugin execution boundary.
 *
 * The registry's module docstring used to state that "when sandboxing is
 * enabled, plugins run in worker_threads with restricted access based on their
 * declared permissions." None of that was true — `worker_threads` is imported
 * nowhere and `metadata.permissions` is read nowhere — so anyone reasoning
 * about plugin risk from the documentation reached the wrong conclusion.
 *
 * These tests pin the actual posture rather than the claimed one. They are
 * expected to FAIL the day a real sandbox lands, which is the point: that
 * change must update the security documentation in the same commit rather than
 * leaving a second generation of stale claims behind.
 */

import { describe, it, expect, vi } from "vitest";
import { isMainThread } from "node:worker_threads";
import { PluginRegistry, type Plugin, type PluginPermissions } from "./registry.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makePlugin(
  name: string,
  onInit: () => void,
  permissions?: PluginPermissions,
): Plugin {
  return {
    metadata: {
      name,
      version: "1.0.0",
      description: `test plugin ${name}`,
      capabilities: [],
      ...(permissions ? { permissions } : {}),
    },
    initialize: async () => onInit(),
    dispose: async () => {},
  };
}

describe("plugin execution boundary", () => {
  it("runs plugin code on the host's main thread, not in a worker", async () => {
    const registry = new PluginRegistry();
    let sawMainThread: boolean | undefined;
    let sawSameGlobal: boolean | undefined;

    // A marker only reachable if the plugin shares this realm.
    const marker = Symbol.for("strada.registry.test.marker");
    (globalThis as Record<symbol, unknown>)[marker] = "host";

    registry.register(
      makePlugin("probe", () => {
        sawMainThread = isMainThread;
        sawSameGlobal = (globalThis as Record<symbol, unknown>)[marker] === "host";
      }),
    );
    await registry.initializeAll();

    expect(sawMainThread, "plugin ran on the main thread").toBe(true);
    expect(sawSameGlobal, "plugin shares the host realm").toBe(true);

    delete (globalThis as Record<symbol, unknown>)[marker];
  });

  it("initializes a plugin that declares no permissions at all", async () => {
    // If permissions were enforced, a plugin declaring none would be the most
    // restricted case. It is not treated differently, because nothing reads it.
    const registry = new PluginRegistry();
    let ran = false;
    registry.register(makePlugin("bare", () => { ran = true; }));
    await registry.initializeAll();
    expect(ran).toBe(true);
  });

  it("does not restrict a plugin whose declared permissions contradict what it does", async () => {
    const registry = new PluginRegistry();
    let readTheFilesystem = false;

    registry.register(
      makePlugin(
        "overreaching",
        () => {
          // Declares no filesystem access, then reads a file anyway. Under a
          // real sandbox this would throw; here it simply works.
          const { existsSync } = require("node:fs") as typeof import("node:fs");
          readTheFilesystem = existsSync(__filename);
        },
        { filesystem: [], network: [], childProcess: false },
      ),
    );
    await registry.initializeAll();

    expect(readTheFilesystem, "declared permissions did not constrain the plugin").toBe(true);
  });
});
