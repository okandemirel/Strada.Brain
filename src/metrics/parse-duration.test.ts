/**
 * parseDurationToTimestamp — a window the parser cannot read must be reported
 * as unreadable, not turned into "all time" (audited 2026-09-02).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseDurationToTimestamp, parseDurationWindow, DURATION_FORMAT_HINT } from "./parse-duration.js";

describe("parseDurationToTimestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns now minus the duration for the supported units", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
    const now = Date.now();
    expect(parseDurationToTimestamp("7d")).toBe(now - 7 * 86_400_000);
    expect(parseDurationToTimestamp("12h")).toBe(now - 12 * 3_600_000);
    expect(parseDurationToTimestamp("30m")).toBe(now - 30 * 60_000);
    expect(parseDurationToTimestamp("0d")).toBe(now);
  });

  it("returns null — never a timestamp — for a token it cannot parse", () => {
    // Every one of these used to come back as 0, which the CLI turned into an
    // unfiltered all-time query printed under a header naming no window.
    for (const bad of ["1w", "7days", "2weeks", "24hr", "7", "1D", "1 d", "1.5d", "30s", ""]) {
      expect(parseDurationToTimestamp(bad), bad).toBeNull();
    }
  });

  it("returns null for a duration that overflows instead of a negative timestamp that matches every row", () => {
    expect(parseDurationToTimestamp("999999999999d")).toBeNull();
  });

  it("clamps a window that reaches past the epoch instead of calling it unreadable", () => {
    // audited 2026-09-02: `Date.now() - ms < 0` returned null, so a perfectly
    // well-formed 20000d/30000d window came back as 'Unrecognized --since' —
    // the grammar-error message for a token the grammar accepts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));

    const window = parseDurationWindow("30000d");
    expect(window).not.toBeNull();
    expect(window!.since).toBe(0);
    expect(window!.clampedToEpoch).toBe(true);

    // A window that fits is not reported as clamped.
    const fits = parseDurationWindow("7d");
    expect(fits!.since).toBe(Date.now() - 7 * 86_400_000);
    expect(fits!.clampedToEpoch).toBe(false);

    // And the plain accessor gives the epoch, never null and never negative.
    expect(parseDurationToTimestamp("30000d")).toBe(0);
  });

  it("publishes the accepted grammar for error messages", () => {
    expect(DURATION_FORMAT_HINT).toMatch(/\d+d/);
    expect(DURATION_FORMAT_HINT).toMatch(/\d+h/);
    expect(DURATION_FORMAT_HINT).toMatch(/\d+m/);
  });
});
