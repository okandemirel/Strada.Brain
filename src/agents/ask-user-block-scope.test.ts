/**
 * The clarification loop-breaker counts within ONE run, not across a chat.
 *
 * audited 2026-09-02: `askUserBlockCounts` was keyed by chatId alone. The
 * counter is only cleared when an ask_user actually reaches the user (or a
 * later non-ask_user tool succeeds), so a run that ends while holding two
 * blocks left its "loop" verdict behind on the chat: the NEXT run's very first
 * clarification was waved straight through un-reviewed, on evidence collected
 * about a different run. Two runs sharing a chatId (the supervisor's nodes all
 * do) also spent one another's budget. The breaker for tool errors already
 * scopes to the active taskRunId; this counter now uses the same scope.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { AgentPhase } from "./agent-state.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const CHAT = "chat-ask-user";

function askUserTool() {
  return {
    name: "ask_user",
    description: "ask_user",
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: true },
    execute: vi.fn().mockResolvedValue({ content: "REACHED THE USER", isError: false }),
  };
}

function makeOrchestrator(tool: ReturnType<typeof askUserTool>) {
  const orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [tool] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/ask-user-scope-test",
    readOnly: false,
    requireConfirmation: false,
  });
  // The clarification reviewer itself is not under test: it always says "you can
  // answer this yourself", which is exactly the verdict the counter counts.
  (
    orch as unknown as {
      resolveAskUserClarificationIntervention: () => Promise<unknown>;
    }
  ).resolveAskUserClarificationIntervention = vi
    .fn()
    .mockResolvedValue({ kind: "continue", gate: "BLOCKED: answer it yourself" });
  return orch;
}

const ask = (orch: Orchestrator, id: string) =>
  (
    orch as unknown as {
      executeToolCalls: (
        c: string,
        t: unknown[],
        o: unknown,
      ) => Promise<Array<{ content: string }>>;
    }
  ).executeToolCalls(CHAT, [{ id, name: "ask_user", input: { question: "which one?" } }], {
    mode: "interactive",
    taskPrompt: "build the thing",
    identityKey: "identity-1",
    agentState: { phase: AgentPhase.EXECUTING },
  });

const inRun = <T>(orch: Orchestrator, taskRunId: string, run: () => Promise<T>) =>
  orch.withTaskExecutionContext({ chatId: CHAT, taskRunId, identityKey: "identity-1" }, run);

const blocked = (content: string) => content.startsWith("BLOCKED:");

describe("ask_user clarification loop-breaker scope", () => {
  it("a run that ended holding two blocks does not spend the next run's budget", async () => {
    const tool = askUserTool();
    const orch = makeOrchestrator(tool);

    await inRun(orch, "run-a", async () => {
      for (const id of ["a1", "a2"]) {
        const [r] = await ask(orch, id);
        expect(blocked(r?.content ?? ""), `run A ${id} should have been blocked`).toBe(true);
      }
    });
    expect(tool.execute, "run A never reached the user").not.toHaveBeenCalled();

    const [first] = await inRun(orch, "run-b", () => ask(orch, "b1"));
    expect(
      blocked(first?.content ?? ""),
      "run B's FIRST question was waved through on run A's block count",
    ).toBe(true);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("two interleaved runs on one chat each get their own two blocks", async () => {
    const tool = askUserTool();
    const orch = makeOrchestrator(tool);

    const results: string[] = [];
    for (const id of ["1", "2"]) {
      for (const run of ["run-a", "run-b"]) {
        const [r] = await inRun(orch, run, () => ask(orch, `${run}-${id}`));
        results.push(r?.content ?? "");
      }
    }

    expect(results.every(blocked), "an interleaved sibling run consumed the other's budget").toBe(
      true,
    );
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("the breaker still fires on the third block inside one run", async () => {
    const tool = askUserTool();
    const orch = makeOrchestrator(tool);

    const contents = await inRun(orch, "run-c", async () => {
      const out: string[] = [];
      for (const id of ["c1", "c2", "c3"]) {
        const [r] = await ask(orch, id);
        out.push(r?.content ?? "");
      }
      return out;
    });

    expect(contents.slice(0, 2).every(blocked)).toBe(true);
    expect(contents[2]).toBe("REACHED THE USER");
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("an expired session takes its run-scoped counters with it", async () => {
    const tool = askUserTool();
    const orch = makeOrchestrator(tool);

    await inRun(orch, "run-d", () => ask(orch, "d1"));
    const counts = (orch as unknown as { askUserBlockCounts: Map<string, number> })
      .askUserBlockCounts;
    expect(counts.size, "the block was not recorded at all").toBe(1);

    const sessions = (
      orch as unknown as { sessionManager: { sessions: Map<string, { lastActivity: Date }> } }
    ).sessionManager.sessions;
    sessions.set(CHAT, { lastActivity: new Date(Date.now() - 10 * 3_600_000) } as never);
    orch.cleanupSessions(3_600_000);

    expect([...counts.keys()], "the run-scoped key outlived the conversation").toEqual([]);
  });

  it("outside a run the counter is still the conversation's", async () => {
    const tool = askUserTool();
    const orch = makeOrchestrator(tool);

    const contents: string[] = [];
    for (const id of ["n1", "n2", "n3"]) {
      const [r] = await ask(orch, id);
      contents.push(r?.content ?? "");
    }

    expect(contents.slice(0, 2).every(blocked)).toBe(true);
    expect(contents[2]).toBe("REACHED THE USER");
  });
});
