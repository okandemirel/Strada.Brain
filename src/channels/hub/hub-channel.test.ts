import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { HubChannel } from "./hub-channel.js";
import { HubOwnerStore, HUB_OWNERS_DB_FILE } from "./owner-store.js";
import type { IChannelAdapter } from "../channel.interface.js";
import type { IncomingMessage } from "../channel-messages.interface.js";

const loggerStub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
vi.mock("../../utils/logger.js", () => ({ getLoggerSafe: () => loggerStub, getLogger: () => loggerStub }));

type Fake = IChannelAdapter & {
  handler?: (msg: IncomingMessage) => Promise<void>;
  sent: Array<[string, string, string]>;
  claimsChatId?: (id: string) => boolean;
  [key: string]: unknown;
};

function fake(name: string, extras: Record<string, unknown> = {}): Fake {
  const f: Fake = {
    name,
    sent: [],
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    isHealthy: vi.fn(() => true),
    onMessage(handler) {
      f.handler = handler;
    },
    sendText: vi.fn(async (chatId: string, text: string) => {
      f.sent.push([chatId, "text", text]);
    }),
    sendMarkdown: vi.fn(async (chatId: string, md: string) => {
      f.sent.push([chatId, "markdown", md]);
    }),
    ...extras,
  } as Fake;
  return f;
}

function incoming(chatId: string, channelType: string): IncomingMessage {
  return { chatId, channelType, userId: "u", text: "hi", timestamp: new Date() } as IncomingMessage;
}

// The default owner store lives under the Strada home: fake HOME so no test
// touches the real ~/.strada.
let fakeHome: string;
const savedEnv = { HOME: process.env["HOME"], STRADA_HOME: process.env["STRADA_HOME"] };
beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "hub-home-"));
  process.env["HOME"] = fakeHome;
  delete process.env["STRADA_HOME"];
});
afterAll(() => {
  process.env["HOME"] = savedEnv.HOME;
  if (savedEnv.STRADA_HOME !== undefined) process.env["STRADA_HOME"] = savedEnv.STRADA_HOME;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("HubChannel", () => {
  beforeEach(() => {
    loggerStub.warn.mockReset();
  });

  it("needs at least two members and names itself after them", () => {
    expect(() => new HubChannel([fake("web")])).toThrow(/at least two/);
    expect(new HubChannel([fake("web"), fake("telegram")]).name).toBe("web+telegram");
  });

  it("delivers every member's messages to the one handler and replies on the member the chat arrived on", async () => {
    const web = fake("web");
    const tg = fake("telegram");
    const hub = new HubChannel([web, tg]);
    const received: string[] = [];
    hub.onMessage(async (msg) => {
      received.push(`${msg.channelType}:${msg.chatId}`);
    });

    await tg.handler!(incoming("12345", "telegram"));
    await web.handler!(incoming("6f9619ff-8b86-d011-b42d-00c04fc964ff", "web"));
    expect(received).toEqual(["telegram:12345", "web:6f9619ff-8b86-d011-b42d-00c04fc964ff"]);

    await hub.sendMarkdown("12345", "for telegram");
    await hub.sendText("6f9619ff-8b86-d011-b42d-00c04fc964ff", "for web");
    expect(tg.sent).toEqual([["12345", "markdown", "for telegram"]]);
    expect(web.sent).toEqual([["6f9619ff-8b86-d011-b42d-00c04fc964ff", "text", "for web"]]);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });

  it("routes a chat it never saw to the member that claims the id's shape, else to the primary with one warning", async () => {
    const web = fake("web", { claimsChatId: (id: string) => /^[0-9a-f-]{36}$/.test(id) });
    const tg = fake("telegram", { claimsChatId: (id: string) => /^-?\d+$/.test(id) });
    const hub = new HubChannel([web, tg]);

    await hub.sendMarkdown("-100999", "persisted campaign chat");
    expect(tg.sent).toHaveLength(1);
    expect(web.sent).toHaveLength(0);

    await hub.sendMarkdown("cli-local", "guardian note");
    await hub.sendMarkdown("cli-local", "second note");
    expect(web.sent.map((s) => s[2])).toEqual(["guardian note", "second note"]);
    expect(loggerStub.warn).toHaveBeenCalledTimes(1);
    expect(loggerStub.warn.mock.calls[0]?.[1]).toMatchObject({ chatId: "cli-local", primary: "web" });
  });

  it("degrades per-chat capabilities a member lacks explicitly instead of dropping them", async () => {
    const tg = fake("telegram", { claimsChatId: (id: string) => /^\d+$/.test(id) });
    const web = fake("web", {
      sendAttachment: vi.fn(async () => undefined),
      startStreamingMessage: vi.fn(async () => "stream-1"),
      sendTypingIndicator: vi.fn(async () => undefined),
    });
    const hub = new HubChannel([web, tg]);
    await web.handler; // no-op; ownership for the web id comes from the message below
    hub.onMessage(async () => undefined);
    await (web as Fake).handler!(incoming("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "web"));

    // Telegram lacks attachments: the file is named in markdown, not lost.
    await hub.sendAttachment("777", { type: "image", name: "shot.png", url: "https://x/shot.png" });
    expect(tg.sent).toEqual([["777", "markdown", "📎 image: shot.png — https://x/shot.png"]]);
    // Web has attachments: delegated.
    await hub.sendAttachment("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { type: "image", name: "shot.png" });
    expect(web.sendAttachment).toHaveBeenCalledTimes(1);

    // Streaming: a member without it never starts a stream; finalize still delivers the text.
    expect(await hub.startStreamingMessage("777")).toBeUndefined();
    expect(await hub.startStreamingMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe("stream-1");
    await hub.finalizeStreamingMessage("777", "none", "final text");
    expect(tg.sent[1]).toEqual(["777", "markdown", "final text"]);

    // Typing on a member without it is a no-op, not a crash.
    await expect(hub.sendTypingIndicator("777")).resolves.toBeUndefined();
    await expect(hub.requestConfirmation({ chatId: "777" } as never)).rejects.toThrow(/cannot ask for confirmation/);
  });

  it("fans setters and broadcasts out to every member that implements them", () => {
    const web = fake("web", { setWorkspaceBusEmitter: vi.fn(), broadcastRaw: vi.fn(), setBuildStatusProvider: vi.fn(), setFeedbackHandler: vi.fn() });
    const tg = fake("telegram", { setFeedbackHandler: vi.fn() });
    const hub = new HubChannel([web, tg]);
    const emitter = () => true;
    hub.setWorkspaceBusEmitter(emitter);
    hub.broadcastRaw("{\"type\":\"campaign:status\"}");
    hub.setBuildStatusProvider("provider");
    const feedback = () => undefined;
    hub.setFeedbackHandler(feedback);
    expect(web.setWorkspaceBusEmitter).toHaveBeenCalledWith(emitter);
    expect(web.broadcastRaw).toHaveBeenCalledWith("{\"type\":\"campaign:status\"}");
    expect(web.setBuildStatusProvider).toHaveBeenCalledWith("provider");
    expect(web.setFeedbackHandler).toHaveBeenCalledWith(feedback);
    expect(tg.setFeedbackHandler).toHaveBeenCalledWith(feedback);
  });

  // Plan 2.9 (audit 12F1/D58): ownership is bound once; a later inbound on
  // another member never re-routes the chat, and a notification's owner row
  // binds a chat the hub has not seen since boot.
  it("keeps the first owner of a chat id when a later inbound arrives on another member, and binds by owner row", async () => {
    const slack = fake("slack");
    const tg = fake("telegram");
    const hub = new HubChannel([slack, tg], { ownerStore: null });
    hub.onMessage(async () => undefined);

    await slack.handler!(incoming("shared-id", "slack"));
    await tg.handler!(incoming("shared-id", "telegram"));
    await hub.sendMarkdown("shared-id", "reply");
    expect(slack.sent).toEqual([["shared-id", "markdown", "reply"]]);
    expect(tg.sent).toEqual([]);

    // A task row says chat "persisted" lives on telegram: no inbound needed.
    expect(hub.bindOwner("persisted", "telegram")).toBe(true);
    expect(hub.bindOwner("persisted", "no-such-member")).toBe(false);
    await hub.sendText("persisted", "goal done");
    expect(tg.sent).toEqual([["persisted", "text", "goal done"]]);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });

  // Plan 2.10 (audit 12F2/D59): {chatId → channelType} is persisted and
  // restored, so a new hub from the same storage routes a chat it never saw.
  it("restores chat ownership from the owner store after a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-owners-"));
    const dbPath = join(dir, HUB_OWNERS_DB_FILE);
    const store = new HubOwnerStore(dbPath);
    try {
      const slack1 = fake("slack");
      const tg1 = fake("telegram");
      const hub1 = new HubChannel([tg1, slack1], { ownerStore: store });
      hub1.onMessage(async () => undefined);
      await slack1.handler!(incoming("C123:1700000000.000100", "slack"));
      await hub1.disconnect();
      store.close();

      // Restart: fresh adapters and a fresh store over the same database, no
      // inbound, no claimsChatId on either member.
      const slack2 = fake("slack");
      const tg2 = fake("telegram");
      const hub2 = new HubChannel([tg2, slack2], { ownerStore: new HubOwnerStore(dbPath) });
      hub2.onMessage(async () => undefined);
      await hub2.sendMarkdown("C123:1700000000.000100", "goal finished");
      expect(slack2.sent).toEqual([["C123:1700000000.000100", "markdown", "goal finished"]]);
      expect(tg2.sent).toEqual([]);
      expect(loggerStub.warn).not.toHaveBeenCalled();
      expect(hub2.ownerNames().get("C123:1700000000.000100")).toBe("slack");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists ownership under the Strada home by default", async () => {
    const web = fake("web");
    const tg = fake("telegram");
    const hub = new HubChannel([web, tg]);
    hub.onMessage(async () => undefined);
    await tg.handler!(incoming("4242", "telegram"));
    const dbPath = join(fakeHome, ".strada", HUB_OWNERS_DB_FILE);
    expect(existsSync(dbPath)).toBe(true);
    const persisted = new HubOwnerStore(dbPath);
    try {
      expect(persisted.load().get("4242")).toBe("telegram");
    } finally {
      persisted.close();
    }
  });

  it("connects members in order, rolls back on a failure, and is healthy only when all are", async () => {
    const web = fake("web");
    const tg = fake("telegram", { connect: vi.fn(async () => { throw new Error("401 bad token"); }) });
    const hub = new HubChannel([web, tg]);
    await expect(hub.connect()).rejects.toThrow(/"telegram" failed to connect: 401 bad token/);
    expect(web.disconnect).toHaveBeenCalledTimes(1);

    const ok = new HubChannel([fake("web"), fake("telegram", { isHealthy: () => false })]);
    expect(ok.isHealthy()).toBe(false);
    expect(ok.memberHealth()).toEqual([{ name: "web", healthy: true }, { name: "telegram", healthy: false }]);
    await ok.disconnect();
  });

  // Codex round 8 #7 / round 9 #31: two hubs both loaded the whole map and each
  // wrote its own snapshot back, so the store kept only the last writer's and
  // the other chat lost its owner. Each hub now writes only what it changed.
  it("two hubs writing at once keep both bindings, and neither resurrects a chat the other rebound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-owners-race-"));
    const path = join(dir, HUB_OWNERS_DB_FILE);
    try {
      const storeA = new HubOwnerStore(path);
      const storeB = new HubOwnerStore(path);
      const slackA = fake("slack");
      const tgA = fake("telegram");
      const hubA = new HubChannel([tgA, slackA], { ownerStore: storeA });
      hubA.onMessage(async () => undefined);
      const slackB = fake("slack");
      const tgB = fake("telegram");
      const hubB = new HubChannel([tgB, slackB], { ownerStore: storeB });
      hubB.onMessage(async () => undefined);

      // Both hubs started from an empty file and each learns a different chat.
      await slackA.handler!(incoming("C111:1700000000.000100", "slack"));
      await tgB.handler!(incoming("222333", "telegram"));

      const onDisk = new HubOwnerStore(path);
      try {
        expect(onDisk.load().get("C111:1700000000.000100")).toBe("slack");
        expect(onDisk.load().get("222333")).toBe("telegram");
      } finally {
        onDisk.close();
      }

      // Hub B re-binds hub A's chat by owner row; hub A then learns a THIRD
      // chat while its own in-memory map still says "slack". Hub A must write
      // only the chat it learned, never assert its whole stale view (#31).
      expect(hubB.bindOwner("C111:1700000000.000100", "telegram")).toBe(true);
      await tgA.handler!(incoming("444555", "telegram"));
      const after = new HubOwnerStore(path);
      try {
        expect(after.load().get("C111:1700000000.000100")).toBe("telegram");
        expect(after.load().get("444555")).toBe("telegram");
      } finally {
        after.close();
      }
      storeA.close();
      storeB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // CHN-19: ownership rows are routing hints. Every chat id used to keep its
  // row (and its map entry) forever.
  describe("ownership is bounded (CHN-19)", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("drops persisted bindings unused past the TTL when it loads them", () => {
      const dir = mkdtempSync(join(tmpdir(), "hub-ttl-"));
      try {
        const dbPath = join(dir, HUB_OWNERS_DB_FILE);
        const seed = new HubOwnerStore(dbPath);
        seed.bind("stale-chat", "slack");
        seed.bind("fresh-chat", "slack");
        seed.close();
        const raw = new Database(dbPath);
        raw.prepare("UPDATE hub_owners SET updated_at = ? WHERE chat_id = ?").run(Date.now() - 120 * DAY, "stale-chat");
        raw.close();

        const store = new HubOwnerStore(dbPath);
        const hub = new HubChannel([fake("telegram"), fake("slack")], { ownerStore: store });
        expect([...hub.ownerNames().keys()]).toEqual(["fresh-chat"]);
        expect([...store.load().keys()]).toEqual(["fresh-chat"]);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("forgets a binding unused past the TTL while running", () => {
      vi.useFakeTimers();
      try {
        const slack = fake("slack");
        const tg = fake("telegram");
        const hub = new HubChannel([tg, slack], { ownerStore: null });
        expect(hub.bindOwner("chat-1", "slack")).toBe(true);
        vi.setSystemTime(Date.now() + 91 * DAY);
        expect(hub.ownerOf("chat-1").name).toBe("telegram"); // the primary fallback
        expect(hub.ownerNames().has("chat-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps at most 10000 bindings, least recently used dropped first", () => {
      const hub = new HubChannel([fake("telegram"), fake("slack")], { ownerStore: null });
      for (let i = 0; i <= 10_000; i++) hub.bindOwner(`chat-${i}`, "slack");
      const names = hub.ownerNames();
      expect(names.size).toBe(10_000);
      expect(names.has("chat-0")).toBe(false);
      expect(names.has("chat-10000")).toBe(true);
    });
  });

});
