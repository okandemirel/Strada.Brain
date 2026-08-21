/**
 * The registry and the assigner must mean the same provider.
 *
 * Measured 2026-08-21, runs 30-34: Kimi was out of quota, the health file said
 * so ("kimi (moonshot)": down, eight-hour cooldown), and the supervisor handed
 * it goal after goal anyway. ProviderAssigner canonicalizes a provider's name
 * before asking about it — it asked `isAvailable("kimi")` — while the registry
 * keyed the record under the display name it happened to be told, "Kimi
 * (Moonshot)". The lookup missed, a miss reads as healthy, and the only
 * component that decides who gets work saw a dead provider as alive.
 *
 * Persistence was never the defect. The two halves disagreed on the name.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalizeProviderName } from "./provider-identity.js";
import { ProviderHealthRegistry } from "./provider-health.js";

const QUOTA =
  'Kimi (Moonshot) API error 403: {"error":{"message":"You have reached your usage limit"}}';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("one provider, one name", () => {
  it("answers the canonical name the assigner actually asks", () => {
    const registry = new ProviderHealthRegistry();
    registry.recordQuotaExhausted("Kimi (Moonshot)", QUOTA);

    // This is verbatim what ProviderAssigner does before calling isAvailable.
    const asked = canonicalizeProviderName("Kimi (Moonshot)") ?? "Kimi (Moonshot)";

    expect(asked).toBe("kimi");
    expect(registry.isAvailable(asked), "the assigner would hand goals to a dead provider").toBe(
      false,
    );
  });

  it("agrees whichever spelling either side happens to hold", () => {
    const registry = new ProviderHealthRegistry();
    registry.recordQuotaExhausted("kimi", QUOTA);

    for (const spelling of ["kimi", "Kimi (Moonshot)", "kimi (moonshot)", "  KIMI  "]) {
      expect(registry.isAvailable(spelling), `${spelling} disagrees with the others`).toBe(false);
    }
  });

  it("still tracks a provider it has never heard of", () => {
    // canonicalizeProviderName returns undefined for these; they must not all
    // collapse into one shared entry.
    const registry = new ProviderHealthRegistry();
    registry.recordQuotaExhausted("some-private-gateway", QUOTA);

    expect(registry.isAvailable("some-private-gateway")).toBe(false);
    expect(registry.isAvailable("Some-Private-Gateway")).toBe(false);
    expect(registry.isAvailable("another-gateway")).toBe(true);
  });

  it("reads a file written under the old display-name key", () => {
    // The persisted files on disk are keyed "kimi (moonshot)". After this fix
    // the lookup canonicalizes to "kimi", so load() has to re-key them or every
    // cooldown written before today is silently lost.
    const dir = mkdtempSync(join(tmpdir(), "health-name-"));
    dirs.push(dir);
    const file = join(dir, "provider-health.json");
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          [
            "kimi (moonshot)",
            {
              status: "down",
              consecutiveFailures: 1,
              lastFailureAt: 1787337018432,
              lastError: QUOTA,
              cooldownUntil: 4102444800000,
            },
          ],
        ],
        thinkingDisabled: [],
        thinkingCounters: [],
      }),
    );

    const registry = new ProviderHealthRegistry();
    registry.load(file);

    expect(registry.isAvailable("kimi"), "yesterday's cooldown did not survive the rename").toBe(
      false,
    );
  });
});
