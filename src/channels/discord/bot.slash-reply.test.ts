/**
 * CHN-6: every deferred slash-command interaction gets an answer. The daemon's
 * handler queues a task and returns before any reply exists; the interaction
 * must still be answered, and the later answer must not be misrouted into it.
 */
import { describe, expect, it, vi } from "vitest";
import { DiscordChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";
import type { IncomingMessage } from "../channel-messages.interface.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const channelSend = vi.hoisted(() => vi.fn());

vi.mock("discord.js", async () => {
  const actual = await vi.importActual("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(function () {
      return {
        login: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn().mockReturnValue(true),
        user: { tag: "TestBot#1234", id: "123456789" },
        ws: { ping: 50 },
        on: vi.fn(),
        once: vi.fn(),
        channels: {
          fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send: channelSend }),
        },
      };
    }),
  };
});

interface Internals {
  handleSlashCommand(interaction: unknown): Promise<void>;
  sendTextImmediate(chatId: string, text: string): Promise<void>;
}

function setup(handler: (msg: IncomingMessage, channel: Internals) => Promise<void>) {
  const auth = new AuthManager([], {
    allowedDiscordIds: new Set(["user-1"]),
    allowedDiscordRoles: new Set<string>(),
  });
  const channel = new DiscordChannel("fake-token", auth);
  const internals = channel as unknown as Internals;
  channel.onMessage((msg) => handler(msg, internals));
  const interaction = {
    id: "interaction-1",
    user: { id: "user-1" },
    member: null,
    commandName: "ask",
    channelId: "channel-1",
    options: { getString: vi.fn().mockReturnValue("What does EnemySystem do?") },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return { channel, internals, interaction };
}

describe("Discord slash commands answer their deferred interaction (CHN-6)", () => {
  it("answers when the handler returns before any reply was sent", async () => {
    channelSend.mockReset();
    const { internals, interaction } = setup(async () => {
      // The daemon's router buffers the task and returns at once.
    });

    await internals.handleSlashCommand(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(String(interaction.editReply.mock.calls[0]![0])).toMatch(/reply is posted in this channel/);

    // The real answer arrives later as a channel message, not into the interaction.
    await internals.sendTextImmediate("channel-1", "EnemySystem spawns enemies.");
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(channelSend).toHaveBeenCalledWith("EnemySystem spawns enemies.");
  });

  it("a reply produced while the command is handled still goes into the interaction, once", async () => {
    const { internals, interaction } = setup(async (msg, channel) => {
      await channel.sendTextImmediate(msg.chatId, "Direct answer");
    });

    await internals.handleSlashCommand(interaction);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith("Direct answer");
  });

  it("answers with an error message when the handler throws", async () => {
    const { internals, interaction } = setup(async () => {
      throw new Error("boom");
    });

    await expect(internals.handleSlashCommand(interaction)).rejects.toThrow("boom");
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });
});
