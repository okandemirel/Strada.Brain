/**
 * What AgentCore says reaches a person, and what it puts off comes back whole.
 *
 * Audit agent-core-goals#2: notify/escalate went to chat id "agent-core", which no
 * channel owns — a web primary buffered it for a socket that never connects, a
 * Telegram primary refused it — and the batch counted as handled.
 * Audit agent-core-goals#3: "defer" (and a notify/escalate put off during a
 * foreground task) re-queued only the top observation; every other observation
 * collected with it was destroyed, and a latched observer never reports it again.
 * Audit agent-core-goals#7: the UserActivityObserver was never told about activity.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCore } from "./agent-core.js";
import { ObservationEngine } from "./observation-engine.js";
import { PriorityScorer } from "./priority-scorer.js";
import { createObservation, type AgentObservation } from "./observation-types.js";
import { UserActivityObserver } from "./observers/user-activity-observer.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

function llm(json: Record<string, unknown>) {
  return { text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, toolCalls: [], stopReason: "end_turn" };
}

function setup(decision: Record<string, unknown>, opts: { observations?: AgentObservation[]; foreground?: number } = {}) {
  const engine = new ObservationEngine();
  const first = opts.observations ?? [createObservation("build", "Build failed with 3 pending file(s)", { priority: 85 })];
  let collected = 0;
  // A latched observer: it reports once, like BuildStateObserver and the task-outcome injection.
  engine.register({ name: "once", collect: () => (collected++ === 0 ? first : []) });
  const provider = { chat: vi.fn().mockResolvedValue(llm(decision)) };
  const taskManager = {
    submit: vi.fn().mockReturnValue({ id: "task_1" }),
    listTasks: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(null),
    countActiveForegroundTasks: vi.fn().mockReturnValue(opts.foreground ?? 0),
  };
  const channel = { sendText: vi.fn().mockResolvedValue(undefined) };
  const budget = { getUsage: () => ({ usedUsd: 1, limitUsd: 10, pct: 0.1 }) };
  const core = new AgentCore(engine, new PriorityScorer(), provider as never, taskManager as never, channel as never, budget, undefined, {
    minReasoningIntervalMs: 0, minObservationPriority: 30, budgetFloorPct: 10,
  });
  return { engine, core, channel, provider };
}

const twoFailures = () => [
  createObservation("build", "Build failed with 3 pending file(s)", { priority: 85 }),
  createObservation("task-outcome", "Agent task failed: Fix SaveGame", { priority: 70 }),
];

afterEach(() => {
  vi.useRealTimers();
});

describe("notify/escalate reach the operator's chat (agent-core-goals#2)", () => {
  it("notify goes to the chat the user last wrote from, never to the unowned 'agent-core' id", async () => {
    const { core, channel } = setup({ action: "notify", message: "Build is red again", reasoning: "tell them" });
    core.onUserActivity("chat-42");
    await core.tick();
    expect(channel.sendText).toHaveBeenCalledWith("chat-42", "Build is red again");
    expect(channel.sendText).not.toHaveBeenCalledWith("agent-core", expect.anything());
  });

  it("escalate goes to the operator's chat with its prefix", async () => {
    const { core, channel } = setup({ action: "escalate", question: "Deploy now?", reasoning: "need input" });
    core.onUserActivity("chat-42");
    await core.tick();
    expect(channel.sendText).toHaveBeenCalledWith("chat-42", "[Agent needs input] Deploy now?");
  });

  it("with no chat known yet the question is held, not sent into the void, and delivered once one is", async () => {
    const { core, channel, provider } = setup({ action: "escalate", question: "Deploy now?", reasoning: "need input" });
    await core.tick();
    expect(channel.sendText).not.toHaveBeenCalled();

    core.onUserActivity("chat-7");
    provider.chat.mockClear();
    await core.tick();
    expect(channel.sendText).toHaveBeenCalledWith("chat-7", "[Agent needs input] Deploy now?");
    // Delivering what was already decided costs no second reasoning call.
    expect(provider.chat).not.toHaveBeenCalled();

    channel.sendText.mockClear();
    await core.tick();
    expect(channel.sendText).not.toHaveBeenCalled(); // delivered once
  });
});

describe("a deferral keeps the whole batch (agent-core-goals#3)", () => {
  it("defer keeps every actionable observation collected with the top one", async () => {
    const { engine, core } = setup({ action: "defer", deferMinutes: 15, reasoning: "later" }, { observations: twoFailures() });
    await core.tick();
    expect(engine.getDeferredCount()).toBe(2);
  });

  it("a notify put off for a foreground task keeps the rest of the batch too", async () => {
    const { engine, core, channel } = setup(
      { action: "notify", message: "two things broke", reasoning: "tell them" },
      { observations: twoFailures(), foreground: 1 },
    );
    await core.tick();
    expect(channel.sendText).not.toHaveBeenCalled();
    expect(engine.getDeferredCount()).toBe(2);
  });

  it("an escalate put off for a foreground task keeps the rest of the batch too", async () => {
    const { engine, core } = setup(
      { action: "escalate", question: "which first?", reasoning: "ask" },
      { observations: twoFailures(), foreground: 1 },
    );
    await core.tick();
    expect(engine.getDeferredCount()).toBe(2);
  });
});

describe("user activity reaches the UserActivityObserver (agent-core-goals#7)", () => {
  it("every message ingress hands the heartbeat the chat it came from", () => {
    // The multi-agent path in bootstrap.ts has no unit seam; a bare call there would leave
    // AgentCore with no operator chat on that path only.
    for (const file of ["src/core/bootstrap.ts", "src/core/bootstrap-wiring.ts"]) {
      const calls = readFileSync(file, "utf8").match(/\.onUserActivity\([^)]*\)/g) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, file).toBe(".onUserActivity(normalizedMsg.chatId)");
    }
  });

  it("a message after an idle spell is seen as the user returning", () => {
    vi.useFakeTimers();
    const { engine, core } = setup({ action: "wait", reasoning: "-" }, { observations: [] });
    engine.register(new UserActivityObserver(60_000));
    vi.advanceTimersByTime(61_000);
    expect(engine.collect().map((o) => o.summary).join("|")).toContain("idle");

    core.onUserActivity("chat-1");
    expect(engine.collect().map((o) => o.summary).join("|")).toContain("returned");
  });
});
