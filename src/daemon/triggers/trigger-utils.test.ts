/**
 * trigger-utils Tests
 *
 * Tests the shared utility functions used by trigger implementations.
 */

import { describe, it, expect } from "vitest";
import { floorToMinute } from "./trigger-utils.js";

describe("floorToMinute", () => {
  it("floors a date at the start of a minute to that minute", () => {
    const date = new Date("2026-03-09T09:00:00.000Z");
    const result = floorToMinute(date);
    // 2026-03-09T09:00:00.000Z in ms / 60_000
    expect(result).toBe(Math.floor(date.getTime() / 60_000));
  });

  it("floors a date mid-minute to the start of that minute", () => {
    const date = new Date("2026-03-09T09:00:30.000Z");
    const start = new Date("2026-03-09T09:00:00.000Z");
    expect(floorToMinute(date)).toBe(Math.floor(start.getTime() / 60_000));
  });

  it("floors a date at 59.999 seconds to the same minute", () => {
    const date = new Date("2026-03-09T09:00:59.999Z");
    const start = new Date("2026-03-09T09:00:00.000Z");
    expect(floorToMinute(date)).toBe(Math.floor(start.getTime() / 60_000));
  });

  it("different minutes produce different floor values", () => {
    const a = new Date("2026-03-09T09:00:30.000Z");
    const b = new Date("2026-03-09T09:01:00.000Z");
    expect(floorToMinute(a)).not.toBe(floorToMinute(b));
  });

  it("same minute at different seconds produce the same floor value", () => {
    const a = new Date("2026-03-09T09:05:01.000Z");
    const b = new Date("2026-03-09T09:05:59.000Z");
    expect(floorToMinute(a)).toBe(floorToMinute(b));
  });

  it("returns a number suitable for Map key comparison", () => {
    const date = new Date("2026-03-09T09:00:00.000Z");
    const result = floorToMinute(date);
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("handles epoch zero", () => {
    const date = new Date(0);
    expect(floorToMinute(date)).toBe(0);
  });

  it("handles dates with millisecond precision", () => {
    const a = new Date("2026-03-09T09:00:00.001Z");
    const b = new Date("2026-03-09T09:00:00.999Z");
    expect(floorToMinute(a)).toBe(floorToMinute(b));
  });

  it("consecutive minutes differ by exactly 1", () => {
    const a = new Date("2026-03-09T09:00:00.000Z");
    const b = new Date("2026-03-09T09:01:00.000Z");
    expect(floorToMinute(b) - floorToMinute(a)).toBe(1);
  });
});
