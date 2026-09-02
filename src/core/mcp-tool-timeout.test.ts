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

/**
 * A call that loses the timeout race is abandoned, not cancelled: no
 * AbortSignal reaches Strada.MCP, so the underlying work keeps running while
 * "timed out" reads to the agent as "try again" and the retry overlaps it.
 *
 * The first attempt at this was rejected for three reasons, each of which is
 * an acceptance test below: the hold had no upper bound (a hung bridge
 * answered "still running — wait" for the lifetime of the process), the orphan
 * was a single shared flag (any concurrent call finishing cleared another
 * call's live orphan), and the refusal hard-coded a headless-editor/Library
 * lock claim onto every tool, including ones that launch no editor.
 */
describe("a timed-out call is still running (audited 2026-09-02)", () => {
  /** A tool whose first N calls never settle; later calls answer at once. */
  function hangingTool(name: string, timeoutMs: number, hangCalls = 1, laterCallMs = 0) {
    let calls = 0;
    return {
      name,
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      metadata: {
        category: "unity-runtime" as const,
        requiresBridge: false,
        dangerous: false,
        readOnly: true,
        timeoutMs,
      },
      execute: async () => {
        calls += 1;
        if (calls <= hangCalls) await new Promise(() => { /* never settles */ });
        if (laterCallMs > 0) await new Promise((r) => setTimeout(r, laterCallMs));
        return { content: "compiled", isError: false };
      },
    };
  }

  /** A tool whose first call settles late and whose later calls settle at once. */
  function slowThenFastTool(name: string, timeoutMs: number, firstCallMs: number) {
    let calls = 0;
    return {
      name,
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      metadata: {
        category: "unity-runtime" as const,
        requiresBridge: false,
        dangerous: false,
        readOnly: true,
        timeoutMs,
      },
      execute: async () => {
        calls += 1;
        if (calls === 1) await new Promise((r) => setTimeout(r, firstCallMs));
        return { content: "compiled", isError: false };
      },
    };
  }

  async function call(
    registry: ToolRegistry,
    name: string,
  ): Promise<{ content: string; isError?: boolean }> {
    const entry = (registry as unknown as { get(n: string): { execute: Function } }).get(name);
    const result = await entry.execute({}, {
      projectPath: "/proj",
      workingDirectory: "/proj",
      readOnly: false,
    });
    return {
      content: String((result as { content: unknown }).content),
      isError: (result as { isError?: boolean }).isError,
    };
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("says the call was not cancelled and refuses to overlap it while it is still out", async () => {
    vi.useRealTimers();
    const registry = registryWith(hangingTool("unity_verify_change", 60) as never);

    const first = await call(registry, "unity_verify_change");
    expect(first.isError).toBe(true);
    expect(first.content).toMatch(/timed out/);
    // The honest carriage: the work was abandoned, not stopped.
    expect(first.content).toMatch(/NOT cancelled/i);

    const second = await call(registry, "unity_verify_change");
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/previous 'unity_verify_change' call/);
    expect(second.content).toMatch(/has not returned yet/);
    expect(second.content).toMatch(/overlap/);
  });

  it("bounds the hold: a call that never returns stops blocking once the hold expires", async () => {
    // REJECTION 1: the first attempt held for the lifetime of the process, so a
    // permanently hung bridge disabled the tool until restart. The hold is a
    // time bound, and it says so rather than pretending the call came back.
    vi.useRealTimers();
    const registry = registryWith(hangingTool("unity_verify_change", 60) as never);

    const first = await call(registry, "unity_verify_change");
    expect(first.isError).toBe(true);

    const blocked = await call(registry, "unity_verify_change");
    expect(blocked.content).toMatch(/has not returned yet/);
    // The refusal names when it lifts instead of implying "forever".
    expect(blocked.content).toMatch(/hold expires|retry after/i);

    // Hold = timeoutMs past the timeout (≈2x the budget from the start), so it
    // has lapsed by 60 + 60 + margin even though call #1 never returned.
    await wait(200);
    const afterExpiry = await call(registry, "unity_verify_change");
    expect(afterExpiry.content).not.toMatch(/has not returned yet/);
    expect(afterExpiry.isError).toBe(false);
    expect(afterExpiry.content).toBe("compiled");
  });

  it("keeps one call's orphan when a different concurrent call of the same tool finishes", async () => {
    // REJECTION 2: the orphan was one shared flag on the adapter, so the
    // concurrent call settling cleared the timed-out call's live orphan and the
    // relaunch went through on top of it.
    vi.useRealTimers();
    // Call #1 never returns. Call #2 starts alongside it and settles at 240ms,
    // after both have lost the race at 200ms and while #1's hold (to ≈400ms)
    // is still live.
    const registry = registryWith(hangingTool("unity_verify_change", 200, 1, 240) as never);

    const [hung, concurrent] = await Promise.all([
      call(registry, "unity_verify_change"),
      call(registry, "unity_verify_change"),
    ]);
    expect(hung.isError).toBe(true);
    expect(hung.content).toMatch(/timed out/);
    expect(concurrent.isError).toBe(true);

    await wait(100); // t≈300ms: call #2's promise has settled, call #1's has not
    const third = await call(registry, "unity_verify_change");
    expect(third.content).toMatch(/has not returned yet/);
  });

  it("clears only the matching call: the tool is usable again as soon as its own call returns", async () => {
    vi.useRealTimers();
    // Timeout at 300ms, the call returns at 400ms, the hold would only lapse at
    // ≈600ms — so a pass at t≈470ms is the settlement clearing it, not the clock.
    const registry = registryWith(slowThenFastTool("unity_verify_change", 300, 400) as never);

    const first = await call(registry, "unity_verify_change");
    expect(first.isError).toBe(true);

    await wait(170); // t≈470ms: call #1's own promise has settled, its hold has not lapsed
    const second = await call(registry, "unity_verify_change");
    expect(second.isError).toBe(false);
    expect(second.content).toBe("compiled");
  });

  it("does not invent a headless editor for a tool that launches none", async () => {
    // REJECTION 3: every refusal claimed "a headless editor it launched still
    // holds the project's Library lock" — a fabricated cause for a git or file
    // tool. Only tools that actually drive one may say so.
    vi.useRealTimers();
    const registry = registryWith(hangingTool("git_log_slow", 50) as never);

    const first = await call(registry, "git_log_slow");
    expect(first.content).not.toMatch(/Library|editor/i);

    const second = await call(registry, "git_log_slow");
    expect(second.content).toMatch(/previous 'git_log_slow' call/);
    expect(second.content).not.toMatch(/Library|editor/i);
  });

  it("still names the editor for a tool that is known to drive one", async () => {
    vi.useRealTimers();
    const registry = registryWith(hangingTool("unity_verify_change", 50) as never);

    await call(registry, "unity_verify_change");
    const second = await call(registry, "unity_verify_change");
    expect(second.content).toMatch(/Library lock/);
  });
});
