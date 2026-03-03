/**
 * Mock Channel Adapter for Integration Tests
 * 
 * Provides a fully mockable IChannelAdapter implementation that captures
 * all sent messages and allows programmatic simulation of incoming messages.
 */

import { vi } from "vitest";
import type {
  IChannelAdapter,
  IChannelRichMessaging,
  IChannelInteractive,
  IChannelStreaming,
  IncomingMessage,
  Attachment,
  ChannelType,
  ConfirmationRequest,
} from "../../channels/channel.interface.js";

export interface MockChannelConfig {
  channelType: ChannelType;
  name: string;
  supportsStreaming?: boolean;
  supportsRichMessaging?: boolean;
  supportsInteractivity?: boolean;
  autoConfirm?: boolean;
}

export interface CapturedMessage {
  chatId: string;
  text: string;
  format?: "plain" | "markdown" | "html";
  timestamp: Date;
}

export interface CapturedConfirmation {
  chatId: string;
  question: string;
  options: string[];
  details?: string;
  response: string;
}

/**
 * Mock Channel Adapter that implements all channel interfaces.
 * Captures all sent messages for assertions.
 */
export class MockChannelAdapter
  implements IChannelAdapter, IChannelRichMessaging, IChannelInteractive, IChannelStreaming
{
  readonly name: string;
  readonly channelType: ChannelType;
  readonly supportsStreaming: boolean;
  readonly supportsRichMessaging: boolean;
  readonly supportsInteractivity: boolean;
  readonly autoConfirm: boolean;

  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private _healthy = true;

  // Captured outputs for assertions
  readonly sentMessages: CapturedMessage[] = [];
  readonly sentMarkdowns: CapturedMessage[] = [];
  readonly confirmations: CapturedConfirmation[] = [];
  readonly typingIndicators: string[] = [];
  readonly attachments: Array<{ chatId: string; attachment: Attachment }> = [];
  readonly streams: Map<string, { chatId: string; chunks: string[]; finalized: boolean }> = new Map();

  // Spy functions for detailed assertions
  readonly sendTextSpy = vi.fn<(chatId: string, text: string) => Promise<void>>();
  readonly sendMarkdownSpy = vi.fn<(chatId: string, markdown: string) => Promise<void>>();
  readonly sendTypingIndicatorSpy = vi.fn<(chatId: string) => Promise<void>>();
  readonly requestConfirmationSpy = vi.fn<(req: ConfirmationRequest) => Promise<string>>();
  readonly sendAttachmentSpy = vi.fn<(chatId: string, attachment: Attachment) => Promise<void>>();
  readonly startStreamingSpy = vi.fn<(chatId: string) => Promise<string | undefined>>();
  readonly updateStreamingSpy = vi.fn<(chatId: string, streamId: string, text: string) => Promise<void>>();
  readonly finalizeStreamingSpy = vi.fn<(chatId: string, streamId: string, text: string) => Promise<void>>();

  constructor(config: MockChannelConfig) {
    this.name = config.name;
    this.channelType = config.channelType;
    this.supportsStreaming = config.supportsStreaming ?? false;
    this.supportsRichMessaging = config.supportsRichMessaging ?? true;
    this.supportsInteractivity = config.supportsInteractivity ?? true;
    this.autoConfirm = config.autoConfirm ?? true;
  }

  // --------------------------------------------------------------------------
  // IChannelCore
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    // Connection established
  }

  async disconnect(): Promise<void> {
    this.messageHandler = undefined;
  }

  isHealthy(): boolean {
    return this._healthy;
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy;
  }

  // --------------------------------------------------------------------------
  // IChannelReceiver
  // --------------------------------------------------------------------------

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Simulate an incoming message from the channel.
   * This is the main method for triggering flows in tests.
   */
  async simulateIncomingMessage(
    chatId: string,
    text: string,
    userId = "test-user",
    attachments?: Attachment[],
    replyTo?: string
  ): Promise<void> {
    if (!this.messageHandler) {
      throw new Error("No message handler registered. Did you call onMessage()?");
    }

    const message: IncomingMessage = {
      channelType: this.channelType,
      chatId,
      userId,
      text,
      attachments,
      replyTo,
      timestamp: new Date(),
    };

    await this.messageHandler(message);
  }

  // --------------------------------------------------------------------------
  // IChannelSender
  // --------------------------------------------------------------------------

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({
      chatId,
      text,
      format: "plain",
      timestamp: new Date(),
    });
    await this.sendTextSpy(chatId, text);
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    this.sentMarkdowns.push({
      chatId,
      text: markdown,
      format: "markdown",
      timestamp: new Date(),
    });
    await this.sendMarkdownSpy(chatId, markdown);
  }

  // --------------------------------------------------------------------------
  // IChannelRichMessaging
  // --------------------------------------------------------------------------

  async sendTypingIndicator(chatId: string): Promise<void> {
    this.typingIndicators.push(chatId);
    await this.sendTypingIndicatorSpy(chatId);
  }

  async sendAttachment(chatId: string, attachment: Attachment): Promise<void> {
    this.attachments.push({ chatId, attachment });
    await this.sendAttachmentSpy(chatId, attachment);
  }

  // --------------------------------------------------------------------------
  // IChannelInteractive
  // --------------------------------------------------------------------------

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    const response = this.autoConfirm ? "Yes" : "No";
    this.confirmations.push({
      chatId: req.chatId,
      question: req.question,
      options: req.options,
      details: req.details,
      response,
    });
    await this.requestConfirmationSpy(req);
    return response;
  }

  /**
   * Simulate a manual confirmation response (for non-autoConfirm tests).
   */
  async simulateConfirmation(chatId: string, question: string, response: string): Promise<void> {
    // Find pending confirmation and respond
    const pending = this.confirmations.find(
      (c) => c.chatId === chatId && c.question === question && !c.response
    );
    if (pending) {
      pending.response = response;
    }
  }

  // --------------------------------------------------------------------------
  // IChannelStreaming
  // --------------------------------------------------------------------------

  async startStreamingMessage(chatId: string): Promise<string | undefined> {
    if (!this.supportsStreaming) return undefined;
    
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.streams.set(streamId, { chatId, chunks: [], finalized: false });
    await this.startStreamingSpy(chatId);
    return streamId;
  }

  async updateStreamingMessage(
    chatId: string,
    streamId: string,
    accumulatedText: string
  ): Promise<void> {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.chunks.push(accumulatedText);
    }
    await this.updateStreamingSpy(chatId, streamId, accumulatedText);
  }

  async finalizeStreamingMessage(
    chatId: string,
    streamId: string,
    finalText: string
  ): Promise<void> {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.chunks.push(finalText);
      stream.finalized = true;
    }
    await this.finalizeStreamingSpy(chatId, streamId, finalText);
  }

  // --------------------------------------------------------------------------
  // Utility Methods for Test Assertions
  // --------------------------------------------------------------------------

  /**
   * Get all messages sent to a specific chat.
   */
  getMessagesForChat(chatId: string): CapturedMessage[] {
    return this.sentMessages.filter((m) => m.chatId === chatId);
  }

  /**
   * Get all markdown messages sent to a specific chat.
   */
  getMarkdownsForChat(chatId: string): CapturedMessage[] {
    return this.sentMarkdowns.filter((m) => m.chatId === chatId);
  }

  /**
   * Check if any message contains the given text.
   */
  hasMessageContaining(text: string, chatId?: string): boolean {
    const messages = chatId ? this.getMessagesForChat(chatId) : this.sentMessages;
    return messages.some((m) => m.text.includes(text));
  }

  /**
   * Check if any markdown contains the given text.
   */
  hasMarkdownContaining(text: string, chatId?: string): boolean {
    const markdowns = chatId ? this.getMarkdownsForChat(chatId) : this.sentMarkdowns;
    return markdowns.some((m) => m.text.includes(text));
  }

  /**
   * Get the last message sent to a chat.
   */
  getLastMessage(chatId: string): CapturedMessage | undefined {
    const messages = this.getMessagesForChat(chatId);
    return messages[messages.length - 1];
  }

  /**
   * Get the last markdown sent to a chat.
   */
  getLastMarkdown(chatId: string): CapturedMessage | undefined {
    const markdowns = this.getMarkdownsForChat(chatId);
    return markdowns[markdowns.length - 1];
  }

  /**
   * Clear all captured messages.
   */
  clear(): void {
    this.sentMessages.length = 0;
    this.sentMarkdowns.length = 0;
    this.confirmations.length = 0;
    this.typingIndicators.length = 0;
    this.attachments.length = 0;
    this.streams.clear();
  }

  /**
   * Assert that a confirmation was requested.
   */
  assertConfirmationRequested(
    expectedQuestion?: string,
    expectedChatId?: string
  ): void {
    if (this.confirmations.length === 0) {
      throw new Error("Expected confirmation to be requested, but none was made");
    }
    if (expectedQuestion) {
      const found = this.confirmations.some((c) => c.question.includes(expectedQuestion));
      if (!found) {
        throw new Error(
          `Expected confirmation with question containing "${expectedQuestion}", but got: ${
            this.confirmations.map((c) => c.question).join(", ")
          }`
        );
      }
    }
    if (expectedChatId) {
      const found = this.confirmations.some((c) => c.chatId === expectedChatId);
      if (!found) {
        throw new Error(
          `Expected confirmation for chat ${expectedChatId}, but got confirmations for: ${
            this.confirmations.map((c) => c.chatId).join(", ")
          }`
        );
      }
    }
  }
}

/**
 * Create a Telegram mock channel.
 */
export function createMockTelegramChannel(config?: Partial<MockChannelConfig>): MockChannelAdapter {
  return new MockChannelAdapter({
    channelType: "telegram",
    name: "mock-telegram",
    supportsStreaming: true,
    supportsRichMessaging: true,
    supportsInteractivity: true,
    autoConfirm: true,
    ...config,
  });
}

/**
 * Create a Discord mock channel.
 */
export function createMockDiscordChannel(config?: Partial<MockChannelConfig>): MockChannelAdapter {
  return new MockChannelAdapter({
    channelType: "discord",
    name: "mock-discord",
    supportsStreaming: true,
    supportsRichMessaging: true,
    supportsInteractivity: true,
    autoConfirm: true,
    ...config,
  });
}

/**
 * Create a CLI mock channel.
 */
export function createMockCliChannel(config?: Partial<MockChannelConfig>): MockChannelAdapter {
  return new MockChannelAdapter({
    channelType: "cli",
    name: "mock-cli",
    supportsStreaming: false,
    supportsRichMessaging: false,
    supportsInteractivity: false,
    autoConfirm: true,
    ...config,
  });
}

/**
 * Create a Slack mock channel.
 */
export function createMockSlackChannel(config?: Partial<MockChannelConfig>): MockChannelAdapter {
  return new MockChannelAdapter({
    channelType: "slack",
    name: "mock-slack",
    supportsStreaming: true,
    supportsRichMessaging: true,
    supportsInteractivity: true,
    autoConfirm: true,
    ...config,
  });
}
