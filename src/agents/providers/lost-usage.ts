import type { ProviderResponse, TokenUsage } from "./provider-core.interface.js";

/** Sum two usages (the superseded attempt onto whatever is already carried). */
export function mergeTokenUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const add = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const cw = add(a.cacheCreationInputTokens, b.cacheCreationInputTokens);
  const cr = add(a.cacheReadInputTokens, b.cacheReadInputTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cw === undefined ? {} : { cacheCreationInputTokens: cw }),
    ...(cr === undefined ? {} : { cacheReadInputTokens: cr }),
  };
}

/** One chain member's share of the spend that did not become the answer. */
export interface LostUsagePart {
  readonly provider: string;
  readonly model?: string;
  readonly usage: TokenUsage;
}

/**
 * Tokens consumed by attempts that did not become the answer — an empty
 * response that fell over, a retry that failed (Codex 2026-09-17 #5). They ride
 * on the response that finally answers, or on the error when nothing does.
 * The error also says WHO spent them (`usageBy`), so the cost model prices each
 * part at that member's tariff instead of the fallback rate (task #90).
 */
export class LostUsage {
  private total: TokenUsage | undefined;
  private readonly parts: Array<{ provider: string; model?: string; usage: TokenUsage }> = [];

  constructor(private readonly member: (idx: number) => { provider: string; model?: string }) {}

  add(idx: number, usage: TokenUsage): void {
    this.total = mergeTokenUsage(this.total, usage);
    const { provider, model } = this.member(idx);
    const hit = this.parts.find((p) => p.provider === provider && p.model === model);
    if (hit) hit.usage = mergeTokenUsage(hit.usage, usage);
    else this.parts.push({ provider, ...(model === undefined ? {} : { model }), usage });
  }

  /** The lost spend on the response that finally answered. */
  onResponse(r: ProviderResponse): ProviderResponse {
    return this.total ? { ...r, auxiliaryUsage: mergeTokenUsage(r.auxiliaryUsage, this.total) } : r;
  }

  /** The lost spend, and who spent it, on the error thrown when nothing answered. */
  onError<E>(err: E): E {
    if (!this.total || !err || typeof err !== "object") return err;
    return Object.assign(err, { usage: this.total, usageBy: this.parts.map((p) => ({ ...p })) });
  }
}

/**
 * Drop the spend an error carries once it has been billed (billedChat bills a
 * throwing call's error.usage, then rethrows it). An error that travels on —
 * the fallback chain keeps its recovery probe's failure as lastError and can
 * rethrow it — would otherwise be billed a second time by the chain's caller
 * (task #72 QA: 9 tokens counted 18).
 */
export function forgetBilledUsage<E>(err: E): E {
  if (err && typeof err === "object") Object.assign(err, { usage: undefined, usageBy: undefined });
  return err;
}
