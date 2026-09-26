/**
 * Where the "the user named this file" read authorization may come from.
 *
 * Only from text a person sent through a channel. A delegated or decomposed run's
 * prompt is written by a model, and a session's latest user-role turn is often a
 * gate or tool-failure message the run built itself; neither may widen what the
 * run can read. Tests drive the real tool context executeToolCalls builds.
 */

import { resolve } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { extractUserAuthorizedPaths } from "../security/user-authorized-paths.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: () => ({ content: "", contentHashes: [], summary: "", fingerprint: "" }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "",
  buildToolUsageHints: () => "",
}));

const OUTSIDE = "/tmp/strada-outside/other-repo/config.yaml";
const NAMED_BY_USER = "/tmp/strada-outside/PixelFlow_GDD.docx";
/** What extraction keeps: the resolved path (on Windows, on the current drive). */
const AUTHORIZED = resolve(NAMED_BY_USER);

interface ToolCallsHost {
  executeToolCalls(chatId: string, calls: unknown[], opts: unknown): Promise<unknown[]>;
  sessionManager: {
    getOrCreateSession(chatId: string): { messages: Array<{ role: string; content: unknown }> };
  };
}

function buildOrchestrator(seen: Array<readonly string[] | undefined>, store?: Map<string, readonly string[]>) {
  const probe = {
    name: "probe_context",
    description: "Records the tool context it was called with",
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(async (_input: unknown, context: { userAuthorizedPaths?: readonly string[] }) => {
      seen.push(context.userAuthorizedPaths);
      return { content: "ok" };
    }),
  };
  const orch = new Orchestrator({
    providerManager: {
      getProvider: () => ({ name: "mock", capabilities: { toolCalling: true }, chat: vi.fn() }),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [probe] as never,
    channel: {
      name: "mock",
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: vi.fn(),
      sendText: vi.fn(),
      sendMarkdown: vi.fn(),
      isHealthy: () => true,
    } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    ...(store ? { authorizedPathsStore: store } : {}),
  });
  return orch;
}

async function pathsSeenBy(
  orch: Orchestrator,
  seen: Array<readonly string[] | undefined>,
  chatId: string,
  opts: Record<string, unknown> = {},
): Promise<readonly string[]> {
  seen.length = 0;
  await (orch as unknown as ToolCallsHost).executeToolCalls(
    chatId,
    [{ id: "c1", name: "probe_context", input: {} }],
    opts,
  );
  expect(seen, "the probe tool never ran").toHaveLength(1);
  return seen[0] ?? [];
}

describe("user-authorized paths come only from a channel message", () => {
  it("a delegation whose task text names an outside path does not authorize it", async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const store = new Map<string, readonly string[]>();
    const orch = buildOrchestrator(seen, store);

    const paths = await pathsSeenBy(orch, seen, "delegation-sub-1", {
      mode: "delegated",
      taskPrompt: `You are a sub-agent.\n\nTask: review the config\n\nContext: see ${OUTSIDE}`,
    });

    expect(paths).not.toContain(OUTSIDE);
    // Nor is it written down for any later run on the shared store.
    expect(store.get("delegation-sub-1") ?? []).not.toContain(OUTSIDE);
  });

  it("a worker's model-written sub-goal does not add to the chat's authorization", async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const store = new Map<string, readonly string[]>();
    const orch = buildOrchestrator(seen, store);
    orch.seedUserAuthorizedPaths("chat-1", extractUserAuthorizedPaths(`build the game in ${NAMED_BY_USER}`));

    const paths = await pathsSeenBy(orch, seen, "chat-1", {
      mode: "delegated",
      taskPrompt: `Sub-goal: compare the design with ${OUTSIDE}`,
    });

    expect(paths).toEqual([AUTHORIZED]);
    expect(store.get("chat-1")).toEqual([AUTHORIZED]);
  });

  it("a user-role turn the run synthesized (gate or tool-failure text) authorizes nothing", async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const orch = buildOrchestrator(seen);
    const session = (orch as unknown as ToolCallsHost).sessionManager.getOrCreateSession("chat-gate");
    session.messages.push({
      role: "user",
      content: `[System: the previous tool failed] Error: ENOENT: no such file ${OUTSIDE}`,
    });

    const paths = await pathsSeenBy(orch, seen, "chat-gate");

    expect(paths).toEqual([]);
  });

  it("a path the user typed in their channel message is readable", async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const orch = buildOrchestrator(seen);
    // What the channel wiring does as the message arrives.
    orch.seedUserAuthorizedPaths(
      "chat-user",
      extractUserAuthorizedPaths(`Continue building the game described in ${NAMED_BY_USER}.`),
    );

    const paths = await pathsSeenBy(orch, seen, "chat-user", { taskPrompt: "Continue building the game" });

    expect(paths).toEqual([AUTHORIZED]);
  });

  it("a delegated child never holds more than its parent", async () => {
    const store = new Map<string, readonly string[]>();
    const parentSeen: Array<readonly string[] | undefined> = [];
    const parent = buildOrchestrator(parentSeen, store);
    parent.seedUserAuthorizedPaths("chat-parent", [NAMED_BY_USER]);
    const parentPaths = await pathsSeenBy(parent, parentSeen, "chat-parent");

    // What DelegationManager does: a new orchestrator on the shared store,
    // seeded from the parent's tool context, run on a prompt the parent wrote.
    const childSeen: Array<readonly string[] | undefined> = [];
    const child = buildOrchestrator(childSeen, store);
    child.seedUserAuthorizedPaths("delegation-child", parentPaths);
    const childPaths = await pathsSeenBy(child, childSeen, "delegation-child", {
      mode: "delegated",
      taskPrompt: `Task: read ${NAMED_BY_USER} and ${OUTSIDE}`,
    });

    expect(childPaths.every((p) => parentPaths.includes(p))).toBe(true);
    expect(childPaths).toEqual([NAMED_BY_USER]);
  });
});
