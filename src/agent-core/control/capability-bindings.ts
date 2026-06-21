/**
 * Agent Core v2 — CapabilityRegistry app bindings + seeding (Phase 3b wiring, step 1).
 *
 * The pure policy connecting THIS app's tools + substrates to the generic `CapabilityRegistry`:
 *   - `capabilityForTool` maps a tool's metadata to the substrate capability it depends on;
 *   - `seedCapabilities` registers the known substrates with an initial status derived from real
 *     boot-time health signals — the load-bearing trap-avoider (a freshly-`unknown` registry would
 *     make the read-path advertise filter withhold every tool; correct seeding prevents that).
 *
 * ADDITIVE: shipped + tested in isolation here. The instance construction (bootstrap) + the read-path
 * (`advertise` into the tool list) and write-path (`guardExecute` around tool execution) wiring are
 * subsequent increments, in the trap-free order: instance+seeding → write-path → read-path.
 */

import type { CapabilityRegistry } from "./capability-registry.js";

/** The substrate capability ids this app distinguishes (the binding keys). */
export const CAPABILITY_IN_PROCESS = "in-process";
export const CAPABILITY_MCP_STRADA = "mcp:strada";
export const CAPABILITY_DOTNET = "dotnet-cli";
export const CAPABILITY_NETWORK = "network";

/** A tool's substrate-relevant metadata — structural, so this never couples to the concrete ToolMetadata. */
export interface ToolCapabilityMeta {
  readonly requiresBridge?: boolean;
  readonly category?: string;
}

/**
 * Map a tool's metadata to the substrate capability it depends on:
 *   - `requiresBridge` → the Unity/MCP bridge (`mcp:strada`);
 *   - DOTNET category → the dotnet CLI;
 *   - BROWSER category → network;
 *   - everything else runs in-process.
 * Pure + total (an unknown/absent category falls to in-process). Finer bindings (e.g. a distinct
 * STT/network split) can be refined when the read/write paths are wired — nothing reads this yet.
 */
export function capabilityForTool(meta: ToolCapabilityMeta | undefined): string {
  if (meta?.requiresBridge) return CAPABILITY_MCP_STRADA;
  // NB: the real ToolCategory VALUES are lowercase ("dotnet"/"browser"); `.toUpperCase()` normalizes
  // both the enum value and a hand-written uppercase string. These case labels are the NORMALIZED
  // values, NOT ToolCategory keys — do not "lowercase" them, or the normalized match breaks.
  switch ((meta?.category ?? "").toUpperCase()) {
    case "DOTNET":
      return CAPABILITY_DOTNET;
    case "BROWSER":
      return CAPABILITY_NETWORK;
    default:
      return CAPABILITY_IN_PROCESS;
  }
}

/** Boot-time substrate health signals used to seed the registry. */
export interface CapabilitySeedSignals {
  /** The MCP/Unity bridge connected state at boot — the one substrate with a liveness signal + revive. */
  readonly mcpConnected?: boolean;
}

/**
 * Seed the registry with the known substrates + their initial status:
 *   - `in-process` → `live` (no external substrate to probe; always live).
 *   - `network` → `live` (OPTIMISTIC and deliberate: there is no network liveness probe, so seeding
 *     `unknown` would withhold browser/STT tools FOREVER; let real transport failures cool it).
 *   - `dotnet-cli` → `live` (OPTIMISTIC: re-probing here would re-spawn `dotnet --version`; dotnet's
 *     absence is already handled by the existing `ToolMetadata.available` gate the advertise filter
 *     AND-s with — until `available` is demoted to a CapabilityState projection in a later increment,
 *     at which point dotnet gets a real liveness feed).
 *   - `mcp:strada` → `live` iff the bridge is connected, else `unknown` (withheld but revivable —
 *     NEVER `down`, which is the escalated-failure state with a cooldown). The one substrate with a
 *     real boot-time signal + a revive path.
 */
export function seedCapabilities(registry: CapabilityRegistry, signals: CapabilitySeedSignals): void {
  registry.register(CAPABILITY_IN_PROCESS, "live");
  registry.register(CAPABILITY_NETWORK, "live");
  registry.register(CAPABILITY_DOTNET, "live");
  registry.register(CAPABILITY_MCP_STRADA, signals.mcpConnected ? "live" : "unknown");
}
