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
 *   preflight, the chain and the ProviderManager all run for real on top of
 *   it. Every call must be the step the script expects next; a call that is
 *   not is recorded with what it actually was, and the run fails on it.
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
import { MockAIProvider, type MockResponse } from "./mock-provider.js";
import { MockChannelAdapter } from "./mock-channel.js";

// ─── The script ──────────────────────────────────────────────────────────────

export interface ProviderCall {
  readonly systemPrompt: string;
  readonly messages: readonly ConversationMessage[];
  readonly tools: readonly ToolDefinition[];
}

export interface Step {
  /** What the loop is doing when it makes this call. */
  readonly step: string;
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
  readonly provider: MockAIProvider;
  /** The steps served so far, in order. */
  readonly served: string[];
  /** The call each served step answered, in the same order as `served`. */
  readonly calls: ProviderCall[];
  /** Every call that was not the step the script expected. */
  readonly violations: string[];
}

export function loadScript(script: readonly Step[]): ScriptedRun {
  const provider = new MockAIProvider({ name: "deepseek", streaming: false });
  const served: string[] = [];
  const calls: ProviderCall[] = [];
  const violations: string[] = [];
  provider.registerResponseHandler("golden-script", ({ systemPrompt, messages, tools }) => {
    // A copy: the loop may hand over the session's own array and keep appending to it.
    const call: ProviderCall = { systemPrompt, messages: [...messages], tools };
    const index = served.length + violations.length;
    const step = script[served.length];
    const problem = step ? step.check(call) : "the script has ended";
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
        `The call: ${describeCall(call)}`,
    );
    throw new Error(`golden run: unscripted provider call (${violations.at(-1)})`);
  });
  return { provider, served, calls, violations };
}

// ─── The factory edges ───────────────────────────────────────────────────────

/** One message the channel delivered, in the order it was sent. */
export interface Delivered {
  readonly chatId: string;
  readonly format: "plain" | "markdown";
  readonly text: string;
}

/** What bootstrap was handed. Set per run: the provider before boot, the channel by boot. */
export const edges = {
  provider: undefined as MockAIProvider | undefined,
  channel: undefined as MockChannelAdapter | undefined,
  /** Text and markdown, interleaved as sent: the adapter keeps them in two lists. */
  delivered: [] as Delivered[],
};

/** Before a boot: this run's provider, and nothing left from the run before it. */
export function resetEdges(provider: MockAIProvider): void {
  edges.provider = provider;
  edges.channel = undefined;
  edges.delivered.length = 0;
}

export async function scriptedProviderRegistry<T extends object>(importOriginal: () => Promise<T>): Promise<T> {
  const actual = await importOriginal();
  const scripted = (): MockAIProvider => {
    if (!edges.provider) throw new Error("golden run: a provider was built before the script was loaded");
    return edges.provider;
  };
  return { ...actual, createProvider: scripted, buildProviderChain: scripted };
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
