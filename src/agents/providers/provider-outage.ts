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
    const registry = ProviderHealthRegistry.getInstance();
    const entries = registry.getAllEntries();
    const now = Date.now();

    // A DECLARED chain member with no health entry has never failed — it is
    // available capacity. Measured live 2026-08-31: openai+opencode were
    // cooling while opencode2/opencode3 (fresh accounts, never dialed, hence
    // no entry) sat unused, and the outage measure — which only walked
    // registry ENTRIES — reported a full outage, parking the campaign with
    // two working providers in the chain.
    if (liveChainMemberNames.size > 0) {
      const seen = new Set<string>();
      for (const [name] of entries) seen.add(name.toLowerCase());
      for (const member of liveChainMemberNames) {
        if (!seen.has(member)) return 0;
      }
    }

    let sawMember = false;
    let soonestActive = Number.POSITIVE_INFINITY;
    let anyUsable = false;
    for (const [name, entry] of entries) {
      if (!isCurrentChainMemberName(name)) continue;
      sawMember = true;
      if (entry.cooldownUntil > now) {
        soonestActive = Math.min(soonestActive, entry.cooldownUntil);
        continue;
      }
      // Cooldown expired — but a member that is still DOWN is not capacity.
      // Measured live 2026-09-03 18:39: three accounts held
      // FreeUsageLimitError 429s, their short cooldowns lapsed between the
      // failing probe and the settle, the outage measure read 0, and the
      // campaign charged Sprint 7 its second attempt for a wall it never got
      // to work behind.
      if (entry.status === "down") continue;
      anyUsable = true;
    }
    if (!sawMember || anyUsable) return 0;
    if (soonestActive === Number.POSITIVE_INFINITY) {
      // Every member is down with no timer to wait for: still an outage, and
      // the caller needs a horizon it can park on rather than a 0 that reads
      // as "capacity available".
      return 60_000;
    }
    return Math.max(0, soonestActive - now) + 1_000;
  } catch {
    return 0;
  }
}
