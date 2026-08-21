/**
 * A quota that ran out must survive a kill.
 *
 * Health state was written only on a clean shutdown. Measured 2026-08-21: the
 * persistence file never existed, because every run that day ended with a hard
 * kill — so each new process started blind, assigned goals to a provider whose
 * quota had run out hours earlier, and spent its first minute discovering that
 * by failing on it. An eight-hour cooldown that resets every process start is
 * not a cooldown.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderHealthRegistry } from "./provider-health.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function pathIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  dirs.push(dir);
  return join(dir, "provider-health.json");
}

const QUOTA = 'API error 403: {"error":{"message":"You have reached your usage limit"}}';

describe("health that outlives the process", () => {
  it("writes a quota exhaustion the moment it happens, not at shutdown", () => {
    const file = pathIn();
    const registry = new ProviderHealthRegistry();
    registry.load(file); // bootstrap does this with the same path the hook saves to

    registry.recordQuotaExhausted("kimi", QUOTA);

    expect(existsSync(file), "a hard kill here would lose the quota state").toBe(true);
    expect(readFileSync(file, "utf8")).toContain("kimi");
  });

  it("hands the cooldown to the next process", () => {
    const file = pathIn();
    const first = new ProviderHealthRegistry();
    first.load(file);
    first.recordQuotaExhausted("kimi", QUOTA);

    const second = new ProviderHealthRegistry();
    second.load(file);

    expect(second.isAvailable("kimi")).toBe(false);
    expect(second.getStatus("kimi")).toBe("down");
  });

  it("writes nothing when no path was ever given", () => {
    // A registry built without load() — tests, early boot — must not throw or
    // invent a file.
    const registry = new ProviderHealthRegistry();

    expect(() => registry.recordQuotaExhausted("kimi", QUOTA)).not.toThrow();
    expect(registry.isAvailable("kimi")).toBe(false);
  });

  it("leaves a healthy provider available across processes", () => {
    const file = pathIn();
    const first = new ProviderHealthRegistry();
    first.load(file);
    first.recordQuotaExhausted("kimi", QUOTA);

    const second = new ProviderHealthRegistry();
    second.load(file);

    expect(second.isAvailable("opencode")).toBe(true);
  });
});
