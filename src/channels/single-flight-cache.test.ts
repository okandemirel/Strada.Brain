import { describe, expect, it, vi } from "vitest";
import { SingleFlightCache } from "./single-flight-cache.js";

describe("SingleFlightCache (CHN-8)", () => {
  it("shares one in-flight run, reuses it within the TTL, and runs again after it", async () => {
    let now = 0;
    const cache = new SingleFlightCache<number>(1_000, () => now);
    const produce = vi.fn(async () => produce.mock.calls.length);

    const [a, b] = await Promise.all([cache.run(produce), cache.run(produce)]);
    expect([a, b]).toEqual([1, 1]);
    now = 999;
    expect(await cache.run(produce)).toBe(1);
    now = 1_000;
    expect(await cache.run(produce)).toBe(2);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const cache = new SingleFlightCache<string>(60_000);
    await expect(cache.run(async () => { throw new Error("locked"); })).rejects.toThrow("locked");
    await expect(cache.run(async () => "ok")).resolves.toBe("ok");
  });
});
