/**
 * Provider-chain readiness: the ONE verdict shared by setup save, `strada
 * doctor` and boot (plan 2.2, audit 10.3 / D26-D27).
 *
 * Until now each of the three read the same preflight result through its own
 * policy: setup refused to save when the primary failed, the doctor reported
 * any failure as FAIL, and boot ran on a fallback with a warning. The same
 * chain therefore produced three different answers to "is it ready?". Every
 * caller now hands its preflight result to `evaluateChainReadiness` and
 * renders the verdict it gets back, so "degraded" carries the same warning
 * text everywhere.
 */

import {
  formatProviderPreflightFailures,
  type ResponseProviderPreflightResult,
} from "./response-provider-preflight.js";

export type ChainReadinessState = "ready" | "degraded" | "unavailable";

export interface ChainReadinessPolicy {
  /**
   * The chain as requested, in order; the first entry is the primary. The
   * verdict names the primary when it failed so the person knows they are
   * getting a different model than they configured.
   */
  requestedProviderIds: readonly string[];
}

export interface ChainReadinessVerdict {
  state: ChainReadinessState;
  healthyProviderIds: string[];
  failedProviderIds: string[];
  primaryProviderId: string | null;
  primaryFailed: boolean;
  /** The provider that will actually answer first (null when unavailable). */
  activeProviderId: string | null;
  /** The single warning every surface shows for a degraded chain. */
  warning: string | null;
  /** The single error every surface shows for an unavailable chain. */
  error: string | null;
}

function normalize(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Turn a preflight result into the shared verdict.
 *
 * - no provider passed            -> "unavailable" (nothing can answer)
 * - some failed, at least one ok  -> "degraded"    (runs, on a fallback if the primary failed)
 * - all passed                    -> "ready"
 *
 * The primary failing is worth saying loudly but is never a reason to refuse
 * to run: measured 2026-08 the ChatGPT subscription was rate-limited for 6.7
 * days while a healthy Kimi key sat behind it in the chain.
 */
export function evaluateChainReadiness(
  result: ResponseProviderPreflightResult,
  policy: ChainReadinessPolicy,
): ChainReadinessVerdict {
  const requested = normalize(policy.requestedProviderIds);
  const healthy = normalize(result.passedProviderIds);
  const failed = normalize(result.failures.map((failure) => failure.providerId));
  const primaryProviderId = requested[0] ?? healthy[0] ?? failed[0] ?? null;
  const primaryFailed = primaryProviderId !== null && !healthy.includes(primaryProviderId);
  const activeProviderId = healthy[0] ?? null;
  const failureText = formatProviderPreflightFailures(result.failures);

  if (healthy.length === 0) {
    return {
      state: "unavailable",
      healthyProviderIds: healthy,
      failedProviderIds: failed,
      primaryProviderId,
      primaryFailed,
      activeProviderId: null,
      warning: null,
      error: `Configured AI providers failed preflight. ${failureText}`.trim(),
    };
  }

  if (failed.length === 0) {
    return {
      state: "ready",
      healthyProviderIds: healthy,
      failedProviderIds: failed,
      primaryProviderId,
      primaryFailed: false,
      activeProviderId,
      warning: null,
      error: null,
    };
  }

  const warning = primaryFailed
    ? `Primary AI provider "${primaryProviderId}" failed preflight; running on "${activeProviderId}" instead. ${failureText}`
    : `Some configured AI providers failed preflight and were skipped: ${failureText}`;

  return {
    state: "degraded",
    healthyProviderIds: healthy,
    failedProviderIds: failed,
    primaryProviderId,
    primaryFailed,
    activeProviderId,
    warning,
    error: null,
  };
}
