/**
 * trigger-utils Tests
 *
 * Tests the shared utility functions used by trigger implementations.
 */

import { describe, it, expect } from "vitest";
import { Cron } from "croner";
import { floorToMinute, isOccurrenceDue } from "./trigger-utils.js";

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

describe("isOccurrenceDue", () => {
  const at = (iso: string) => new Date(iso);
  const daily9 = () => new Cron("0 9 * * *", { timezone: "UTC", paused: true });

  it("finds an occurrence between two looks whatever second the ticks land on", () => {
    const cron = daily9();
    expect(isOccurrenceDue(cron, at("2026-03-09T08:58:17Z"), at("2026-03-09T08:59:17Z"))).toBe(false);
    expect(isOccurrenceDue(cron, at("2026-03-09T08:59:17Z"), at("2026-03-09T09:00:17Z"))).toBe(true);
    expect(isOccurrenceDue(cron, at("2026-03-09T09:00:17Z"), at("2026-03-09T09:01:17Z"))).toBe(false);
  });

  it("treats the previous look as exclusive, so one occurrence is due exactly once", () => {
    const cron = daily9();
    expect(isOccurrenceDue(cron, at("2026-03-09T09:00:00.400Z"), at("2026-03-09T09:00:30Z"))).toBe(false);
  });

  it("looks back no further than the window", () => {
    const cron = daily9();
    const lastChecked = at("2026-03-01T00:00:00Z");
    expect(isOccurrenceDue(cron, lastChecked, at("2026-03-09T12:00:00Z"), 6 * 60 * 60_000)).toBe(true);
    expect(isOccurrenceDue(cron, lastChecked, at("2026-03-09T16:00:00Z"), 6 * 60 * 60_000)).toBe(false);
  });
});
