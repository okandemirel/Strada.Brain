import { describe, it, expect, vi } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { createMockProvider } from "../../test-helpers.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("FallbackChainProvider", () => {
  it("throws when given empty provider list", () => {
    expect(() => new FallbackChainProvider([])).toThrow(
      "at least one provider"
    );
  });

  it("uses first provider when it succeeds", async () => {
    const p1 = createMockProvider({ text: "from-p1" });
    const p2 = createMockProvider({ text: "from-p2" });
    const chain = new FallbackChainProvider([p1, p2]);

    const result = await chain.chat("sys", [], []);
    expect(result.text).toBe("from-p1");
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).not.toHaveBeenCalled();
  });

  it("falls through to second provider on failure", async () => {
    const p1 = createMockProvider();
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API down"));
    const p2 = createMockProvider({ text: "fallback-response" });

    const chain = new FallbackChainProvider([p1, p2]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("fallback-response");
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
  });

  it("tries all providers and throws when all fail", async () => {
    const p1 = createMockProvider();
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("P1 down"));
    const p2 = createMockProvider();
    (p2.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("P2 down"));
    const p3 = createMockProvider();
    (p3.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("P3 down"));

    const chain = new FallbackChainProvider([p1, p2, p3]);
    await expect(chain.chat("sys", [], [])).rejects.toThrow("P3 down");

    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
    expect(p3.chat).toHaveBeenCalledTimes(1);
  });

  it("names itself with provider chain", () => {
    const p1 = createMockProvider();
    const p2 = createMockProvider();
    const chain = new FallbackChainProvider([p1, p2]);

    expect(chain.name).toBe("chain(mock-provider→mock-provider)");
  });

  it("passes all arguments to providers", async () => {
    const p1 = createMockProvider();
    const chain = new FallbackChainProvider([p1]);

    const msgs = [{ role: "user" as const, content: "test" }];
    const tools = [{ name: "t", description: "d", input_schema: {} }];

    await chain.chat("system-prompt", msgs, tools);

    expect(p1.chat).toHaveBeenCalledWith("system-prompt", msgs, tools);
  });
});
