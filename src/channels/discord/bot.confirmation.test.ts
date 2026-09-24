/**
 * CHN-7: Discord confirmation prompts fit the platform's limits (customId 100,
 * label 80, embed description 4096, field 1024), resolve the clicked option by
 * index, and a prompt that was not answered never settles as an answer.
 */
import { describe, expect, it, vi } from "vitest";
import type { APIActionRowComponent, APIButtonComponentWithCustomId, APIEmbed } from "discord.js";
import { DiscordChannel } from "./bot.js";
import { AuthManager } from "../../security/auth.js";
import type { ConfirmationRequest } from "../channel-messages.interface.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const send = vi.hoisted(() => vi.fn());

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
        channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send }) },
      };
    }),
  };
});

interface Internals {
  sendConfirmationPrompt(req: ConfirmationRequest, confirmId: string): Promise<void>;
  handleButtonInteraction(interaction: unknown): Promise<void>;
  enqueueMessage(message: unknown): Promise<unknown>;
  pendingConfirmations: Map<string, unknown>;
}

const LONG_OPTIONS = Array.from({ length: 5 }, (_, i) => `${i} ${"Reuse the existing EnemySystem ".repeat(4)}`.slice(0, 100));
const LONG_QUESTION = "Plan step. ".repeat(600);

function channel(): { ch: DiscordChannel; internals: Internals } {
  const auth = new AuthManager([], { allowedDiscordIds: new Set(["u1"]), allowedDiscordRoles: new Set<string>() });
  const ch = new DiscordChannel("fake-token", auth);
  return { ch, internals: ch as unknown as Internals };
}

describe("Discord confirmation prompts (CHN-7)", () => {
  it("builds a sendable prompt for five 100-char options and a 6600-char plan", async () => {
    send.mockReset();
    const { internals } = channel();
    await internals.sendConfirmationPrompt(
      { chatId: "c1", question: LONG_QUESTION, options: LONG_OPTIONS, details: "d".repeat(3000) },
      "confirm_0f8fad5bd9cb",
    );

    const payload = send.mock.calls[0]![0] as {
      embeds: Array<{ toJSON(): APIEmbed }>;
      components: Array<{ toJSON(): APIActionRowComponent<APIButtonComponentWithCustomId> }>;
    };
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.fields![0]!.value.length).toBeLessThanOrEqual(1024);
    const buttons = payload.components.flatMap((row) => row.toJSON().components);
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
      expect(button.label!.length).toBeLessThanOrEqual(80);
    }
  });

  it("resolves the option the clicked button's index names", async () => {
    const { internals, ch } = channel();
    internals.enqueueMessage = vi.fn().mockResolvedValue(undefined);
    const answer = ch.requestConfirmation({ chatId: "c1", userId: "u1", question: "Pick", options: LONG_OPTIONS });
    await vi.waitFor(() => expect(internals.pendingConfirmations.size).toBe(1));
    const [confirmId] = [...internals.pendingConfirmations.keys()];

    const update = vi.fn().mockResolvedValue(undefined);
    await internals.handleButtonInteraction({
      user: { id: "u1" },
      member: null,
      channelId: "c1",
      customId: `${confirmId}:3`,
      reply: vi.fn(),
      update,
    });
    await expect(answer).resolves.toBe(LONG_OPTIONS[3]);
  });

  it("a prompt that could not be sent settles as not answered, not as 'cancelled'", async () => {
    const { ch, internals } = channel();
    internals.enqueueMessage = vi.fn().mockRejectedValue(new Error("Invalid Form Body"));
    await expect(ch.requestConfirmation({ chatId: "c1", question: "Confirm?", options: ["Yes", "No"] })).resolves.toBe("timeout");
  });

  it("a prompt pending at disconnect settles as not answered", async () => {
    const { ch, internals } = channel();
    internals.enqueueMessage = vi.fn().mockResolvedValue(undefined);
    const answer = ch.requestConfirmation({ chatId: "c1", question: "Confirm?", options: ["Yes", "No"] });
    await vi.waitFor(() => expect(internals.pendingConfirmations.size).toBe(1));
    await ch.disconnect();
    await expect(answer).resolves.toBe("timeout");
  });
});
