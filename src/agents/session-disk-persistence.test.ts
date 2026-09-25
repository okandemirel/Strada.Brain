/**
 * ORC-16 — the session file on disk must hold the session's final state, and a
 * failed write must not destroy the last good copy.
 *
 * `node:fs/promises` is wrapped so a test can make a write fail part-way
 * through, the way a crash or a full disk does.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionManagerDeps } from "./orchestrator-session-manager.js";
import { createLogger } from "../utils/logger.js";

const fsControl = vi.hoisted(() => ({ failWrites: false, failedWrites: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // The session file goes through the shared atomic writer, which writes via a FileHandle.
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!fsControl.failWrites) return handle;
      const writeFile = handle.writeFile.bind(handle);
      return Object.assign(handle, {
        // A write that dies part-way: some bytes land, then the error.
        writeFile: async (data: string | Uint8Array) => {
          await writeFile(String(data).slice(0, 16));
          fsControl.failedWrites++;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
      });
    },
  };
});

function deps(sessionsDir: string): SessionManagerDeps {
  return {
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn().mockReturnValue(undefined) },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
    sessionsDir,
    memoryManager: {
      // Resolves on a later tick, like the real store: the disk write runs after it.
      storeConversation: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: "ok", value: undefined };
      }),
    },
  } as unknown as SessionManagerDeps;
}

describe("session disk persistence (ORC-16)", () => {
  let dir: string;

  beforeAll(() => { createLogger("error", "test.log"); });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strada-session-disk-"));
    fsControl.failWrites = false;
    fsControl.failedWrites = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes an expiring session's final state even though cleanup removes it from the map", async () => {
    const sm = new SessionManager(deps(dir));
    const session = sm.getOrCreateSession("chat-expiring");
    sm.appendVisibleUserMessage(session, "remember the castle module");
    sm.appendVisibleAssistantMessage(session, "noted: castle module");
    session.lastActivity = new Date(Date.now() - 2 * 3600_000);

    expect(sm.cleanupSessions(3600_000)).toEqual(["chat-expiring"]);
    expect(sm.sessions.has("chat-expiring")).toBe(false);

    await vi.waitFor(() => expect(existsSync(join(dir, "chat-expiring.json"))).toBe(true));
    sm.dispose();
  });

  it("a write that fails part-way leaves the previous session file intact", async () => {
    const sm = new SessionManager(deps(dir));
    const session = sm.getOrCreateSession("chat-crash");
    sm.appendVisibleUserMessage(session, "first turn");
    sm.appendVisibleAssistantMessage(session, "first answer");
    await sm.persistSessionToMemory("chat-crash", session.messages, true);
    await vi.waitFor(() => expect(existsSync(join(dir, "chat-crash.json"))).toBe(true));

    fsControl.failWrites = true;
    sm.appendVisibleUserMessage(session, "second turn");
    sm.appendVisibleAssistantMessage(session, "second answer");
    await sm.persistSessionToMemory("chat-crash", session.messages, true);
    await vi.waitFor(() => {
      expect(fsControl.failedWrites).toBe(1);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
    fsControl.failWrites = false;

    const restored = new SessionManager(deps(dir)).getOrCreateSession("chat-crash");
    expect(restored.messages.map((m) => m.content)).toEqual(["first turn", "first answer"]);
    sm.dispose();
  });

  it("stale-session cleanup also removes an interrupted write's temp file", () => {
    const stale = join(dir, "chat-x.json.0f0f.tmp");
    writeFileSync(stale, "{\"mess");
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(stale, old, old);

    new SessionManager(deps(dir)).cleanupStaleSessions();

    expect(existsSync(stale)).toBe(false);
  });
});

describe("session disk persistence with memory disabled (ORC-16)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strada-session-nomem-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh module graph, so the once-per-process notice has not been logged yet. */
  async function freshModules() {
    vi.resetModules();
    const logger = await import("../utils/logger.js");
    logger.createLogger("error", "test.log");
    const info = vi.spyOn(logger.getLogger(), "info");
    const { SessionManager: FreshSessionManager } = await import("./orchestrator-session-manager.js");
    return { info, FreshSessionManager };
  }

  it("writes no session file and says so once at startup", async () => {
    const { info, FreshSessionManager } = await freshModules();
    const noMemory = { ...deps(dir), memoryManager: undefined };

    const sm = new FreshSessionManager(noMemory);
    new FreshSessionManager(noMemory).dispose(); // a second agent's manager: no second notice
    const session = sm.getOrCreateSession("chat-private");
    sm.appendVisibleUserMessage(session, "keep this between us");
    sm.appendVisibleAssistantMessage(session, "understood");
    await sm.persistSessionToMemory("chat-private", session.messages, true);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the disk write is fire-and-forget

    expect(readdirSync(dir)).toEqual([]);
    const notices = info.mock.calls.filter(([message]) => /session persistence is off/i.test(String(message)));
    expect(notices).toHaveLength(1);
    expect(String(notices[0]?.[0])).toMatch(/memory is disabled/i);
    sm.dispose();
  });

  it("with memory enabled there is no such notice", async () => {
    const { info, FreshSessionManager } = await freshModules();
    new FreshSessionManager(deps(dir)).dispose();
    expect(info.mock.calls.some(([message]) => /session persistence is off/i.test(String(message)))).toBe(false);
  });
});
