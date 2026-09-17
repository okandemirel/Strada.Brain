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
import { PluginRegistry, partitionDependencyGraph, type Plugin, type PluginPermissions } from "./registry.js";

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

// ---------------------------------------------------------------------------
// plan 0-B.2 (audit R1/D67 + R2 + Codex #3): initializeAll must never abort
// the batch because one plugin's dependency is missing or cyclic.
// ---------------------------------------------------------------------------
describe("initializeAll resilience (plan 0-B.2)", () => {
  function depPlugin(name: string, deps: string[], onInit: () => void = () => {}): Plugin {
    const p = makePlugin(name, onInit);
    p.metadata.dependencies = deps;
    return p;
  }

  it("initialises what can be initialised and records a reason for the rest", async () => {
    const registry = new PluginRegistry();
    const ran: string[] = [];
    registry.register(depPlugin("a", ["missing"], () => ran.push("a")));
    registry.register(depPlugin("c1", ["c2"], () => ran.push("c1")));
    registry.register(depPlugin("c2", ["c1"], () => ran.push("c2")));
    registry.register(depPlugin("dep-on-a", ["a"], () => ran.push("dep-on-a")));
    registry.register(depPlugin("ok", [], () => ran.push("ok")));
    registry.register(depPlugin("ok2", ["ok"], () => ran.push("ok2")));

    await expect(registry.initializeAll()).resolves.toBeUndefined();

    expect(ran).toEqual(["ok", "ok2"]);
    expect(registry.isInitialized("ok")).toBe(true);
    expect(registry.isInitialized("ok2")).toBe(true);
    expect(registry.getInitializationError("a")).toContain("'missing'");
    expect(registry.getInitializationError("c1")).toContain("circular");
    expect(registry.getInitializationError("c2")).toContain("circular");
    expect(registry.getInitializationError("dep-on-a")).toContain("'a'");
    expect(registry.getInitializationError("ok")).toBeUndefined();
  });

  it("a plugin whose dependency's initialize() threw is not initialised, and says why", async () => {
    const registry = new PluginRegistry();
    registry.register(depPlugin("base", [], () => { throw new Error("base broke"); }));
    const ran: string[] = [];
    registry.register(depPlugin("top", ["base"], () => ran.push("top")));
    await registry.initializeAll();
    expect(ran).toEqual([]);
    expect(registry.getInitializationError("base")).toBe("base broke");
    expect(registry.getInitializationError("top")).toContain("'base' failed to initialize");
  });

  it("disposeAll still runs when an unresolvable plugin is registered", async () => {
    const registry = new PluginRegistry();
    let disposed = false;
    const ok = depPlugin("ok", []);
    ok.dispose = async () => { disposed = true; };
    registry.register(ok);
    registry.register(depPlugin("orphan", ["missing"]));
    await registry.initializeAll();
    await expect(registry.disposeAll()).resolves.toBeUndefined();
    expect(disposed).toBe(true);
  });

  it("resolveDependencies keeps throwing on a missing dependency (explicit single-plugin contract)", () => {
    const registry = new PluginRegistry();
    registry.register(depPlugin("a", ["missing"]));
    expect(() => registry.resolveDependencies("a")).toThrow(/missing/);
  });
});

describe("partitionDependencyGraph", () => {
  // Codex round 6 #10 (2026-09-17): a scalar dependency list is validated
  // per node instead of throwing for the whole graph.
  it("a node whose dependency list is not an array is unresolvable alone, with the reason; the rest is judged normally", () => {
    const graph = new Map<string, unknown>([["A", ["B"]], ["B", []], ["S", "missing"], ["T", ["S"]], ["N", [1]]]);
    const { order, unresolvable } = partitionDependencyGraph(graph);
    expect([...order].sort()).toEqual(["A", "B"]);
    expect(unresolvable.get("S")).toContain("must be an array");
    expect(unresolvable.get("S")).toContain('"missing"');
    expect(unresolvable.get("T")).toContain("'S'");
    expect(unresolvable.get("N")).toContain("skill names");
  });

  it("initializeAll: a plugin with a scalar dependency list is recorded as failed, the others initialise", async () => {
    const registry = new PluginRegistry();
    const seen: string[] = [];
    const scalar = makePlugin("S", () => seen.push("S"));
    (scalar.metadata as { dependencies?: unknown }).dependencies = "missing";
    registry.register(scalar);
    registry.register(makePlugin("A", () => seen.push("A")));
    await registry.initializeAll();
    expect(seen).toEqual(["A"]);
    expect(registry.isInitialized("S")).toBe(false);
    expect(registry.getInitializationError("S")).toContain("must be an array");
  });

  it("is order-independent: the same verdicts whichever way the nodes are listed", () => {
    const forward = new Map<string, string[]>([["A", ["B"]], ["B", []], ["X", ["Nope"]], ["Y", ["X"]]]);
    const backward = new Map<string, string[]>([...forward.entries()].reverse());
    for (const graph of [forward, backward]) {
      const { order, unresolvable } = partitionDependencyGraph(graph);
      expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
      expect([...order].sort()).toEqual(["A", "B"]);
      expect([...unresolvable.keys()].sort()).toEqual(["X", "Y"]);
      expect(unresolvable.get("X")).toContain("'Nope'");
      expect(unresolvable.get("Y")).toContain("'X'");
    }
  });
});
