import * as readline from "node:readline";
import type {
  IChannelAdapter,
  IncomingMessage,
  ConfirmationRequest,
} from "../channel.interface.js";
import { limitIncomingText } from "../channel-messages.interface.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/** Callback for feedback reactions (thumbs up/down) from channel adapters. */
type FeedbackReactionCallback = (
  type: "thumbs_up" | "thumbs_down",
  instinctIds: string[],
  userId?: string,
  source?: "reaction" | "button",
) => void;

interface PendingCliConfirmation {
  options: string[];
  finalize: (value: string) => void;
}

/**
 * CLI REPL channel for local development and testing.
 * Allows interacting with Strada Brain directly from the terminal.
 */
export class CLIChannel implements IChannelAdapter {
  readonly name = "cli";

  private rl: readline.Interface | null = null;
  private handler: MessageHandler | null = null;
  private healthy = false;
  private processing = false;
  private readonly pendingInputs: string[] = [];
  private pendingConfirmation: PendingCliConfirmation | null = null;
  private feedbackReactionCallback: FeedbackReactionCallback | null = null;
  /** Per-chatId applied instinct IDs for feedback attribution. */
  private readonly appliedInstinctIds = new Map<string, string[]>();

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a callback for feedback reactions (thumbs up/down). */
  setFeedbackHandler(callback: FeedbackReactionCallback | null): void {
    this.feedbackReactionCallback = callback;
  }

  /** Set the applied instinct IDs for a chat so feedback can be attributed. */
  setAppliedInstinctIds(chatId: string, instinctIds: string[]): void {
    if (instinctIds.length > 0) {
      this.appliedInstinctIds.set(chatId, instinctIds);
    } else {
      this.appliedInstinctIds.delete(chatId);
    }
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Handle stdin EOF (Ctrl+D or piped input ending) to prevent infinite hang
    this.rl.on("close", () => {
      if (this.healthy) {
        console.log("\nStdin closed (EOF). Shutting down CLI...");
        this.healthy = false;
        this.rl = null;
        process.kill(process.pid, "SIGINT");
      }
    });
    this.rl.on("line", (input) => {
      void this.handleLine(input);
    });

    this.healthy = true;

    console.log("\n=== Strada Brain CLI ===");
    console.log("Type your messages below. Type 'exit' or 'quit' to stop.\n");

    this.showUserPrompt();
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    this.pendingConfirmation?.finalize("timeout");
    this.rl?.close();
    this.rl = null;
    console.log("\nStrada Brain CLI disconnected.");
  }

  async sendText(_chatId: string, text: string): Promise<void> {
    console.log(`\n${text}\n`);
  }

  async sendMarkdown(_chatId: string, markdown: string): Promise<void> {
    // In CLI, just output the markdown as-is (terminals handle it reasonably)
    console.log(`\n${markdown}\n`);
  }

  async sendTypingIndicator(_chatId: string): Promise<void> {
    // No-op for CLI
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<string> {
    if (!this.rl) {
      return req.options[0] ?? "timeout";
    }

    return new Promise<string>((resolve) => {
      const optionStr = req.options.map((o, i) => `${i + 1}) ${o}`).join("  ");
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const finalize = (value: string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (this.pendingConfirmation?.finalize === finalize) {
          this.pendingConfirmation = null;
        }
        resolve(value);
        this.showUserPrompt();
        void this.drainInputQueue();
      };

      this.pendingConfirmation = {
        options: req.options,
        finalize,
      };

      console.log(`\n${req.question}`);
      if (req.details) {
        console.log(req.details);
      }
      console.log(optionStr);

      timeoutId = setTimeout(() => {
        finalize("timeout");
      }, 60_000);

      this.showConfirmationPrompt();
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async startStreamingMessage(_chatId: string): Promise<string | undefined> {
    process.stdout.write("\n");
    return "cli-stream";
  }

  async updateStreamingMessage(_chatId: string, _streamId: string, accumulatedText: string): Promise<void> {
    // Write the latest line of the accumulated text
    const lastLine = accumulatedText.split("\n").pop() ?? "";
    process.stdout.write(`\r\x1b[K${lastLine}`);
  }

  async finalizeStreamingMessage(_chatId: string, _streamId: string, finalText: string): Promise<void> {
    process.stdout.write(`\r\x1b[K`);
    console.log(finalText);
    console.log();
  }

  private showUserPrompt(): void {
    if (!this.rl || !this.healthy || this.pendingConfirmation) return;
    this.rl.setPrompt("you> ");
    this.rl.prompt();
  }

  private showConfirmationPrompt(): void {
    if (!this.rl || !this.healthy || !this.pendingConfirmation) return;
    this.rl.setPrompt("Choice: ");
    this.rl.prompt();
  }

  private async handleLine(input: string): Promise<void> {
    const trimmed = input.trim();

    if (this.pendingConfirmation) {
      const idx = parseInt(trimmed, 10) - 1;
      const value = idx >= 0 && idx < this.pendingConfirmation.options.length
        ? this.pendingConfirmation.options[idx]!
        : this.pendingConfirmation.options[0] ?? "timeout";
      this.pendingConfirmation.finalize(value);
      return;
    }

    if (trimmed === "exit" || trimmed === "quit") {
      await this.disconnect();
      process.kill(process.pid, "SIGINT");
      return;
    }

    // Detect feedback commands before routing to the normal handler
    const feedbackType = this.detectFeedback(trimmed);
    if (feedbackType) {
      const sent = this.fireFeedback(feedbackType, "cli-local", "cli-user");
      if (sent) {
        console.log(
          feedbackType === "thumbs_up"
            ? "\nThanks for the positive feedback!\n"
            : "\nThanks for the feedback. I'll try to improve.\n",
        );
      } else {
        console.log("\nNo recent response to give feedback on.\n");
      }
      this.showUserPrompt();
      return;
    }

    if (!trimmed) {
      this.showUserPrompt();
      return;
    }

    if (!this.handler) {
      console.log("Brain not ready yet.");
      this.showUserPrompt();
      return;
    }

    this.pendingInputs.push(trimmed);
    this.showUserPrompt();
    void this.drainInputQueue();
  }

  /**
   * Detect standalone feedback in input text.
   * Recognises emoji thumbs (👍 / 👎) and `/feedback up` / `/feedback down`.
   */
  private detectFeedback(text: string): "thumbs_up" | "thumbs_down" | null {
    if (text === "\uD83D\uDC4D" || text === "/feedback up") {
      return "thumbs_up";
    }
    if (text === "\uD83D\uDC4E" || text === "/feedback down") {
      return "thumbs_down";
    }
    return null;
  }

  /** Fire the feedback callback with stored instinct IDs. Returns true if feedback was actually sent. */
  private fireFeedback(
    type: "thumbs_up" | "thumbs_down",
    chatId: string,
    userId?: string,
  ): boolean {
    if (!this.feedbackReactionCallback) return false;
    const instinctIds = this.appliedInstinctIds.get(chatId);
    if (!instinctIds || instinctIds.length === 0) return false;
    this.feedbackReactionCallback(type, instinctIds, userId, "reaction");
    return true;
  }

  private async drainInputQueue(): Promise<void> {
    if (this.processing || this.pendingConfirmation || !this.handler) {
      return;
    }

    this.processing = true;

    try {
      while (this.pendingInputs.length > 0 && !this.pendingConfirmation) {
        const nextInput = this.pendingInputs.shift()!;
        const msg: IncomingMessage = {
          channelType: "cli",
          chatId: "cli-local",
          userId: "cli-user",
          text: limitIncomingText(nextInput),
          timestamp: new Date(),
        };

        try {
          await this.handler(msg);
        } catch (error) {
          console.error(
            "Error:",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }
    } finally {
      this.processing = false;
      if (!this.pendingConfirmation) {
        this.showUserPrompt();
      }
    }
  }
}
