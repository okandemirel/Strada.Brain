import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createShutdownHandler,
  setupCleanup,
  generateSessionId,
  wireMessageHandler,
} from "./bootstrap-wiring.js";
import { createLogger } from "../utils/logger.js";
import { TaskStatus, type Task } from "../tasks/types.js";

// ---------------------------------------------------------------------------
// Mocks (lazy — only needed for wireMessageHandler tests)
// ---------------------------------------------------------------------------

vi.mock("./incoming-audio-transcription.js", () => ({
  transcribeIncomingAudioMessage: vi.fn(async (msg: any) => ({
    shouldDrop: false,
    message: msg,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task_shutdown123" as Task["id"],
    chatId: "chat-1",
    channelType: "cli",
    title: "shutdown task",
    status: TaskStatus.executing,
    prompt: "test prompt",
    progress: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeChannel() {
  const handlers: Array<(msg: any) => Promise<void>> = [];
  return {
    name: "test",
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isHealthy: vi.fn(() => true),
    onMessage: vi.fn((handler: any) => {
      handlers.push(handler);
    }),
    sendText: vi.fn(async () => {}),
    sendMarkdown: vi.fn(async () => {}),
    _handlers: handlers,
    _emit: async (msg: any) => {
      for (const h of handlers) await h(msg);
    },
  } as any;
}

function makeOrchestrator() {
  return {
    cleanupSessions: vi.fn(),
    withTaskExecutionContext: vi.fn(async (_ctx: any, fn: () => Promise<void>) => fn()),
    buildTrajectoryReplayContext: vi.fn(async () => ({})),
  } as any;
}

function makeMessageRouter() {
  return { route: vi.fn(async () => {}) } as any;
}

function makeTaskPlanner() {
  return {
    startTask: vi.fn(),
    getTaskRunId: vi.fn(() => "run-123"),
    isActive: vi.fn(() => true),
    getTaskStartedAt: vi.fn(() => Date.now()),
    attachReplayContext: vi.fn(),
    endTask: vi.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests: createShutdownHandler (existing)
// ---------------------------------------------------------------------------

describe("createShutdownHandler", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-bootstrap-wiring-test.log"); } catch { /* already initialized */ }
  });

  it("persists active task failures before closing storage", async () => {
    const activeTask = buildTask();
    const taskManager = {
      failActiveTasksOnShutdown: vi.fn(),
    } as any;
    const taskStorage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateError: vi.fn(),
      close: vi.fn(),
    } as any;

    const shutdown = createShutdownHandler({
      channel: { disconnect: vi.fn(async () => {}) } as any,
      cleanupInterval: setInterval(() => {}, 1000),
      taskManager,
      taskStorage,
    });

    await shutdown();

    expect(taskManager.failActiveTasksOnShutdown).toHaveBeenCalledWith(
      "Task interrupted by system shutdown. Resume is available after restart.",
    );
    expect(taskStorage.updateError).not.toHaveBeenCalled();
    expect(taskStorage.close).toHaveBeenCalledOnce();
  });

  it("falls back to taskStorage when taskManager is absent", async () => {
    const activeTask = buildTask();
    const taskStorage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateError: vi.fn(),
      close: vi.fn(),
    } as any;

    const shutdown = createShutdownHandler({
      channel: { disconnect: vi.fn(async () => {}) } as any,
      cleanupInterval: setInterval(() => {}, 1000),
      taskStorage,
    });

    await shutdown();

    expect(taskStorage.updateError).toHaveBeenCalledWith(
      activeTask.id,
      expect.stringContaining("shutdown"),
    );
  });

  it("disconnects the channel on shutdown", async () => {
    const channel = makeChannel();
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({ channel, cleanupInterval: interval } as any);

    await shutdown();

    expect(channel.disconnect).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("stops dashboard when present", async () => {
    const channel = makeChannel();
    const dashboard = { stop: vi.fn(async () => {}) } as any;
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({ channel, cleanupInterval: interval, dashboard } as any);

    await shutdown();

    expect(dashboard.stop).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("shuts down memoryManager when present", async () => {
    const channel = makeChannel();
    const memoryManager = { shutdown: vi.fn(async () => {}) } as any;
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({ channel, cleanupInterval: interval, memoryManager } as any);

    await shutdown();

    expect(memoryManager.shutdown).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("stops learningPipeline when present", async () => {
    const channel = makeChannel();
    const learningPipeline = { stop: vi.fn() } as any;
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({ channel, cleanupInterval: interval, learningPipeline } as any);

    await shutdown();

    expect(learningPipeline.stop).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("drains eventBus and learningQueue before stopping pipeline", async () => {
    const callOrder: string[] = [];
    const channel = makeChannel();
    const eventBus = { shutdown: vi.fn(async () => { callOrder.push("eventBus"); }) } as any;
    const learningQueue = { shutdown: vi.fn(async () => { callOrder.push("learningQueue"); }) } as any;
    const learningPipeline = { stop: vi.fn(() => { callOrder.push("learningPipeline"); }) } as any;
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({
      channel, cleanupInterval: interval,
      eventBus, learningQueue, learningPipeline,
    } as any);

    await shutdown();

    expect(callOrder.indexOf("eventBus")).toBeLessThan(callOrder.indexOf("learningPipeline"));
    expect(callOrder.indexOf("learningQueue")).toBeLessThan(callOrder.indexOf("learningPipeline"));
    clearInterval(interval);
  });

  it("calls autoUpdater.shutdown when present", async () => {
    const channel = makeChannel();
    const autoUpdater = { shutdown: vi.fn() } as any;
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({ channel, cleanupInterval: interval, autoUpdater } as any);

    await shutdown();

    expect(autoUpdater.shutdown).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("calls soulLoader.shutdown when present", async () => {
    const channel = makeChannel();
    const soulLoader = { shutdown: vi.fn() } as any;
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({ channel, cleanupInterval: interval, soulLoader } as any);

    await shutdown();

    expect(soulLoader.shutdown).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("stops all stoppable servers", async () => {
    const channel = makeChannel();
    const s1 = { stop: vi.fn(async () => {}) };
    const s2 = { stop: vi.fn(async () => {}) };
    const interval = setInterval(() => {}, 99999);
    const shutdown = createShutdownHandler({
      channel, cleanupInterval: interval,
      stoppableServers: [s1, s2],
    } as any);

    await shutdown();

    expect(s1.stop).toHaveBeenCalledTimes(1);
    expect(s2.stop).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });
});

// ---------------------------------------------------------------------------
// Tests: wireMessageHandler
// ---------------------------------------------------------------------------

describe("wireMessageHandler", () => {
  it("registers a message handler on the channel", () => {
    const channel = makeChannel();
    wireMessageHandler(channel, makeMessageRouter(), makeOrchestrator(), makeTaskPlanner(), undefined, "/tmp");
    expect(channel.onMessage).toHaveBeenCalledTimes(1);
  });

  it("routes incoming messages through the message router", async () => {
    const channel = makeChannel();
    const router = makeMessageRouter();
    wireMessageHandler(channel, router, makeOrchestrator(), makeTaskPlanner(), undefined, "/tmp");

    await channel._emit({ chatId: "c1", text: "hi", userId: "u1" });

    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "c1", text: "hi" }),
    );
  });

  it("starts and ends task tracking", async () => {
    const channel = makeChannel();
    const tp = makeTaskPlanner();
    wireMessageHandler(channel, makeMessageRouter(), makeOrchestrator(), tp, undefined, "/tmp");

    await channel._emit({ chatId: "c1", text: "hi", userId: "u1" });

    expect(tp.startTask).toHaveBeenCalledTimes(1);
    expect(tp.endTask).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("records activity when registry is provided", async () => {
    const channel = makeChannel();
    const registry = { recordActivity: vi.fn() } as any;
    wireMessageHandler(
      channel, makeMessageRouter(), makeOrchestrator(), makeTaskPlanner(),
      undefined, "/tmp", undefined, undefined, registry, "web",
    );

    await channel._emit({ chatId: "c1", text: "hi", userId: "u1" });

    expect(registry.recordActivity).toHaveBeenCalledWith("web", "c1");
  });

  it("signals heartbeat on user activity", async () => {
    const channel = makeChannel();
    const hb = { onUserActivity: vi.fn() } as any;
    wireMessageHandler(
      channel, makeMessageRouter(), makeOrchestrator(), makeTaskPlanner(),
      undefined, "/tmp", undefined, hb,
    );

    await channel._emit({ chatId: "c1", text: "hi", userId: "u1" });

    expect(hb.onUserActivity).toHaveBeenCalledTimes(1);
  });

  it("marks task as failed when routing throws", async () => {
    const channel = makeChannel();
    const router = makeMessageRouter();
    router.route.mockRejectedValueOnce(new Error("boom"));
    const tp = makeTaskPlanner();

    wireMessageHandler(channel, router, makeOrchestrator(), tp, undefined, "/tmp");

    await expect(channel._emit({ chatId: "c1", text: "hi", userId: "u1" })).rejects.toThrow("boom");

    expect(tp.endTask).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, hadErrors: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: setupCleanup
// ---------------------------------------------------------------------------

describe("setupCleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an interval handle", () => {
    const orchestrator = makeOrchestrator();
    const interval = setupCleanup(orchestrator);
    expect(interval).toBeDefined();
    clearInterval(interval);
  });

  it("calls cleanupSessions periodically", () => {
    vi.useFakeTimers();
    const orchestrator = makeOrchestrator();
    const interval = setupCleanup(orchestrator);

    // SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000 = 1_800_000
    vi.advanceTimersByTime(1_800_000);

    expect(orchestrator.cleanupSessions).toHaveBeenCalled();
    clearInterval(interval);
  });
});

// ---------------------------------------------------------------------------
// Tests: generateSessionId
// ---------------------------------------------------------------------------

describe("generateSessionId", () => {
  it("returns a non-empty string", () => {
    const id = generateSessionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("contains a numeric timestamp prefix", () => {
    const id = generateSessionId();
    const parts = id.split("-");
    expect(Number.isFinite(Number(parts[0]))).toBe(true);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});
