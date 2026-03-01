import { describe, it, expect, vi } from "vitest";
import { AuthManager } from "./auth.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("AuthManager", () => {
  let auth: AuthManager;

  it("allows authorized user", () => {
    auth = new AuthManager([123, 456]);
    expect(auth.isTelegramUserAllowed(123)).toBe(true);
    expect(auth.isTelegramUserAllowed(456)).toBe(true);
  });

  it("denies unauthorized user", () => {
    auth = new AuthManager([123]);
    expect(auth.isTelegramUserAllowed(999)).toBe(false);
  });

  it("denies all when no IDs configured", () => {
    auth = new AuthManager([]);
    expect(auth.isTelegramUserAllowed(1)).toBe(false);
    expect(auth.isTelegramUserAllowed(0)).toBe(false);
  });

  it("handles duplicate IDs gracefully", () => {
    auth = new AuthManager([123, 123, 123]);
    expect(auth.isTelegramUserAllowed(123)).toBe(true);
    expect(auth.isTelegramUserAllowed(456)).toBe(false);
  });

  it("handles large user IDs", () => {
    const largeId = 9876543210;
    auth = new AuthManager([largeId]);
    expect(auth.isTelegramUserAllowed(largeId)).toBe(true);
  });
});
