/**
 * Test harness for billed provider calls (task #71): installs the REAL process
 * ledger (createProviderUsageLedger over a real RateLimiter and a real
 * MetricsCollector) with a recording cost ledger, and scripted providers whose
 * replies carry the usage a test expects to see billed.
 */

import { vi, type Mock } from "vitest";
import { RateLimiter } from "../../security/rate-limiter.js";
import { MetricsCollector } from "../../dashboard/metrics.js";
import { installProviderUsageLedger } from "../../agents/providers/billed-call.js";
import { createProviderUsageLedger } from "../../agent-core/engine/accounting.js";
import type { BudgetSource, CostMetadata } from "../../budget/budget-types.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { ConversationMessage, ProviderResponse, TokenUsage } from "../../agents/providers/provider-core.interface.js";
import type { TaskUsageEvent } from "../../tasks/types.js";

export interface BookedCost {
  readonly amount: number;
  readonly source: BudgetSource;
  readonly metadata: CostMetadata;
}

export interface UsageLedgerHarness {
  readonly metrics: MetricsCollector;
  readonly rateLimiter: RateLimiter;
  /** What reached the cost ledger (UnifiedBudgetManager.recordCost) — calls no run owns. */
  readonly booked: BookedCost[];
  /** A run's onUsage, recording what reached it. */
  runSink(): { readonly onUsage: (usage: TaskUsageEvent) => void; readonly events: TaskUsageEvent[] };
  /** Tokens the counters saw: /api/metrics totals and the rate limiter's daily total. */
  counted(): { readonly input: number; readonly output: number; readonly dailyTokens: number };
  uninstall(): void;
}

export function installUsageLedgerHarness(): UsageLedgerHarness {
  const metrics = new MetricsCollector();
  const rateLimiter = new RateLimiter({});
  const booked: BookedCost[] = [];
  installProviderUsageLedger(
    createProviderUsageLedger({
      counters: { metrics, rateLimiter },
      budget: { recordCost: (amount, source, metadata) => booked.push({ amount, source, metadata }) },
    }),
  );
  return {
    metrics,
    rateLimiter,
    booked,
    runSink() {
      const events: TaskUsageEvent[] = [];
      return { onUsage: (usage) => events.push(usage), events };
    },
    counted() {
      const { totalTokens } = metrics.getSnapshot();
      return { input: totalTokens.input, output: totalTokens.output, dailyTokens: rateLimiter.getSnapshot().tokensToday };
    },
    uninstall: () => installProviderUsageLedger(undefined),
  };
}

export const usage = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

/** One scripted reply: text and the usage it bills (absent = the provider sent none), or a throw. */
export type ScriptedReply = { readonly text: string; readonly usage?: TokenUsage } | Error;

export type ScriptedProvider = IAIProvider & {
  readonly chat: Mock;
  readonly chatStream?: Mock;
  /** Every call's system prompt and messages, in order. */
  readonly calls: Array<{ readonly system: string; readonly messages: ConversationMessage[] }>;
};

/** A provider answering `replies` in order (the last repeats); `streaming` makes it a streaming provider. */
export function scriptedProvider(
  name: string,
  replies: readonly ScriptedReply[],
  opts: { readonly streaming?: boolean } = {},
): ScriptedProvider {
  let i = 0;
  const calls: Array<{ system: string; messages: ConversationMessage[] }> = [];
  const next = (system: string, messages: ConversationMessage[]): ProviderResponse => {
    calls.push({ system, messages });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return { text: r.text, toolCalls: [], stopReason: "end_turn", usage: r.usage } as ProviderResponse;
  };
  const provider = {
    name,
    capabilities: {
      maxTokens: 8192,
      streaming: opts.streaming === true,
      structuredStreaming: false,
      toolCalling: false,
      vision: true,
      systemPrompt: true,
    },
    calls,
    chat: vi.fn(async (system: string, messages: ConversationMessage[]) => {
      if (opts.streaming) throw new Error("chat() must not run when the provider streams");
      return next(system, messages);
    }),
    ...(opts.streaming
      ? {
          chatStream: vi.fn(async (system: string, messages: ConversationMessage[], _tools: unknown, onChunk: (c: string) => void) => {
            const response = next(system, messages);
            onChunk(response.text);
            return response;
          }),
        }
      : {}),
  };
  return provider as unknown as ScriptedProvider;
}
