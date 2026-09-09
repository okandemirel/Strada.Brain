import { describe, it, expect, vi, beforeEach } from "vitest";
import { HubChannel } from "./hub-channel.js";
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
});
