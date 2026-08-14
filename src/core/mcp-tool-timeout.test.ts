/**
 * A tool that says it needs minutes must be given minutes.
 *
 * Hosts cap tool calls so a stuck tool cannot hang an agent, and 30s suits
 * tools that answer in seconds. It does not suit one that compiles a Unity
 * project headlessly.
 *
 * Measured: once unity_verify_change was finally offered to the agent — it had
 * been hidden while the editor was closed — it was called three times and
 * killed at 30002ms on every call. The offline verification the tool exists for
 * never once completed, and the agent was left with the same "cannot verify"
 * answer as before, now costing 90 seconds to produce.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLogger } from "../utils/logger.js";
import { ToolRegistry } from "./tool-registry.js";
import { registerStradaMcpTools } from "./strada-mcp-tool-loader.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

/** A tool that takes longer than the default cap to answer. */
function slowTool(name: string, timeoutMs?: number) {
  return {
    name,
    description: "test",
    inputSchema: { type: "object" as const, properties: {} },
    metadata: {
      category: "unity-runtime" as const,
      requiresBridge: false,
      dangerous: false,
      readOnly: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    execute: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { content: "compiled", isError: false };
    },
  };
}

function registryWith(tool: ReturnType<typeof slowTool>): ToolRegistry {
  const registry = new ToolRegistry();
  registerStradaMcpTools(registry as never, [tool] as never);
  return registry;
}

async function runTool(registry: ToolRegistry, name: string): Promise<string> {
  const entry = (registry as unknown as { get(n: string): { execute: Function } }).get(name);
  const result = await entry.execute({}, {
    projectPath: "/proj",
    workingDirectory: "/proj",
    readOnly: false,
  });
  return String((result as { content: unknown }).content);
}

describe("declared tool timeouts", () => {
  it("gives a tool the budget its metadata asks for", async () => {
    // 50ms of work under a 5000ms declared budget: it must finish, not be cut off.
    vi.useRealTimers();
    const registry = registryWith(slowTool("unity_verify_change", 5_000));

    await expect(runTool(registry, "unity_verify_change")).resolves.toContain("compiled");
  });

  it("still caps a tool that declares nothing", async () => {
    // The default has to stay in force, or one hung tool hangs the agent.
    const registry = registryWith(slowTool("ordinary_tool"));
    const entry = (
      registry as unknown as { get(n: string): { timeoutMs?: number } }
    ).get("ordinary_tool") as unknown as { timeoutMs?: number };

    // The adapter keeps its own copy; an undeclared tool must not inherit a
    // long one from a neighbour.
    const declared = (entry as unknown as Record<string, unknown>)["timeoutMs"];
    expect(declared === undefined || declared === 30_000).toBe(true);
  });

  it("passes the declared value through rather than a fixed constant", async () => {
    const registry = registryWith(slowTool("unity_verify_change", 360_000));
    const entry = (registry as unknown as { get(n: string): unknown }).get(
      "unity_verify_change",
    ) as Record<string, unknown>;

    expect(entry["timeoutMs"]).toBe(360_000);
  });
});
