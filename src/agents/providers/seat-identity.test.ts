import { describe, expect, it, afterEach } from "vitest";
import { ProviderHealthRegistry } from "./provider-health.js";

const registry = ProviderHealthRegistry.getInstance();
const SEATS = ["seat-a", "seat-b", "seat-c", "seat-k", "seat-u"];
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

describe("a credential bench belongs to the key that earned it (measured 2026-09-10: a rotated key inherited an 8-hour 401 bench)", () => {
  const GO_URL = "https://opencode.ai/zen/go/v1";

  it("the identity changes with the key and never carries key material", () => {
    const a = ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-OLDKEY-0123456789");
    const b = ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-NEWKEY-0123456789");
    expect(a).not.toBe(b);
    expect(a.startsWith(`${GO_URL}|deepseek-flash|`)).toBe(true);
    expect(a).not.toContain("OLDKEY");
    expect(ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-OLDKEY-0123456789")).toBe(a);
  });

  it("a rotated key clears the bench the old key earned", () => {
    const old = ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-old");
    registry.reconcileSeatIdentities(new Map([["seat-k", old]])); // stamp
    registry.recordCredentialRejected("seat-k", "401 Invalid API key");
    expect(registry.isAvailable("seat-k")).toBe(false);
    const rotated = ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-new");
    expect(registry.reconcileSeatIdentities(new Map([["seat-k", rotated]]))).toEqual(["seat-k"]);
    expect(registry.isAvailable("seat-k")).toBe(true);
  });

  it("a stamp from before the fingerprint existed is upgraded, not cleared, when endpoint and model still match", () => {
    registry.reconcileSeatIdentities(new Map([["seat-u", `${GO_URL}|deepseek-flash`]])); // old two-part stamp
    registry.recordQuotaExhausted("seat-u", "quota");
    expect(registry.isAvailable("seat-u")).toBe(false);
    const withKey = ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-any");
    expect(registry.reconcileSeatIdentities(new Map([["seat-u", withKey]]))).toEqual([]);
    expect(registry.isAvailable("seat-u")).toBe(false);
    // and once upgraded, a later key rotation IS a change
    const rotated = ProviderHealthRegistry.seatIdentity(GO_URL, "deepseek-flash", "sk-other");
    expect(registry.reconcileSeatIdentities(new Map([["seat-u", rotated]]))).toEqual(["seat-u"]);
  });
});


describe("the health file survives a kill mid-write and names itself when unreadable (audited 2026-09-10)", () => {
  it("saves atomically: no partial file is ever at the path, and a corrupt file is reported, not swallowed", async () => {
    const { mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "health-"));
    try {
      const path = join(dir, "provider-health.json");
      registry.load(path);
      registry.recordQuotaExhausted("seat-atomic", "quota");
      expect(readdirSync(dir)).toEqual(["provider-health.json"]); // no .tmp left behind
      expect(JSON.parse(readFileSync(path, "utf8")).entries.some(([n]: [string]) => n === "seat-atomic")).toBe(true);
      writeFileSync(path, "{\"entries\": [[\"x\", {");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { getLoggerSafe } = await import("../../utils/logger.js");
      const logWarn = vi.spyOn(getLoggerSafe(), "warn").mockImplementation((() => undefined) as never);
      registry.load(path);
      expect(logWarn.mock.calls.some(([msg]) => String(msg).includes("Provider health file could not be read"))).toBe(true);
      logWarn.mockRestore();
      warn.mockRestore();
    } finally {
      registry.clearProviderState("seat-atomic");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
