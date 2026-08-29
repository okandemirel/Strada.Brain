/**
 * Full-provider-outage measurement, shared by every layer that must decide
 * "wait it out" vs "retry now" (mission keep-alive, goal auto-resume, campaign
 * self-revival).
 *
 * Registry keys are historical (removed providers, "chain(a→b)" aliases), so
 * bootstrap declares the composed chain's live members after preflight;
 * everything else is ignored. A de-configured provider's stale healthy entry
 * ("kimi", cooldownUntil 0) must never read as available capacity — measured
 * live 2026-08-29 12:27: both chain members cooling ~7.7h on quota, yet the
 * outage measured as "someone is free" and retries fired into the wall.
 */
import { ProviderHealthRegistry } from "./provider-health.js";

const liveChainMemberNames = new Set<string>();

/** Called by bootstrap once the provider chain's final order is known. */
export function setLiveChainMemberNames(names: readonly string[]): void {
  liveChainMemberNames.clear();
  for (const name of names) {
    const n = name.trim().toLowerCase();
    if (n) liveChainMemberNames.add(n);
  }
}

export function isCurrentChainMemberName(registryName: string): boolean {
  const n = registryName.toLowerCase();
  if (n.startsWith("chain(")) return false;
  // Until bootstrap declares the chain, keep the permissive legacy reading —
  // a wrongly-empty set must fail toward "retry sooner", never "wait longer".
  if (liveChainMemberNames.size === 0) return true;
  return liveChainMemberNames.has(n);
}

/**
 * Milliseconds until the SOONEST live chain member exits cooldown, or 0 when
 * at least one member is available right now (or health state is unreadable —
 * unknown health must fail toward retrying, not waiting).
 */
export function allProvidersCoolingDownMs(): number {
  try {
    const entries = ProviderHealthRegistry.getInstance().getAllEntries();
    const now = Date.now();
    let sawMember = false;
    let soonestActive = Number.POSITIVE_INFINITY;
    for (const [name, entry] of entries) {
      if (!isCurrentChainMemberName(name)) continue;
      sawMember = true;
      if (entry.cooldownUntil <= now) return 0; // a member is available
      soonestActive = Math.min(soonestActive, entry.cooldownUntil);
    }
    if (!sawMember) return 0;
    return Math.max(0, soonestActive - now) + 1_000;
  } catch {
    return 0;
  }
}
