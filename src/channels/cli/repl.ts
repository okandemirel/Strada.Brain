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
  /**
   * Set when stdin hit EOF while a message was in flight or queued: the
   * shutdown is deferred to drainInputQueue's finally so the run is not killed
   * mid-task (audited 2026-09-02).
   */
  private shutdownAfterDrain = false;
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
      if (!this.healthy) return;
      // Resolve any pending confirmation so its awaiting tool promise doesn't
      // hang past shutdown; 'timeout' is treated as "do not proceed".
      this.pendingConfirmation?.finalize("timeout");
      this.rl = null;
      // Was: SIGINT unconditionally. Over a pipe readline emits 'line' then
      // 'close' immediately, so the kill landed while the handler was still
      // running — the run died mid-task, queued lines were discarded, and the
      // process exited 0 without an answer. Defer the shutdown until the queue
      // drains; nothing more can arrive since stdin is gone (audited 2026-09-02).
      const queued = this.pendingInputs.length;
      if (this.processing || queued > 0) {
        this.shutdownAfterDrain = true;
        console.log(
          `\nStdin closed (EOF). Finishing ${this.processing ? "the in-flight message" : "queued input"}` +
            `${queued > 0 ? ` and ${queued} queued input(s)` : ""} before shutting down...`,
        );
        return;
      }
      this.shutdownNow();
    });
    this.rl.on("line", (input) => {
      void this.handleLine(input);
    });

    this.healthy = true;

    console.log("\n=== Strada Brain CLI ===");
    console.log("Type your messages below. Type 'exit' or 'quit' to stop.\n");

    this.showUserPrompt();
  }

  /** Mark unhealthy and ask the process to shut down (stdin is gone). */
  private shutdownNow(): void {
    console.log("\nStdin closed (EOF). Shutting down CLI...");
    this.healthy = false;
    this.shutdownAfterDrain = false;
    process.kill(process.pid, "SIGINT");
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    this.shutdownAfterDrain = false;
    if (this.pendingInputs.length > 0) {
      // Do not silently truncate the FIFO: say how many inputs never ran.
      console.log(`\nDiscarding ${this.pendingInputs.length} queued input(s) not yet processed.`);
    }
    this.pendingInputs.length = 0;
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
      // No interactive input available (post-EOF/shutdown): never auto-approve.
      // Returning 'timeout' makes the write-gate / ask-user treat this as
      // "do not proceed" rather than selecting the first option (e.g. "Yes").
      return "timeout";
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
        console.log("\nNo response received (timed out).");
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
    // Re-render the FULL accumulated text on each update. The previous
    // implementation wrote only the last line (`\r\x1b[K<lastLine>`), so
    // multi-line responses showed only their final line while streaming and
    // earlier lines were dropped until finalize. Clear the current line and
    // print the whole accumulated text so nothing is lost mid-stream.
    process.stdout.write(`\r\x1b[K${accumulatedText}`);
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
      // A clean integer in [1..options.length] selects that option; anything
      // else is treated as a free-form answer and passed through verbatim
      // (ask_user tells the user "you can pick an option or write your own
      // answer"). Previously any non-numeric/out-of-range input was silently
      // coerced to the first option, discarding the user's real answer.
      const options = this.pendingConfirmation.options;
      const idx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) - 1 : -1;
      let value: string;
      if (idx >= 0 && idx < options.length) {
        value = options[idx]!;
      } else if (trimmed) {
        value = trimmed;
      } else {
        value = "timeout";
      }
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
    if (!this.healthy || this.processing || this.pendingConfirmation || !this.handler) {
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
      if (this.shutdownAfterDrain && this.pendingInputs.length === 0 && this.healthy) {
        // Deferred EOF shutdown: the last message has been answered.
        this.shutdownNow();
      } else if (!this.pendingConfirmation) {
        this.showUserPrompt();
      }
    }
  }
}
