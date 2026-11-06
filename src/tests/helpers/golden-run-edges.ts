/**
 * The edges a golden run replaces, and the script its provider walks.
 *
 * A golden run (src/tests/integration/golden-run*.test.ts) runs the REAL
 * bootstrap() and replaces only the edges of the process. This module holds
 * the two factory edges and the script machinery. It imports nothing from the
 * product but types: the vi.mock factories in each golden-run file load it
 * while bootstrap's own imports are still resolving.
 *
 * - The provider factory. provider-registry's createProvider and
 *   buildProviderChain hand out one MockAIProvider walking the script, so the
 *   preflight and the ProviderManager run for real on top of it. Every call
 *   must be the step the script expects next; a call that is not is recorded
 *   with what it actually was, and the run fails on it.
 * - Or, for a run whose chain has several seats, the seats' provider classes
 *   (scriptedSeat): provider-registry runs for real, so buildProviderChain
 *   builds the real FallbackChainProvider over them and the real health
 *   registry decides which seat each call reaches. Every seat answers from
 *   the one script, and each step names the seat its call must reach.
 * - The channel factory. bootstrap-channels' initializeChannel hands out a
 *   MockChannelAdapter: the request enters through the real message handler
 *   bootstrap wires, and the answer leaves through the real progress reporter.
 * - The framework vault targets: none. Those vaults index this repository
 *   (into <checkout>/.strada/vault) and any Strada checkout beside it, in the
 *   background, on the CPU the run needs, and no step reads them.
 *
 * Each golden-run file declares, before any import:
 *
 *   vi.mock("../../agents/providers/provider-registry.js", async (original) =>
 *     (await import("../helpers/golden-run-edges.js")).scriptedProviderRegistry(original));
 *
 * and likewise for bootstrap-channels (scriptedChannels) and
 * framework-vault-targets (noFrameworkVaultTargets).
 */

import type {
  ConversationMessage,
  ToolDefinition,
} from "../../agents/providers/provider-core.interface.js";
import type { IAIProvider, IStreamingProvider } from "../../agents/providers/provider.interface.js";
import { MockAIProvider, type MockResponse } from "./mock-provider.js";
import { MockChannelAdapter } from "./mock-channel.js";

// ─── The script ──────────────────────────────────────────────────────────────

export interface ProviderCall {
  /** The chain seat that took the call, by its PROVIDER_CHAIN id. */
  readonly seat: string;
  readonly systemPrompt: string;
  readonly messages: readonly ConversationMessage[];
  readonly tools: readonly ToolDefinition[];
}

export interface Step {
  /** What the loop is doing when it makes this call. */
  readonly step: string;
  /** The seat the call must reach, by its PROVIDER_CHAIN id. The chain's first seat when unset. */
  readonly seat?: string;
  /** Undefined when the call is this step; otherwise what is wrong with it. */
  readonly check: (call: ProviderCall) => string | undefined;
  /** The provider's answer, or the error the provider fails the call with. */
  readonly reply: Partial<MockResponse> | Error;
}

export function textOf(message: ConversationMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? block.content : ""))
    .join("\n");
}

export function toolResultIds(message: ConversationMessage | undefined): string[] {
  if (!message || typeof message.content === "string") return [];
  return message.content.flatMap((block) => (block.type === "tool_result" ? [block.tool_use_id] : []));
}

export const offers = (call: ProviderCall, tool: string): boolean => call.tools.some((t) => t.name === tool);

export function describeCall(call: ProviderCall): string {
  const first = textOf(call.messages[0]).slice(0, 160).replace(/\s+/g, " ");
  const last = call.messages.at(-1);
  const lastText = textOf(last).slice(0, 160).replace(/\s+/g, " ");
  const lastResults = toolResultIds(last);
  return (
    `first message "${first}…"; ${call.messages.length} message(s), last from ${last?.role ?? "nobody"}` +
    `${lastResults.length > 0 ? ` carrying tool results [${lastResults.join(", ")}]` : ""}` +
    `${call.messages.length > 1 ? ` reading "${lastText}…"` : ""}; ` +
    `${call.tools.length} tool(s) offered${offers(call, "file_write") ? " including file_write" : ""}`
  );
}

export const requires = (problems: Array<string | false>): string | undefined =>
  problems.filter((p): p is string => typeof p === "string").join("; ") || undefined;

export const say = (text: string): Partial<MockResponse> => ({ text, toolCalls: [], stopReason: "end_turn" });

/** One scripted provider and what it has seen. */
export interface ScriptedRun {
  /** Answers every call, whichever seat took it, and keeps what the tools reported. */
  readonly provider: MockAIProvider;
  /** A seat of the chain, under the name its provider class gives it: it answers from the script. */
  readonly seat: (id: string, name: string) => IAIProvider & IStreamingProvider;
  /** The steps served so far, in order. */
  readonly served: string[];
  /** The call each served step answered, in the same order as `served`. */
  readonly calls: ProviderCall[];
  /** Every call that was not the step the script expected. */
  readonly violations: string[];
}

/**
 * `chain` is PROVIDER_CHAIN's seats, in order. A call made on the provider
 * itself (the provider-registry edge hands it out whole) is taken by the
 * first seat; a seat made by scriptedSeat says which seat it is.
 */
export function loadScript(script: readonly Step[], chain: readonly string[] = ["deepseek"]): ScriptedRun {
  const provider = new MockAIProvider({ name: "deepseek", streaming: false });
  const served: string[] = [];
  const calls: ProviderCall[] = [];
  const violations: string[] = [];
  // Set by a seat just before it hands the call on. The handler runs
  // synchronously at the start of the call, so it reads its own seat.
  let takenBy: string | undefined;
  provider.registerResponseHandler("golden-script", ({ systemPrompt, messages, tools }) => {
    const seat = takenBy ?? chain[0] ?? "(no seat)";
    takenBy = undefined;
    // A copy: the loop may hand over the session's own array and keep appending to it.
    const call: ProviderCall = { seat, systemPrompt, messages: [...messages], tools };
    const index = served.length + violations.length;
    const step = script[served.length];
    const expectedSeat = step?.seat ?? chain[0];
    const problem = !step
      ? "the script has ended"
      : seat !== expectedSeat
        ? `it reached ${seat}, not ${expectedSeat ?? "(no seat)"}`
        : step.check(call);
    if (step && !problem) {
      served.push(step.step);
      calls.push(call);
      if (step.reply instanceof Error) throw step.reply;
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        ...step.reply,
      };
    }
    violations.push(
      `call ${index} should be step ${served.length} "${step?.step ?? "(none)"}", but ${problem}. ` +
        `The call, on ${seat}: ${describeCall(call)}`,
    );
    throw new Error(`golden run: unscripted provider call (${violations.at(-1)})`);
  });
  const seat = (id: string, name: string): IAIProvider & IStreamingProvider => ({
    name,
    capabilities: provider.capabilities,
    chat: (systemPrompt, messages, tools) => {
      takenBy = id;
      return provider.chat(systemPrompt, messages, tools);
    },
    chatStream: (systemPrompt, messages, tools, onChunk) => {
      takenBy = id;
      return provider.chatStream(systemPrompt, messages, tools, onChunk);
    },
  });
  return { provider, seat, served, calls, violations };
}

// ─── The factory edges ───────────────────────────────────────────────────────

/** One message the channel delivered, in the order it was sent. */
export interface Delivered {
  readonly chatId: string;
  readonly format: "plain" | "markdown";
  readonly text: string;
}

/** What bootstrap was handed. Set per run: the script before boot, the channel by boot. */
export const edges = {
  run: undefined as ScriptedRun | undefined,
  channel: undefined as MockChannelAdapter | undefined,
  /** Text and markdown, interleaved as sent: the adapter keeps them in two lists. */
  delivered: [] as Delivered[],
};

/** Before a boot: this run's script, and nothing left from the run before it. */
export function resetEdges(run: ScriptedRun): void {
  edges.run = run;
  edges.channel = undefined;
  edges.delivered.length = 0;
}

export async function scriptedProviderRegistry<T extends object>(importOriginal: () => Promise<T>): Promise<T> {
  const actual = await importOriginal();
  const scripted = (): MockAIProvider => {
    if (!edges.run) throw new Error("golden run: a provider was built before the script was loaded");
    return edges.run.provider;
  };
  return { ...actual, createProvider: scripted, buildProviderChain: scripted };
}

/**
 * One seat's provider class, replaced by a seat of the script. provider-registry
 * builds it as it builds the real class, `new Class(apiKey, model, baseUrl,
 * label)`, and the seat takes the label as its name, as the real class does:
 * health and routing key on that name.
 *
 *   vi.mock("../../agents/providers/kimi.js", async (original) =>
 *     (await import("../helpers/golden-run-edges.js")).scriptedSeat(original, "KimiProvider", "kimi"));
 */
export async function scriptedSeat<T extends object>(importOriginal: () => Promise<T>, className: string, id: string): Promise<T> {
  const actual = await importOriginal();
  // A function, not a class: a constructor that returns an object hands back that object.
  function ScriptedSeat(_apiKey: string, _model?: string, _baseUrl?: string, label?: string): IAIProvider {
    if (!edges.run) throw new Error(`golden run: the ${id} seat was built before the script was loaded`);
    return edges.run.seat(id, label ?? id);
  }
  return { ...actual, [className]: ScriptedSeat };
}

export async function scriptedChannels<T extends object>(importOriginal: () => Promise<T>): Promise<T> {
  const actual = await importOriginal();
  return {
    ...actual,
    initializeChannel: async () => {
      const channel = new MockChannelAdapter({ channelType: "cli", name: "golden-run" });
      const { sendText, sendMarkdown } = channel;
      channel.sendText = async (chatId: string, text: string): Promise<void> => {
        edges.delivered.push({ chatId, format: "plain", text });
        await sendText.call(channel, chatId, text);
      };
      channel.sendMarkdown = async (chatId: string, markdown: string): Promise<void> => {
        edges.delivered.push({ chatId, format: "markdown", text: markdown });
        await sendMarkdown.call(channel, chatId, markdown);
      };
      edges.channel = channel;
      return channel;
    },
  };
}

export async function noFrameworkVaultTargets<T extends object>(importOriginal: () => Promise<T>): Promise<T> {
  const actual = await importOriginal();
  return { ...actual, frameworkVaultTargets: () => [] };
}
