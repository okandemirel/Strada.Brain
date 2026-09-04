import { describe, expect, it, afterEach } from "vitest";
import { ProviderHealthRegistry } from "./provider-health.js";
import { recordProviderHealthFailure } from "../orchestrator-runtime-utils.js";

const registry = ProviderHealthRegistry.getInstance();
const NAME = "q-reset-probe";
afterEach(() => registry.clearProviderState(NAME));

/**
 * Measured live 2026-09-04 17:48: the provider said "(resets in ~1h)" and was
 * benched for the 8h default because the structured error had been flattened
 * to a string. Seven hours of a parked campaign, for a wall the provider had
 * already told us was an hour deep.
 */
describe("a stated reset sizes the quota bench", () => {
  const remainingMs = (): number =>
    (registry.getAllEntries().get(NAME)?.cooldownUntil ?? 0) - Date.now();

  it("uses the reset the message states when the structured value is gone", () => {
    recordProviderHealthFailure(
      registry,
      NAME,
      "OpenAI usage quota exhausted (resets in ~1h): The usage limit has been reached",
    );
    const left = remainingMs();
    // ~1h, not the 8h default.
    expect(left).toBeGreaterThan(50 * 60_000);
    expect(left).toBeLessThan(70 * 60_000);
  });

  it("still falls back to the default when the message states nothing", () => {
    recordProviderHealthFailure(registry, NAME, "OpenAI usage quota exhausted: no reset given");
    expect(remainingMs()).toBeGreaterThan(2 * 3_600_000);
  });

  it("prefers the structured value over the sentence", () => {
    recordProviderHealthFailure(
      registry,
      NAME,
      "OpenAI usage quota exhausted (resets in ~1h)",
      { retryAfterMs: 4 * 3_600_000 },
    );
    expect(remainingMs()).toBeGreaterThan(3 * 3_600_000);
  });
});
