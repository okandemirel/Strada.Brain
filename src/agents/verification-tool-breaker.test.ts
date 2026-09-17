/**
 * A tool whose job is to report failure must not be disabled for reporting it.
 *
 * Measured on a live run: unity_verify_change ran its headless compile three
 * times, each time correctly reporting that the project had 27 compile errors,
 * and the circuit breaker took it away from the conversation as unreliable. The
 * agent was then writing C# with no way to learn whether it compiles — exactly
 * the state that tool exists to prevent, produced by the safeguard meant to keep
 * the run healthy.
 *
 * For a verification tool, isError means "the verification failed", not "the
 * tool failed".
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => { createLogger("error", "test.log"); });

function tool(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: true },
    execute: vi.fn().mockResolvedValue({ content: "compile failed: 27 errors", isError: true }),
  };
}

function orchestratorWith(...names: string[]) {
  const tools = names.map(tool);
  const orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: tools as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/breaker-test",
    readOnly: false,
    requireConfirmation: false,
  });
  return { orch, tools };
}

const callFourTimes = async (orch: Orchestrator, name: string): Promise<string[]> => {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [r] = await (
      orch as unknown as {
        executeToolCalls: (c: string, t: unknown[], o: unknown) => Promise<Array<{ content: string }>>;
      }
    ).executeToolCalls("chat1", [{ id: `t${i}`, name, input: {} }], { mode: "background" });
    out.push(r?.content ?? "");
  }
  return out;
};

const callFourTimesWith = async (orch: Orchestrator, name: string, input: Record<string, unknown>): Promise<string[]> => {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const [r] = await (
      orch as unknown as {
        executeToolCalls: (c: string, t: unknown[], o: unknown) => Promise<Array<{ content: string }>>;
      }
    ).executeToolCalls("chat1", [{ id: `s${i}`, name, input }], { mode: "background" });
    out.push(r?.content ?? "");
  }
  return out;
};

describe("the consecutive-failure breaker", () => {
  it("keeps shell_exec available when the shell RAN the tests and they were red (Codex 2026-09-17)", async () => {
    // Since shell_exec reports a non-zero exit as isError, three failing
    // `npm test` runs took the shell away for sixty seconds while dotnet_test
    // stayed exempt. The verdict is the tests', not the tool's.
    const { orch, tools } = orchestratorWith("shell_exec");
    tools[0]!.metadata = { readOnly: false } as never;
    tools[0]!.execute = vi.fn().mockResolvedValue({ content: "Tests: 3 failed, 40 passed\nExit code: 1", isError: true });

    const results = await callFourTimesWith(orch, "shell_exec", { command: "npm test" });

    expect(tools[0]!.execute).toHaveBeenCalledTimes(4);
    expect(results.every((r) => !r.includes("temporarily disabled"))).toBe(true);
  });

  it("…but a shell command that is not a verifier still trips it", async () => {
    const { orch, tools } = orchestratorWith("shell_exec");
    tools[0]!.metadata = { readOnly: false } as never;
    tools[0]!.execute = vi.fn().mockResolvedValue({ content: "ls: cannot access 'nope': No such file\nExit code: 2", isError: true });

    const results = await callFourTimesWith(orch, "shell_exec", { command: "ls nope" });

    expect(tools[0]!.execute).toHaveBeenCalledTimes(3);
    expect(results[3]).toContain("temporarily disabled");
  });

  it("keeps a verification tool available however often it reports failure", async () => {
    const { orch, tools } = orchestratorWith("unity_verify_change");

    const results = await callFourTimes(orch, "unity_verify_change");

    expect(tools[0]!.execute).toHaveBeenCalledTimes(4);
    expect(results.every((r) => !r.includes("temporarily disabled"))).toBe(true);
  });

  it("still disables an ordinary tool that keeps failing", async () => {
    // The safeguard is right for a tool that is simply broken.
    const { orch, tools } = orchestratorWith("some_flaky_tool");

    const results = await callFourTimes(orch, "some_flaky_tool");

    expect(results.some((r) => r.includes("temporarily disabled"))).toBe(true);
    expect(tools[0]!.execute.mock.calls.length).toBeLessThan(4);
  });
});
