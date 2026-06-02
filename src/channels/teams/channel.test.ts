import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TeamsChannel } from "./channel.js";

// Controls how the mocked HTTP server resolves a listen() call: succeed via the
// callback, or fail by emitting an 'error' event (e.g. EADDRINUSE).
let listenBehavior: "ok" | "error" = "ok";

vi.mock("node:http", () => ({
  createServer: () => {
    const server = new EventEmitter() as EventEmitter & {
      listen: (port: number, host: string, cb: () => void) => void;
      close: (cb: () => void) => void;
    };
    server.listen = (_port: number, _host: string, cb: () => void) => {
      if (listenBehavior === "error") {
        const err = new Error("listen EADDRINUSE");
        (err as NodeJS.ErrnoException).code = "EADDRINUSE";
        setImmediate(() => server.emit("error", err));
      } else {
        setImmediate(cb);
      }
    };
    server.close = (cb: () => void) => setImmediate(cb);
    return server;
  },
}));

// Captures the options the channel passes to
// ConfigurationBotFrameworkAuthentication so tests can assert tenancy wiring.
let lastBotFrameworkAuthOptions: Record<string, unknown> | null = null;

vi.mock("botbuilder", () => ({
  CloudAdapter: class {},
  ConfigurationBotFrameworkAuthentication: class {
    constructor(options: Record<string, unknown>) {
      lastBotFrameworkAuthOptions = options;
    }
  },
  TurnContext: {
    getConversationReference: (activity: { conversation: { id: string } }) => ({
      conversation: { id: activity.conversation.id },
    }),
  },
}));

// In-memory stand-in for the .strada conversation-reference store so the
// persistence round-trip can be tested without touching the real filesystem.
const fakeFs = new Map<string, string>();

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: (path: string) => {
    const value = fakeFs.get(path);
    if (value === undefined) {
      const err = new Error(`ENOENT: no such file ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return value;
  },
  writeFileSync: (path: string, data: string) => {
    fakeFs.set(path, data);
  },
}));

const mockDownloadMedia = vi.fn().mockResolvedValue({
  data: Buffer.from("voice"),
  mimeType: "audio/mpeg",
  size: 5,
});

vi.mock("../../utils/media-processor.js", () => ({
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
  mimeToAttachmentType: (mime: string | undefined | null) => {
    if (!mime) return "document";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  },
  validateMediaAttachment: () => ({ valid: true }),
  validateMagicBytes: () => true,
}));

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("TeamsChannel", () => {
  it("denies inbound users by default when no allowlist is configured", () => {
    const channel = new TeamsChannel("app-id", "app-password");

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(false);
  });

  it("supports explicit open access when configured", () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(true);
  });

  it("restricts inbound users to the configured allowlist", () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, ["user-1", "user-2"]);

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(true);
    expect((channel as any).isAllowedInboundUser("user-3")).toBe(false);
  });

  // Regression: a throw from adapter.process (auth/JWT failure, malformed
  // activity on the public /api/messages endpoint) must not escape as an
  // unhandledRejection — the global handler in src/index.ts would otherwise
  // shut the whole daemon down (remote DoS).
  it("swallows an adapter.process rejection and closes the response with 500", async () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);
    const process = vi.fn().mockRejectedValue(new Error("auth verification failed"));
    (channel as any).adapter = { process };
    const writeHead = vi.fn();
    const end = vi.fn();
    const res = { headersSent: false, writeHead, end };

    await expect(
      (channel as any).handleRequest({ method: "POST", url: "/api/messages" }, res),
    ).resolves.toBeUndefined();
    expect(process).toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(500);
    expect(end).toHaveBeenCalled();
  });

  it("responds 404 to non-/api/messages requests", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const writeHead = vi.fn();
    const end = vi.fn();

    await (channel as any).handleRequest(
      { method: "GET", url: "/" },
      { headersSent: false, writeHead, end },
    );
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalled();
  });

  it("uses the active Teams turn context to send replies during a conversation", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const sendActivity = vi.fn().mockResolvedValue(undefined);

    (channel as unknown as {
      activeTurnContexts: Map<string, { sendActivity: (a: unknown) => Promise<void> }>;
    }).activeTurnContexts.set("chat-1", {
      sendActivity,
    });

    await channel.sendText("chat-1", "hello from teams");

    // Plain text is sent as an Activity with textFormat 'plain' so user/tool
    // content cannot inject Teams markdown.
    expect(sendActivity).toHaveBeenCalledWith({
      type: "message",
      text: "hello from teams",
      textFormat: "plain",
    });
  });

  it("sends markdown replies with markdown text format", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const sendActivity = vi.fn().mockResolvedValue(undefined);

    (channel as unknown as {
      activeTurnContexts: Map<string, { sendActivity: (a: unknown) => Promise<void> }>;
    }).activeTurnContexts.set("chat-1", {
      sendActivity,
    });

    await channel.sendMarkdown("chat-1", "**bold**");

    expect(sendActivity).toHaveBeenCalledWith({
      type: "message",
      text: "**bold**",
      textFormat: "markdown",
    });
  });

  // Regression for the critical send-path defect: the inbound turn context is
  // ephemeral and gone by the time a fire-and-forget agent reply is ready.
  // Outbound delivery must fall back to the persisted conversation reference
  // via adapter.continueConversationAsync so the user actually gets the answer.
  it("delivers async replies proactively when no active turn context remains", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const proactiveSend = vi.fn().mockResolvedValue(undefined);
    const continueConversationAsync = vi
      .fn()
      .mockImplementation(async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({ sendActivity: proactiveSend });
      });

    (channel as any).adapter = { continueConversationAsync };
    (channel as unknown as {
      conversationReferences: Map<string, unknown>;
    }).conversationReferences.set("chat-1", { conversation: { id: "chat-1" } });

    await channel.sendText("chat-1", "delivered later");

    expect(continueConversationAsync).toHaveBeenCalledWith(
      "app-id",
      { conversation: { id: "chat-1" } },
      expect.any(Function),
    );
    expect(proactiveSend).toHaveBeenCalledWith({
      type: "message",
      text: "delivered later",
      textFormat: "plain",
    });
  });

  // Regression: long replies must be chunked (Teams rejects oversized activities)
  // instead of truncating-and-dropping content.
  it("splits long replies into multiple provider-safe chunks", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const sendActivity = vi.fn().mockResolvedValue(undefined);

    (channel as unknown as {
      activeTurnContexts: Map<string, { sendActivity: (a: unknown) => Promise<void> }>;
    }).activeTurnContexts.set("chat-1", {
      sendActivity,
    });

    // Two paragraphs each just under the 18 000-char cap force two chunks.
    const para = "a".repeat(17_000);
    await channel.sendText("chat-1", `${para}\n${para}`);

    expect(sendActivity).toHaveBeenCalledTimes(2);
    const combined = sendActivity.mock.calls
      .map((call) => (call[0] as { text: string }).text)
      .join("");
    // No content dropped.
    expect(combined.length).toBe(34_000);
    for (const call of sendActivity.mock.calls) {
      expect((call[0] as { text: string }).text.length).toBeLessThanOrEqual(18_000);
    }
  });

  it("does not send anything for empty replies", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const sendActivity = vi.fn().mockResolvedValue(undefined);

    (channel as unknown as {
      activeTurnContexts: Map<string, { sendActivity: (a: unknown) => Promise<void> }>;
    }).activeTurnContexts.set("chat-1", {
      sendActivity,
    });

    await channel.sendText("chat-1", "");

    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("fails explicitly when there is no active turn context and no stored reference", async () => {
    const channel = new TeamsChannel("app-id", "app-password");

    await expect(channel.sendText("missing-chat", "hello")).rejects.toThrow(
      "No active Teams conversation for: missing-chat",
    );
  });

  it("builds an incoming voice message from Teams attachments even without text", async () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);

    const msg = await (channel as any).toIncomingMessage({
      type: "message",
      conversation: { id: "chat-1" },
      from: { id: "user-1" },
      attachments: [
        {
          name: "voice.mp3",
          contentType: "audio/mpeg",
          contentUrl: "https://files.example.org/voice.mp3",
        },
      ],
    });

    expect(msg).toMatchObject({
      channelType: "teams",
      chatId: "chat-1",
      userId: "user-1",
      text: "(voice message)",
      attachments: [
        expect.objectContaining({
          type: "audio",
          name: "voice.mp3",
          mimeType: "audio/mpeg",
          url: "https://files.example.org/voice.mp3",
        }),
      ],
    });
  });

  it("infers voice attachment metadata from Teams download info payloads", async () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, [], "127.0.0.1", true);

    const msg = await (channel as any).toIncomingMessage({
      type: "message",
      conversation: { id: "chat-2" },
      from: { id: "user-2" },
      attachments: [
        {
          contentType: "application/vnd.microsoft.teams.file.download.info",
          content: {
            downloadUrl: "https://files.example.org/voice-special",
            fileType: "mp3",
          },
        },
      ],
    });

    expect(msg).toMatchObject({
      text: "(voice message)",
      attachments: [
        expect.objectContaining({
          type: "audio",
          name: "attachment.mp3",
          mimeType: "audio/mpeg",
          url: "https://files.example.org/voice-special",
        }),
      ],
    });
  });

  it("resolves connect() when the server starts listening", async () => {
    listenBehavior = "ok";
    const channel = new TeamsChannel("app-id", "app-password");

    await expect(channel.connect()).resolves.toBeUndefined();
    expect(channel.isHealthy()).toBe(true);

    await channel.disconnect();
  });

  // Regression: net.Server.listen reports bind failures (EADDRINUSE/EACCES) via
  // an 'error' event, not the listening callback. connect() must reject instead
  // of hanging boot forever (or surfacing an unhandledRejection).
  it("rejects connect() when the listen port is unavailable", async () => {
    listenBehavior = "error";
    const channel = new TeamsChannel("app-id", "app-password");

    await expect(channel.connect()).rejects.toThrow("EADDRINUSE");
    expect(channel.isHealthy()).toBe(false);

    listenBehavior = "ok";
  });

  // Tenancy wiring: by default the adapter is configured MultiTenant and no
  // tenant id is sent (multi-tenant tokens are not tenant-scoped).
  it("configures Bot Framework auth as MultiTenant by default", async () => {
    listenBehavior = "ok";
    lastBotFrameworkAuthOptions = null;
    const channel = new TeamsChannel("app-id", "app-password");

    await channel.connect();
    await channel.disconnect();

    expect(lastBotFrameworkAuthOptions).toEqual({
      MicrosoftAppId: "app-id",
      MicrosoftAppPassword: "app-password",
      MicrosoftAppType: "MultiTenant",
    });
  });

  // Single-tenant bots are issued tenant-scoped tokens, so the adapter must
  // receive MicrosoftAppType=SingleTenant *and* the tenant id or proactive
  // (continueConversationAsync) sends fail.
  it("wires single-tenant app type and tenant id into Bot Framework auth", async () => {
    listenBehavior = "ok";
    lastBotFrameworkAuthOptions = null;
    const channel = new TeamsChannel(
      "app-id",
      "app-password",
      3978,
      [],
      "127.0.0.1",
      false,
      "SingleTenant",
      "tenant-123",
    );

    await channel.connect();
    await channel.disconnect();

    expect(lastBotFrameworkAuthOptions).toEqual({
      MicrosoftAppId: "app-id",
      MicrosoftAppPassword: "app-password",
      MicrosoftAppType: "SingleTenant",
      MicrosoftAppTenantId: "tenant-123",
    });
  });

  // Regression: the in-memory conversation-reference map is lost on restart,
  // silently dropping any reply produced afterwards. References are mirrored to
  // a .strada JSON file on capture and restored on connect(), so a post-restart
  // reply is still delivered proactively.
  it("persists conversation references and restores them across a restart", async () => {
    listenBehavior = "ok";
    fakeFs.clear();

    // First "process lifetime": capture a reference (mirrors it to disk).
    const channel1 = new TeamsChannel("app-id", "app-password");
    await channel1.connect();
    (channel1 as any).captureConversationReference("chat-1", {
      type: "message",
      conversation: { id: "chat-1" },
      from: { id: "user-1" },
    });
    await channel1.disconnect();

    // In-memory map is gone after disconnect; the disk file remains.
    expect(
      (channel1 as unknown as { conversationReferences: Map<string, unknown> }).conversationReferences.size,
    ).toBe(0);

    // Second "process lifetime": a fresh instance restores from disk on connect.
    const channel2 = new TeamsChannel("app-id", "app-password");
    await channel2.connect();

    const proactiveSend = vi.fn().mockResolvedValue(undefined);
    const continueConversationAsync = vi
      .fn()
      .mockImplementation(async (_appId: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => {
        await logic({ sendActivity: proactiveSend });
      });
    (channel2 as any).adapter = { continueConversationAsync };

    // A reply produced after the restart still reaches the user via the
    // restored reference rather than throwing "No active Teams conversation".
    await channel2.sendText("chat-1", "delivered after restart");

    expect(continueConversationAsync).toHaveBeenCalledWith(
      "app-id",
      { conversation: { id: "chat-1" } },
      expect.any(Function),
    );
    expect(proactiveSend).toHaveBeenCalledWith({
      type: "message",
      text: "delivered after restart",
      textFormat: "plain",
    });

    await channel2.disconnect();
  });
});
