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
  it("returns true for an allowed user ID", () => {
    const auth = new AuthManager([100]);
    expect(auth.isTelegramUserAllowed(100)).toBe(true);
  });

  it("returns false for an unauthorized user", () => {
    const auth = new AuthManager([100]);
    expect(auth.isTelegramUserAllowed(999)).toBe(false);
  });

  it("allows multiple configured IDs", () => {
    const auth = new AuthManager([100, 200, 300]);
    expect(auth.isTelegramUserAllowed(100)).toBe(true);
    expect(auth.isTelegramUserAllowed(200)).toBe(true);
    expect(auth.isTelegramUserAllowed(300)).toBe(true);
  });

  it("returns true when the same ID is checked twice", () => {
    const auth = new AuthManager([42]);
    expect(auth.isTelegramUserAllowed(42)).toBe(true);
    expect(auth.isTelegramUserAllowed(42)).toBe(true);
  });
});
