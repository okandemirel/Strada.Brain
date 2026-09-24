/**
 * PRV-23: the "Provider ready" boot line printed the first six characters of
 * each API key. For keys without a vendor prefix (hex or alphanumeric) that is
 * real secret material in every boot log and log shipper.
 */
import { describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ getLogger: () => logger, getLoggerSafe: () => logger }));

const { buildProviderChain } = await import("./provider-registry.js");

describe("the Provider ready log line", () => {
  it("carries a fingerprint of the key, never its characters", () => {
    const key = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    buildProviderChain(["deepseek"], { deepseek: { apiKey: key } });

    const ready = logger.info.mock.calls.find(([message]) => String(message).startsWith("Provider ready"));
    expect(ready).toBeDefined();
    const logged = JSON.stringify(ready);
    expect(logged).not.toContain(key.slice(0, 4));
    expect((ready![1] as { key: string }).key).toMatch(/^sha256:[0-9a-f]{8}$/u);
  });
});
