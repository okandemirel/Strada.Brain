import { describe, expect, it, afterEach } from "vitest";
import { ProviderHealthRegistry } from "./provider-health.js";

const registry = ProviderHealthRegistry.getInstance();
const SEATS = ["seat-a", "seat-b", "seat-c"];
afterEach(() => { for (const s of SEATS) registry.clearProviderState(s); });

/**
 * Measured live 2026-09-04 18:51. The `opencode` seat took a 17-day
 * GoUsageLimitError while pointed at the go endpoint. It was then re-pointed
 * at the zen endpoint with a free model that answers 200 — and stayed benched
 * for 6.6 days on a quota belonging to an endpoint it no longer calls. Health
 * is keyed by seat NAME, and nothing recorded what the bench was earned
 * against.
 */
describe("a bench belongs to the endpoint that earned it", () => {
  const GO = "https://opencode.ai/zen/go/v1|omen-alpha";
  const ZEN = "https://opencode.ai/zen/v1|laguna-s-2.1-free";

  it("stamps an unstamped entry instead of clearing it", () => {
    // We cannot tell whether an old row moved; dropping a genuine quota bench
    // would re-dial a walled account.
    registry.recordQuotaExhausted("seat-a", "17d wall");
    expect(registry.reconcileSeatIdentities(new Map([["seat-a", GO]]))).toEqual([]);
    expect(registry.isAvailable("seat-a")).toBe(false);
  });

  it("keeps the bench when the seat has not moved", () => {
    registry.recordQuotaExhausted("seat-b", "17d wall");
    registry.reconcileSeatIdentities(new Map([["seat-b", GO]])); // stamp
    expect(registry.reconcileSeatIdentities(new Map([["seat-b", GO]]))).toEqual([]);
    expect(registry.isAvailable("seat-b")).toBe(false);
  });

  it("forgets the bench when the seat now calls somewhere else", () => {
    registry.recordQuotaExhausted("seat-c", "17d wall");
    registry.reconcileSeatIdentities(new Map([["seat-c", GO]])); // stamp
    expect(registry.reconcileSeatIdentities(new Map([["seat-c", ZEN]]))).toEqual(["seat-c"]);
    expect(registry.isAvailable("seat-c")).toBe(true);
  });

  it("the stamp survives the next failure", () => {
    registry.recordQuotaExhausted("seat-a", "17d wall");
    registry.reconcileSeatIdentities(new Map([["seat-a", GO]]));
    // Every record* path builds a fresh entry literal; without carrying the
    // identity forward the stamp would be erased and a moved seat would look
    // unchanged forever.
    registry.recordFailure("seat-a", "another failure");
    expect(registry.reconcileSeatIdentities(new Map([["seat-a", ZEN]]))).toEqual(["seat-a"]);
  });
});
