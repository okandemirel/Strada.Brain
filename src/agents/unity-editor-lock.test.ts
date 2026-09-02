/**
 * One editor, one project, one caller at a time.
 *
 * audited 2026-09-02: isParallelSafeToolCall keeps the Unity verification tools
 * out of the LEADING parallel group, which only orders calls WITHIN one model
 * turn. Two TASKS — two sub-agents, two Orchestrator instances, two supervisor
 * nodes — run their turns concurrently, so two unity_verify_change calls could
 * be in the editor at once: each restarts the other's compile and reads the
 * other's console, and both verdicts then describe code neither call compiled.
 * The lock is process-wide and it QUEUES; nothing is refused for being second.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

/** A tool that reports when it entered and left the editor, and holds it open. */
function editorTool(name: string, log: string[]) {
  let releaseCurrent: (() => void) | null = null;
  return {
    tool: {
      name,
      description: name,
      inputSchema: { type: "object" as const, properties: {} },
      metadata: { readOnly: true },
      execute: vi.fn(async (input: Record<string, unknown>) => {
        const tag = String(input["tag"]);
        log.push(`enter:${tag}`);
        await new Promise<void>((resolve) => {
          releaseCurrent = () => {
            log.push(`leave:${tag}`);
            resolve();
          };
        });
        return { content: `verified ${tag}`, isError: false };
      }),
    },
    release: () => {
      const r = releaseCurrent;
      releaseCurrent = null;
      r?.();
    },
  };
}

function orchestratorWith(tool: { name: string }) {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [tool] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/unity-editor-lock-test",
    readOnly: false,
    requireConfirmation: false,
  });
}

const call = (orch: Orchestrator, name: string, tag: string) =>
  (
    orch as unknown as {
      executeToolCalls: (c: string, t: unknown[], o: unknown) => Promise<Array<{ content: string }>>;
    }
  ).executeToolCalls(`chat-${tag}`, [{ id: `tc-${tag}`, name, input: { tag } }], {
    mode: "background",
  });

/** Let every already-queued microtask/timer callback run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("unity editor lock", () => {
  it("a second unity_verify_change waits for the first to finish, then runs", async () => {
    const log: string[] = [];
    const a = editorTool("unity_verify_change", log);
    const b = editorTool("unity_verify_change", log);
    // Two TASKS: separate Orchestrator instances, one editor between them.
    const orchA = orchestratorWith(a.tool);
    const orchB = orchestratorWith(b.tool);

    const first = call(orchA, "unity_verify_change", "A");
    await settle();
    const second = call(orchB, "unity_verify_change", "B");
    await settle();

    expect(log, "both calls were in the editor at once").toEqual(["enter:A"]);
    expect(b.tool.execute).not.toHaveBeenCalled();

    a.release();
    await settle();
    expect(log).toEqual(["enter:A", "leave:A", "enter:B"]);

    b.release();
    const [[resA], [resB]] = await Promise.all([first, second]);
    expect(resA?.content).toBe("verified A");
    expect(resB?.content, "the second call was refused instead of queued").toBe("verified B");
    expect(log).toEqual(["enter:A", "leave:A", "enter:B", "leave:B"]);
  });

  it("a failing holder releases the editor to the next caller", async () => {
    const log: string[] = [];
    const boom = {
      name: "unity_compile_check",
      description: "unity_compile_check",
      inputSchema: { type: "object" as const, properties: {} },
      metadata: { readOnly: true },
      execute: vi.fn(async () => {
        log.push("enter:boom");
        throw new Error("editor crashed");
      }),
    };
    const next = editorTool("unity_compile_check", log);
    const orchA = orchestratorWith(boom);
    const orchB = orchestratorWith(next.tool);

    const first = call(orchA, "unity_compile_check", "boom");
    const second = call(orchB, "unity_compile_check", "N");
    await settle();

    expect(log, "the crash left the lock held forever").toEqual(["enter:boom", "enter:N"]);
    next.release();
    const [[resFirst], [resNext]] = await Promise.all([first, second]);
    expect(resFirst?.content).toContain("editor crashed");
    expect(resNext?.content).toBe("verified N");
  });

  it("a non-editor tool is not queued behind the editor", async () => {
    const log: string[] = [];
    const held = editorTool("unity_playmode_verify", log);
    const reader = {
      name: "file_read",
      description: "file_read",
      inputSchema: { type: "object" as const, properties: {} },
      metadata: { readOnly: true },
      execute: vi.fn().mockResolvedValue({ content: "file body", isError: false }),
    };
    const orchA = orchestratorWith(held.tool);
    const orchB = orchestratorWith(reader);

    const first = call(orchA, "unity_playmode_verify", "P");
    await settle();
    const [read] = await call(orchB, "file_read", "R");
    expect(read?.content).toBe("file body");

    held.release();
    await first;
  });
});
