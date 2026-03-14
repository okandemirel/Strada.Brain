/**
 * Microsoft Teams Channel - Bot Framework adapter
 *
 * Requires: botframework-connector, botbuilder (npm install botbuilder)
 * Config: TEAMS_APP_ID, TEAMS_APP_PASSWORD
 */

import type { IChannelAdapter } from "../channel.interface.js";
import type { IncomingMessage } from "../channel-messages.interface.js";
import { getLogger } from "../../utils/logger.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export class TeamsChannel implements IChannelAdapter {
  readonly name = "teams";

  private handler: MessageHandler | null = null;
  private adapter: BotAdapterLike | null = null;
  private server: import("node:http").Server | null = null;
  private healthy = false;

  constructor(
    private readonly appId: string,
    private readonly appPassword: string,
    private readonly port: number = 3978,
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CloudAdapter, ConfigurationBotFrameworkAuthentication } =
      await import("botbuilder" as string);

    const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppType: "MultiTenant",
    });

    this.adapter = new CloudAdapter(botFrameworkAuth) as unknown as BotAdapterLike;

    // Create HTTP server for Bot Framework messages
    const { createServer } = await import("node:http");
    this.server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/messages") {
        await (this.adapter as BotAdapterLike).process(req, res, async (context: TurnContextLike) => {
          if (context.activity.type === "message" && context.activity.text) {
            const msg: IncomingMessage = {
              channelType: "teams",
              chatId: context.activity.conversation.id,
              userId: context.activity.from.id,
              text: context.activity.text,
              timestamp: new Date(context.activity.timestamp ?? Date.now()),
            };

            await this.handler?.(msg);
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });

    this.healthy = true;
    logger.info("Teams channel listening", { port: this.port });
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async sendText(_chatId: string, _text: string): Promise<void> {
    // Teams responses are sent via TurnContext during the activity handler.
    // Out-of-band proactive messaging requires ConversationReference storage
    // which will be implemented when Teams is fully integrated.
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    await this.sendText(chatId, markdown);
  }
}

// Minimal type stubs
interface BotAdapterLike {
  process(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    logic: (context: TurnContextLike) => Promise<void>,
  ): Promise<void>;
}

interface TurnContextLike {
  activity: {
    type: string;
    text?: string;
    conversation: { id: string };
    from: { id: string };
    timestamp?: string;
  };
  sendActivity(text: string): Promise<void>;
}
