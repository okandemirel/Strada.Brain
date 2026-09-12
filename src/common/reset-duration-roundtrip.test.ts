import { describe, expect, it } from "vitest";
import { formatResetDuration, parseResetDurationMs } from "./fetch-with-retry.js";

/**
 * Measured live 2026-09-04 17:48: OpenAI answered "usage quota exhausted
 * (resets in ~1h)" and the health registry benched it for EIGHT hours. The
 * structured QuotaExhaustedError had been flattened to a string on the way,
 * retryAfterMs arrived NaN, and the 8h default won — parking the campaign
 * seven hours longer than the provider had asked for. The sentence carried
 * the number the whole time; only the write direction of this pair existed.
 */
describe("reset duration round-trip", () => {
  it("reads back what formatResetDuration wrote", () => {
    for (const ms of [45_000, 5 * 60_000, 3_600_000, 8 * 3_600_000, 3 * 86_400_000]) {
      const sentence = `OpenAI usage quota exhausted (resets in ${formatResetDuration(ms)})`;
      expect(parseResetDurationMs(sentence), `for ${ms}ms`).toBe(ms);
    }
  });

  it("reads the live sentence that caused this", () => {
    expect(
      parseResetDurationMs(
        "OpenAI usage quota exhausted (resets in ~1h): The usage limit has been reached",
      ),
    ).toBe(3_600_000);
    expect(
      parseResetDurationMs("OpenCode (Zen/Go) usage quota exhausted (resets in ~17d): {...}"),
    ).toBe(17 * 86_400_000);
  });

  it("says hours up to two days, so a 38-hour bench does not read as two days", () => {
    // Measured live 2026-09-12 12:41: both OpenCode seats were benched for
    // 38 h 15 m and the message said "~2d" — ten hours more than the provider
    // had asked for, and that sentence is what a person plans around.
    expect(formatResetDuration(38.25 * 3_600_000)).toBe("~38h");
    expect(formatResetDuration(25 * 3_600_000)).toBe("~25h");
    // Past two days, days read better.
    expect(formatResetDuration(3 * 86_400_000)).toBe("~3d");
    // …and both still round-trip.
    for (const ms of [25 * 3_600_000, 38 * 3_600_000, 3 * 86_400_000]) {
      expect(parseResetDurationMs(`quota exhausted (resets in ${formatResetDuration(ms)})`)).toBe(ms);
    }
  });

  it("returns undefined rather than guessing", () => {
    // No clause: the caller must keep its own default, not a zero.
    expect(parseResetDurationMs("OpenAI rate-limited (HTTP 429)")).toBeUndefined();
    expect(parseResetDurationMs("")).toBeUndefined();
    expect(parseResetDurationMs("quota exhausted (resets in soon)")).toBeUndefined();
    expect(parseResetDurationMs("quota exhausted (resets in ~0h)")).toBeUndefined();
  });
});
