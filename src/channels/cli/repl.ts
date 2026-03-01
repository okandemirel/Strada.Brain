import * as readline from "node:readline";
import type {
  IChannelAdapter,
  IncomingMessage,
  ConfirmationRequest,
} from "../channel.interface.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * CLI REPL channel for local development and testing.
 * Allows interacting with Strata Brain directly from the terminal.
 */
export class CLIChannel implements IChannelAdapter {
  readonly name = "cli";

  private rl: readline.Interface | null = null;
  private handler: MessageHandler | null = null;
  private healthy = false;
  private processing = false;

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.healthy = true;

    console.log("\n=== Strata Brain CLI ===");
    console.log("Type your messages below. Type 'exit' or 'quit' to stop.\n");

    this.promptNext();
  }

  async disconnect(): Promise<void> {
    this.healthy = false;
    this.rl?.close();
    this.rl = null;
    console.log("\nStrata Brain CLI disconnected.");
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
      const prompt = `\n${req.question}\n${req.details ? req.details + "\n" : ""}${optionStr}\nChoice: `;

      const timeout = setTimeout(() => {
        resolve("timeout");
      }, 60_000);

      this.rl!.question(prompt, (answer) => {
        clearTimeout(timeout);
        const idx = parseInt(answer.trim(), 10) - 1;
        if (idx >= 0 && idx < req.options.length) {
          resolve(req.options[idx]!);
        } else {
          resolve(req.options[0]!);
        }
      });
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private promptNext(): void {
    if (!this.rl || !this.healthy) return;

    this.rl.question("you> ", async (input) => {
      const trimmed = input.trim();

      if (trimmed === "exit" || trimmed === "quit") {
        await this.disconnect();
        // Emit SIGINT for graceful shutdown instead of hard exit
        process.kill(process.pid, "SIGINT");
        return;
      }

      if (!trimmed) {
        this.promptNext();
        return;
      }

      if (!this.handler) {
        console.log("Brain not ready yet.");
        this.promptNext();
        return;
      }

      if (this.processing) {
        console.log("Still processing previous message...");
        this.promptNext();
        return;
      }

      this.processing = true;

      const msg: IncomingMessage = {
        channelType: "cli",
        chatId: "cli-local",
        userId: "cli-user",
        text: trimmed,
        timestamp: new Date(),
      };

      try {
        await this.handler(msg);
      } catch (error) {
        console.error(
          "Error:",
          error instanceof Error ? error.message : "Unknown error"
        );
      } finally {
        this.processing = false;
        this.promptNext();
      }
    });
  }
}
